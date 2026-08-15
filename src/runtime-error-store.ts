import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { homedir, arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { packageVersion } from "./version.js";

export const runtimeErrorStoreSchema = "gpt-connector.runtime-errors.v1" as const;
export const runtimeErrorStateSchemaVersion = "1.0" as const;
export const runtimeErrorStoreDiagnostic = "[gpt-connector:runtime-errors] store_unavailable\n";
const snapshotLimit = 256;

const definitions = {
  CDP_UNAVAILABLE: { component: "cdp", severity: "high", template: "GPT Connector CDP connection failed" },
  AUTH_REQUIRED: { component: "auth", severity: "high", template: "GPT Connector ChatGPT authentication is required" },
  RUNTIME_DRIFT: { component: "runtime_bridge", severity: "high", template: "GPT Connector runtime bridge contract drifted" },
  MODEL_RESOLUTION_MISMATCH: { component: "model_selection", severity: "high", template: "GPT Connector resolved a different model or effort" },
  UPLOAD_FAILED: { component: "attachment", severity: "high", template: "GPT Connector attachment upload failed" },
  UPLOAD_TIMEOUT: { component: "attachment", severity: "high", template: "GPT Connector attachment upload timed out" },
  ATTACHMENT_READBACK_FAILED: { component: "attachment", severity: "high", template: "GPT Connector attachment read-back failed" },
  IMAGE_NOT_GENERATED: { component: "image_generation", severity: "high", template: "GPT Connector ChatGPT image was not generated" },
  IMAGE_READBACK_FAILED: { component: "image_generation", severity: "high", template: "GPT Connector generated image read-back failed" },
  IMAGE_DOWNLOAD_FAILED: { component: "image_download", severity: "high", template: "GPT Connector generated image download failed" },
  IMAGE_OUTPUT_FAILED: { component: "image_output", severity: "high", template: "GPT Connector generated image output failed" },
  IMAGE_CLEANUP_FAILED: { component: "image_cleanup", severity: "high", template: "GPT Connector generated image cleanup failed" },
  CHAT_FAILED: { component: "chat", severity: "high", template: "GPT Connector ChatGPT chat operation failed" },
  STREAM_INCOMPLETE: { component: "stream", severity: "high", template: "GPT Connector ChatGPT stream was incomplete" },
  ARCHIVE_FAILED: { component: "archive", severity: "high", template: "GPT Connector conversation archive failed" },
  JOB_RECOVERY_UNAVAILABLE: { component: "consult_job_store", severity: "high", template: "GPT Connector consult job state persistence failed" },
} as const;

export type RuntimeErrorCode = keyof typeof definitions;
type Status = "open" | "resolved";
interface RecordEntry {
  product: "gpt-connector";
  product_version: string;
  component: string;
  error_code: RuntimeErrorCode;
  message_template: string;
  severity: "high";
  fingerprint: string;
  count: number;
  first_seen: string;
  last_seen: string;
  state_schema_version: "1.0";
  os: string;
  arch: string;
  status: Status;
  resolved_at: string | null;
  reason_code: "manual" | "recovered" | null;
  sequence: number;
}
interface Store { schema: typeof runtimeErrorStoreSchema; next_sequence: number; acknowledged_through: number; records: RecordEntry[]; }
export interface RuntimeErrorOptions { readonly env?: NodeJS.ProcessEnv; readonly configPath?: string; readonly storePath?: string; readonly version?: string; readonly now?: string; readonly platform?: string; readonly arch?: string; readonly windowsAcl?: (path: string, directory: boolean) => void; }

export function defaultFactoryReporterConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return isWindows(env)
    ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "dotagents", "factory-reporter", "config.json")
    : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "dotagents", "factory-reporter.json");
}

export function defaultRuntimeErrorStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return isWindows(env)
    ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "gpt-connector", "runtime-errors.json")
    : join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "gpt-connector", "runtime-errors.json");
}

export function isRuntimeErrorCollectionEnabled(options: Pick<RuntimeErrorOptions, "env" | "configPath"> = {}): boolean {
  try {
    const path = options.configPath ?? defaultFactoryReporterConfigPath(options.env);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return isCanonicalConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch { return false; }
}

export function observeRuntimeError(input: { readonly code: RuntimeErrorCode; readonly now?: string }, options: RuntimeErrorOptions = {}) {
  assertExactKeys(input, ["code", "now"], "固定 code と時刻だけ");
  if (!(input.code in definitions)) throw new TypeError("未登録の runtime error code です");
  if (!isRuntimeErrorCollectionEnabled(options)) return { status: "disabled" as const };
  return mutate(options, (store) => {
    const definition = definitions[input.code];
    const fingerprint = fingerprintFor(input.code);
    const now = timestamp(input.now);
    const sequence = store.next_sequence++;
    const existing = store.records.find((record) => record.fingerprint === fingerprint);
    if (existing) {
      existing.product_version = safeVersion(options.version);
      existing.count += 1; existing.last_seen = now; existing.status = "open";
      existing.resolved_at = null; existing.reason_code = null; existing.sequence = sequence;
    } else store.records.push({ product: "gpt-connector", product_version: safeVersion(options.version), component: definition.component,
      error_code: input.code, message_template: definition.template, severity: definition.severity, fingerprint, count: 1,
      first_seen: now, last_seen: now, state_schema_version: runtimeErrorStateSchemaVersion,
      os: safePlatform(options.platform), arch: safeArch(options.arch), status: "open", resolved_at: null, reason_code: null, sequence });
    return { status: "recorded" as const, fingerprint, sequence };
  });
}

export function resolveRuntimeError(fingerprint: string, options: RuntimeErrorOptions & { readonly reasonCode?: "manual" | "recovered" } = {}) {
  assertFingerprint(fingerprint); return mutateExistingOrEnabled(options, (store) => updateStatus(store, fingerprint, "resolved", options));
}
export function reopenRuntimeError(fingerprint: string, options: RuntimeErrorOptions = {}) {
  assertFingerprint(fingerprint); return mutateExistingOrEnabled(options, (store) => updateStatus(store, fingerprint, "open", options));
}
export function acknowledgeRuntimeErrors(cursor: number, options: RuntimeErrorOptions = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("cursor は非負の整数が必要です");
  return mutateExistingOrEnabled(options, (store) => { if (cursor >= store.next_sequence) throw new RangeError("cursor がstore high watermarkを超えています"); store.acknowledged_through = Math.max(store.acknowledged_through, cursor); return { status: "acknowledged" as const, acknowledgedThrough: store.acknowledged_through }; }, { status: "disabled" as const, acknowledgedThrough: 0 } as never);
}
export function compactRuntimeErrors(options: RuntimeErrorOptions & { readonly retentionMs?: number } = {}) {
  const retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new TypeError("retentionMs は非負の整数が必要です");
  return mutateExistingOrEnabled(options, (store) => { const cutoff = Date.parse(timestamp(options.now)) - retentionMs; const before = store.records.length; store.records = store.records.filter((record) => !(record.status === "resolved" && record.sequence <= store.acknowledged_through && Date.parse(record.last_seen) <= cutoff)); return { status: "compacted" as const, removed: before - store.records.length }; }, { status: "disabled" as const, removed: 0 } as never);
}
export function readRuntimeErrorSnapshot(options: RuntimeErrorOptions & { readonly afterCursor?: number; readonly limit?: number } = {}) {
  const after = options.afterCursor ?? 0; const limit = options.limit ?? snapshotLimit;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > snapshotLimit) throw new TypeError("snapshot cursor または limit が不正です");
  const enabled = isRuntimeErrorCollectionEnabled(options); const store = enabled ? readStore(options, true) : emptyStore();
  const candidates = store.records.filter((record) => record.sequence > after).sort((a, b) => a.sequence - b.sequence); const selected = candidates.slice(0, limit);
  return { schema: runtimeErrorStoreSchema, product: "gpt-connector", version: packageVersion, state_schema_version: runtimeErrorStateSchemaVersion,
    cursor: { high_watermark: store.next_sequence - 1, acknowledged_through: store.acknowledged_through, next: selected.at(-1)?.sequence ?? after },
    runtime_errors: selected.filter((r) => r.status === "open").map(publicRecord), resolutions: selected.filter((r) => r.status === "resolved").map((r) => ({ fingerprint: r.fingerprint, resolved_at: r.resolved_at, reason_code: r.reason_code })),
    diagnostics: { collection: enabled ? "enabled" : "disabled", status: enabled ? "ready" : "not_applicable", total_count: store.records.length, pending_count: store.records.filter((r) => r.sequence > store.acknowledged_through).length, truncated: candidates.length > selected.length } };
}
export function getRuntimeErrorDiagnostics(options: RuntimeErrorOptions = {}) {
  const enabled = isRuntimeErrorCollectionEnabled(options); if (!enabled) return diagnostics("disabled", "not_applicable", emptyStore());
  const path = options.storePath ?? defaultRuntimeErrorStorePath(options.env);
  if (runtimeErrorLockPresent(`${path}.lock`)) return diagnostics("enabled", "unavailable", emptyStore());
  try { return diagnostics("enabled", "ready", readStore(options, true)); } catch { return diagnostics("enabled", "unavailable", emptyStore()); }
}

/** Adapter-only telemetry hook. It accepts only registered public failure codes and never throws. */
export function recordRuntimeErrorBestEffort(code: string): "recorded" | "disabled" | "store_unavailable" {
  if (!(code in definitions)) return "disabled";
  try { return observeRuntimeError({ code: code as RuntimeErrorCode }).status; } catch { return "store_unavailable"; }
}

function updateStatus(store: Store, fingerprint: string, status: Status, options: RuntimeErrorOptions & { readonly reasonCode?: "manual" | "recovered" }) {
  const record = store.records.find((candidate) => candidate.fingerprint === fingerprint); if (!record) return { status: "not_found" as const };
  if (record.status === status) return { status, sequence: record.sequence };
  record.status = status; record.sequence = store.next_sequence++;
  record.resolved_at = status === "resolved" ? timestamp(options.now) : null; record.reason_code = status === "resolved" ? (options.reasonCode ?? "manual") : null;
  return { status, sequence: record.sequence };
}
function publicRecord(record: RecordEntry) { return { error_code: record.error_code, component: record.component, status: record.status, severity: record.severity, fingerprint: record.fingerprint, message_template: record.message_template, occurrence_count: record.count, first_seen: record.first_seen, last_seen: record.last_seen, state_schema_version: record.state_schema_version }; }
function diagnostics(collection: "enabled" | "disabled", status: "ready" | "not_applicable" | "unavailable", store: Store) { return { schema: runtimeErrorStoreSchema, collection, status, high_watermark: store.next_sequence - 1, acknowledged_through: store.acknowledged_through, total_count: store.records.length, open_count: store.records.filter((r) => r.status === "open").length, pending_count: store.records.filter((r) => r.sequence > store.acknowledged_through).length }; }
function mutate<T>(options: RuntimeErrorOptions, operation: (store: Store) => T, create = true): T { const path = options.storePath ?? defaultRuntimeErrorStorePath(options.env); if (create) ensurePrivateDirectory(dirname(path), options.env, options.windowsAcl); else assertPrivate(dirname(path), true, options.env, options.windowsAcl); const lock = `${path}.lock`; let fd: number | undefined; try { try { fd = fs.openSync(lock, "wx", 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !recoverStaleLock(lock)) throw error; fd = fs.openSync(lock, "wx", 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), "utf8"); } const store = readStore(options, create); const result = operation(store); writeStore(store, options); return result; } finally { if (fd !== undefined) { fs.closeSync(fd); rmSync(lock, { force: true }); } } }
function runtimeErrorLockPresent(lock: string): boolean {
  try { lstatSync(lock); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}
function recoverStaleLock(lock: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(lock, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const info = fs.fstatSync(fd);
    if (!info.isFile() || Date.now() - info.mtimeMs < 5 * 60_000) return false;
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) < 1) return false;
    try { process.kill(parsed.pid as number, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    const current = lstatSync(lock);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== info.dev || current.ino !== info.ino
      || current.mtimeMs !== info.mtimeMs || current.size !== info.size) return false;
    fs.closeSync(fd); fd = undefined;
    rmSync(lock);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function mutateExistingOrEnabled<T>(options: RuntimeErrorOptions, operation: (store: Store) => T, disabled?: T): T {
  if (isRuntimeErrorCollectionEnabled(options)) return mutate(options, operation);
  const path = options.storePath ?? defaultRuntimeErrorStorePath(options.env);
  try { lstatSync(path); return mutate(options, operation, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && disabled !== undefined) return disabled; throw error; }
}
function readStore(options: RuntimeErrorOptions, missingEmpty: boolean): Store { const path = options.storePath ?? defaultRuntimeErrorStorePath(options.env); try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe store"); assertPrivate(path, false, options.env, options.windowsAcl); const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); validateStore(parsed); return parsed; } catch (error) { if (missingEmpty && (error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore(); throw error; } }
function writeStore(store: Store, options: RuntimeErrorOptions): void { validateStore(store); const path = options.storePath ?? defaultRuntimeErrorStorePath(options.env); const directory = dirname(path); ensurePrivateDirectory(directory, options.env, options.windowsAcl); const temporary = join(directory, `.runtime-errors.${process.pid}.${randomBytes(6).toString("hex")}.tmp`); try { writeFileSync(temporary, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); if (!isWindows(options.env)) chmodSync(temporary, 0o600); else applyWindowsAcl(temporary, false, options.windowsAcl); renameSync(temporary, path); if (!isWindows(options.env)) chmodSync(path, 0o600); assertPrivate(path, false, options.env, options.windowsAcl); } finally { rmSync(temporary, { force: true }); } }
function ensurePrivateDirectory(directory: string, env?: NodeJS.ProcessEnv, windowsAcl?: RuntimeErrorOptions["windowsAcl"]): void { mkdirSync(directory, { recursive: true, mode: 0o700 }); const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe store directory"); if (!isWindows(env)) chmodSync(directory, 0o700); else applyWindowsAcl(directory, true, windowsAcl); assertPrivate(directory, true, env, windowsAcl); }
function assertPrivate(path: string, directory: boolean, env?: NodeJS.ProcessEnv, windowsAcl?: RuntimeErrorOptions["windowsAcl"]): void { const info = statSync(path); if (!isWindows(env) && (info.mode & 0o077) !== 0) throw new Error(directory ? "directory permissions" : "file permissions"); if (isWindows(env)) applyWindowsAcl(path, directory, windowsAcl); }
function applyWindowsAcl(path: string, directory: boolean, injected?: RuntimeErrorOptions["windowsAcl"]): void {
  if (injected) return injected(path, directory);
  const user = execFileSync("whoami", [], { encoding: "utf8", windowsHide: true }).trim();
  if (!user) throw new Error("windows acl user");
  const grant = `${user}:${directory ? "(OI)(CI)F" : "F"}`;
  execFileSync("icacls", [path, "/inheritance:r", "/grant:r", grant, "/remove:g", "Users", "Everyone", "Authenticated Users"], { encoding: "utf8", windowsHide: true });
  const verified = execFileSync("icacls", [path], { encoding: "utf8", windowsHide: true });
  if (!verified.toLowerCase().includes(user.toLowerCase()) || /Everyone|Authenticated Users/iu.test(verified)) throw new Error("windows acl verification");
}
function emptyStore(): Store { return { schema: runtimeErrorStoreSchema, next_sequence: 1, acknowledged_through: 0, records: [] }; }
function validateStore(value: unknown): asserts value is Store {
  if (!plain(value) || !exactKeys(value, ["schema", "next_sequence", "acknowledged_through", "records"])) throw new Error("store schema");
  const store = value as Partial<Store>; const next = store.next_sequence; const acknowledged = store.acknowledged_through;
  if (store.schema !== runtimeErrorStoreSchema || typeof next !== "number" || !Number.isSafeInteger(next) || next < 1 || typeof acknowledged !== "number" || !Number.isSafeInteger(acknowledged) || acknowledged < 0 || acknowledged >= next || !Array.isArray(store.records)) throw new Error("store schema");
  const checked = value as unknown as Store;
  const fingerprints = new Set<string>(); const sequences = new Set<number>();
  for (const value of checked.records) {
    if (!plain(value) || !exactKeys(value, ["product", "product_version", "component", "error_code", "message_template", "severity", "fingerprint", "count", "first_seen", "last_seen", "state_schema_version", "os", "arch", "status", "resolved_at", "reason_code", "sequence"])) throw new Error("store record");
    const entry = value as RecordEntry; const definition = definitions[entry.error_code];
    const first = canonicalTimestamp(entry.first_seen); const last = canonicalTimestamp(entry.last_seen);
    if (entry.product !== "gpt-connector" || definition === undefined || entry.product_version !== safeVersion(entry.product_version) || entry.component !== definition.component || entry.message_template !== definition.template || entry.severity !== definition.severity || entry.fingerprint !== fingerprintFor(entry.error_code) || !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.state_schema_version !== runtimeErrorStateSchemaVersion || !["darwin", "linux", "win32", "unknown"].includes(entry.os) || !/^[a-z0-9_]+$/u.test(entry.arch) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence >= checked.next_sequence || first > last || fingerprints.has(entry.fingerprint) || sequences.has(entry.sequence)) throw new Error("store record");
    if ((entry.status === "open" && (entry.resolved_at !== null || entry.reason_code !== null)) || (entry.status === "resolved" && (entry.resolved_at === null || !["manual", "recovered"].includes(entry.reason_code ?? "") || canonicalTimestamp(entry.resolved_at) < last)) || (entry.status !== "open" && entry.status !== "resolved")) throw new Error("store record");
    fingerprints.add(entry.fingerprint); sequences.add(entry.sequence);
  }
}
function isCanonicalConfig(value: unknown): boolean { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const c = value as Record<string, unknown>; const keys = Object.keys(c); if (keys.length !== 4 || !["schema_version", "host", "collection", "reporting"].every((key) => keys.includes(key)) || c.schema_version !== "1.0") return false; const host = c.host as Record<string, unknown>; const collection = c.collection as Record<string, unknown>; const reporting = c.reporting as Record<string, unknown>; return plain(host) && Object.keys(host).length === 2 && typeof host.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(host.id) && ["server", "mac", "wsl", "windows-native"].includes(String(host.profile)) && plain(collection) && Object.keys(collection).length === 1 && collection.enabled === true && plain(reporting) && typeof reporting.enabled === "boolean"; }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => actual.includes(key)); }
function fingerprintFor(code: RuntimeErrorCode): string { const d = definitions[code]; return createHash("sha256").update(["gpt-connector", d.component, code, d.template].join("\0")).digest("hex"); }
function timestamp(value?: string): string { const date = new Date(value ?? Date.now()); if (Number.isNaN(date.valueOf())) throw new TypeError("時刻が不正です"); return date.toISOString(); }
function canonicalTimestamp(value: unknown): number { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(Date.parse(value))) throw new Error("timestamp"); return Date.parse(value); }
function safeVersion(value?: string): string { return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value) ? value : packageVersion; }
function safePlatform(value?: string): string { return ["darwin", "linux", "win32"].includes(value ?? hostPlatform()) ? (value ?? hostPlatform()) : "unknown"; }
function safeArch(value?: string): string { return /^[a-z0-9_]+$/u.test(value ?? hostArch()) ? (value ?? hostArch()) : "unknown"; }
function assertFingerprint(value: string): void { if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError("fingerprint が不正です"); }
function assertExactKeys(value: object, keys: readonly string[], message: string): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(message); }
function isWindows(env?: NodeJS.ProcessEnv): boolean { return env?.OS === "Windows_NT" || hostPlatform() === "win32"; }
