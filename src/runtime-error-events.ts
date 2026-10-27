import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { assertPrivate, defaultRuntimeErrorStorePath, ensurePrivateDirectory, makeFilePrivate } from "./platform/state.js";
import type { FailureAssessment, RuntimeErrorSeverity } from "./runtime-error-assessment.js";
import type { RuntimeErrorOptions } from "./runtime-error-store.js";
import { runtimeFailureSchema } from "./runtime-failure.js";

export const runtimeOperationSchema = z.enum(["unknown", "setup", "browser_start", "browser_show", "grok_browser_start", "grok_browser_show", "models", "doctor", "chat", "image", "consult", "sessions", "close", "grok-modes", "grok-doctor", "grok-chat", "grok-consult", "grok-sessions", "grok-close", "chatgpt_models", "chatgpt_chat", "chatgpt_image", "chatgpt_close", "diagnostics", "grok_modes", "grok_chat", "grok_consult", "grok_sessions", "grok_diagnostics", "grok_close"]);
export type RuntimeOperation = z.output<typeof runtimeOperationSchema>;
export const cdpFailureStageSchema = z.enum(["target_discovery", "websocket_connect", "protocol_call", "transport_closed", "browser_display", "browser_preparation", "unknown"]);
export const cdpFailureReasonSchema = z.enum(["connection_failed", "http_error", "invalid_response", "target_missing", "invalid_endpoint", "timeout", "closed", "transport_error", "display_failed", "unknown"]);

export function runtimeOperationFromCli(argv: readonly string[]): RuntimeOperation {
  const provider = argv.indexOf("--provider");
  const name = argv[0] === "browser" ? `${provider >= 0 && argv[provider + 1] === "grok" ? "grok_" : ""}browser_${argv[1]}` : argv[0];
  const parsed = runtimeOperationSchema.safeParse(name);
  return parsed.success ? parsed.data : "unknown";
}

export const runtimeErrorContextSchema = z.object({
  source: z.enum(["setup_live_check", "public_operation"]),
  // At most one distinct failure per setup client; keep 128 events within the read limit.
  failures: z.array(runtimeFailureSchema).max(4),
  operation: runtimeOperationSchema.optional(),
  entrypoint: z.enum(["cli", "mcp"]).optional(),
  cdp: z.object({
    stage: cdpFailureStageSchema,
    reason: cdpFailureReasonSchema,
    target_missing: z.boolean().nullable(), unreachable: z.boolean().nullable(), before_submission: z.boolean().nullable(),
  }).strict().optional(),
}).strict();
export type RuntimeErrorContext = z.output<typeof runtimeErrorContextSchema>;

const eventSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u), observed_at: z.iso.datetime(),
  assessment: z.object({
    cause: z.enum(["environment", "application", "unknown"]),
    impact: z.enum(["unknown", "operation_failed", "data_loss", "duplicate_execution", "service_stopped"]),
    handling: z.enum(["handled", "defective", "unknown"]),
    recovery: z.enum(["safe", "status_first", "unavailable", "unknown"]), cancelled: z.boolean(),
  }).strict(),
  decision: z.object({ register: z.boolean(), severity: z.enum(["fatal", "high", "warn", "info"]).nullable() }).strict(),
  context: runtimeErrorContextSchema.optional(),
  product_version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
const eventsSchema = z.array(eventSchema).max(128);

/** Bounded private diagnostics, separate from cumulative repair registrations. */
export function readRuntimeErrorEvents(options: RuntimeErrorOptions = {}) {
  const path = `${options.storePath ?? defaultRuntimeErrorStorePath(options.env)}.events`;
  return [...readEventFile(path, options), ...readEventFile(`${path}.v2`, options)]
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at)).slice(-128);
}

function readEventFile(path: string, options: RuntimeErrorOptions) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error("unsafe events");
    assertPrivate(path, false, options.env, options.windowsAcl);
    return eventsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function recordRuntimeErrorEvent(code: string, assessment: FailureAssessment,
  decision: { register: boolean; severity: RuntimeErrorSeverity | null }, options: RuntimeErrorOptions & { fingerprint?: string }) {
  // Old live clients retain their strict .events reader and writer.
  const path = `${options.storePath ?? defaultRuntimeErrorStorePath(options.env)}.events.v2`;
  ensurePrivateDirectory(dirname(path), options.env, options.windowsAcl);
  const lock = `${path}.lock`;
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(lock, "wx", 0o600);
    const context = runtimeErrorContextSchema.safeParse(options.context);
    const event = eventSchema.parse({ code, observed_at: options.now ?? new Date().toISOString(), assessment, decision,
      ...(options.version ? { product_version: options.version } : {}), ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(context.success ? { context: context.data } : {}) });
    const events = [...readEventFile(path, options).slice(-127), event];
    writeFileSync(temporary, `${JSON.stringify(events)}\n`, { mode: 0o600, flag: "wx" });
    makeFilePrivate(temporary, options.env, options.windowsAcl);
    renameSync(temporary, path);
    makeFilePrivate(path, options.env, options.windowsAcl);
  } finally {
    rmSync(temporary, { force: true });
    if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); }
  }
}
