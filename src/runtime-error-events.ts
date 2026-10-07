import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { assertPrivate, defaultRuntimeErrorStorePath, ensurePrivateDirectory, makeFilePrivate } from "./platform/state.js";
import type { FailureAssessment, RuntimeErrorSeverity } from "./runtime-error-assessment.js";
import type { RuntimeErrorOptions } from "./runtime-error-store.js";

const eventSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u), observed_at: z.iso.datetime(),
  assessment: z.object({
    cause: z.enum(["environment", "application", "unknown"]),
    impact: z.enum(["unknown", "operation_failed", "data_loss", "duplicate_execution", "service_stopped"]),
    handling: z.enum(["handled", "defective", "unknown"]),
    recovery: z.enum(["safe", "status_first", "unavailable", "unknown"]), cancelled: z.boolean(),
  }).strict(),
  decision: z.object({ register: z.boolean(), severity: z.enum(["fatal", "high", "warn", "info"]).nullable() }).strict(),
}).strict();
const eventsSchema = z.array(eventSchema).max(128);

/** Bounded private diagnostics, separate from cumulative repair registrations. */
export function readRuntimeErrorEvents(options: RuntimeErrorOptions = {}) {
  const path = `${options.storePath ?? defaultRuntimeErrorStorePath(options.env)}.events`;
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
  decision: { register: boolean; severity: RuntimeErrorSeverity | null }, options: RuntimeErrorOptions) {
  const path = `${options.storePath ?? defaultRuntimeErrorStorePath(options.env)}.events`;
  ensurePrivateDirectory(dirname(path), options.env, options.windowsAcl);
  const lock = `${path}.lock`;
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(lock, "wx", 0o600);
    const event = eventSchema.parse({ code, observed_at: options.now ?? new Date().toISOString(), assessment, decision });
    const events = [...readRuntimeErrorEvents(options).slice(-127), event];
    writeFileSync(temporary, `${JSON.stringify(events)}\n`, { mode: 0o600, flag: "wx" });
    makeFilePrivate(temporary, options.env, options.windowsAcl);
    renameSync(temporary, path);
    makeFilePrivate(path, options.env, options.windowsAcl);
  } finally {
    rmSync(temporary, { force: true });
    if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); }
  }
}
