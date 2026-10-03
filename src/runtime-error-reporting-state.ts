// 実行時エラーを製品自身がBugHubへ送るかどうかの設定と、送信の状態。既定は無効で、端末で明示した時だけ有効になる。
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultRuntimeErrorReportingPath, ensurePrivateDirectory, makeFilePrivate, type WindowsAclApplier } from "./platform/state.js";

export const runtimeErrorReportingSchema = "gpt-connector.runtime-error-reporting.v1" as const;

export interface RuntimeErrorReportingState {
  schema: typeof runtimeErrorReportingSchema;
  enabled: boolean;
  last_attempt_at: string | null;
  last_result: string | null;
  // 再送しても通らない拒否（認証・製品の不一致・形の不正）。合鍵か版が変わるまで自動では送らない。
  blocked: { reason: string; key_id: string; version: string } | null;
}

export interface RuntimeErrorReportingPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly storePath?: string;
  readonly reportingPath?: string;
  readonly windowsAcl?: WindowsAclApplier;
}

export function runtimeErrorReportingPath(options: RuntimeErrorReportingPathOptions = {}): string {
  if (options.reportingPath) return options.reportingPath;
  return options.storePath ? join(dirname(options.storePath), "runtime-error-reporting.json") : defaultRuntimeErrorReportingPath(options.env);
}

/** 読めない・形が違う設定は無効として扱う。壊れた設定で送信を始めない。 */
export function readRuntimeErrorReportingState(options: RuntimeErrorReportingPathOptions = {}): RuntimeErrorReportingState {
  try {
    const path = runtimeErrorReportingPath(options);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return disabledState();
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isState(parsed) ? parsed : disabledState();
  } catch { return disabledState(); }
}

export function isRuntimeErrorReportingEnabled(options: RuntimeErrorReportingPathOptions = {}): boolean {
  return readRuntimeErrorReportingState(options).enabled;
}

export function writeRuntimeErrorReportingState(state: RuntimeErrorReportingState, options: RuntimeErrorReportingPathOptions = {}): void {
  const path = runtimeErrorReportingPath(options);
  const directory = dirname(path);
  ensurePrivateDirectory(directory, options.env, options.windowsAcl);
  const temporary = join(directory, `.runtime-error-reporting.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    makeFilePrivate(temporary, options.env, options.windowsAcl);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function disabledState(): RuntimeErrorReportingState {
  return { schema: runtimeErrorReportingSchema, enabled: false, last_attempt_at: null, last_result: null, blocked: null };
}

function isState(value: unknown): value is RuntimeErrorReportingState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state);
  if (keys.length !== 5 || !["schema", "enabled", "last_attempt_at", "last_result", "blocked"].every((key) => keys.includes(key))) return false;
  if (state.schema !== runtimeErrorReportingSchema || typeof state.enabled !== "boolean") return false;
  if (state.last_attempt_at !== null && (typeof state.last_attempt_at !== "string" || Number.isNaN(Date.parse(state.last_attempt_at)))) return false;
  if (state.last_result !== null && typeof state.last_result !== "string") return false;
  if (state.blocked === null) return true;
  const blocked = state.blocked as Record<string, unknown>;
  return typeof blocked === "object" && !Array.isArray(blocked) && Object.keys(blocked).length === 3
    && typeof blocked.reason === "string" && typeof blocked.key_id === "string" && typeof blocked.version === "string";
}
