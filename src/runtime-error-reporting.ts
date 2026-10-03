// 実行時エラーを製品自身がBugHubへ送る。既定では通信しない。端末で明示して有効にし、
// BugHubの持ち主が合鍵を置いた端末でだけ送る。契約の正本はBugHubのPRODUCT_REPORTING。
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

import { defaultBugHubCredentialPath, isWindows } from "./platform/state.js";
import { acknowledgeRuntimeErrors, readRuntimeErrorSnapshot, type RuntimeErrorOptions } from "./runtime-error-store.js";
import { readRuntimeErrorReportingState, runtimeErrorReportingSchema, writeRuntimeErrorReportingState, type RuntimeErrorReportingState } from "./runtime-error-reporting-state.js";
import { packageVersion } from "./version.js";

export const runtimeErrorReportSchemaVersion = "1.0" as const;
const automaticIntervalMs = 60 * 60_000;
const manualIntervalMs = 60_000;
const defaultTimeoutMs = 5_000;
const maxResponseBytes = 64 * 1024;

export interface RuntimeErrorReportingOptions extends RuntimeErrorOptions {
  readonly credentialPath?: string;
  readonly fetch?: typeof fetch;
  readonly reportId?: string;
  readonly timeoutMs?: number;
}

export type RuntimeErrorReportStatus =
  | "disabled" | "no_credential" | "invalid_credential" | "nothing_pending" | "throttled" | "blocked"
  | "accepted" | "unconfirmed" | "rejected" | "retry_later";

interface Credential { readonly url: string; readonly keyId: string; readonly secret: string; }
type CredentialResult = { readonly status: "ready"; readonly credential: Credential } | { readonly status: "missing" | "invalid" };

/** 送る本文の署名。secretは文字列をそのままUTF-8で鍵にし、本文は実際に送るバイト列で計算する。 */
export function signRuntimeErrorReport(secret: string, ts: string, body: Uint8Array): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${ts}\n${bodyHash}`).digest("hex");
}

/** 応答の署名。別の機器が返した200を受領済みにしないために確かめる。 */
export function signRuntimeErrorReceipt(secret: string, reportId: string, receivedAt: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${reportId}\n${receivedAt}`).digest("hex");
}

export function setRuntimeErrorReporting(enabled: boolean, options: RuntimeErrorReportingOptions = {}) {
  const previous = readRuntimeErrorReportingState(options);
  writeRuntimeErrorReportingState({ ...previous, enabled, blocked: enabled ? previous.blocked : null }, options);
  return getRuntimeErrorReportingStatus(options);
}

/** 秘密値と宛先は出さない。端末の設定を確かめるのに要る状態だけを返す。 */
export function getRuntimeErrorReportingStatus(options: RuntimeErrorReportingOptions = {}) {
  const state = readRuntimeErrorReportingState(options);
  return { schema: runtimeErrorReportingSchema, reporting: state.enabled ? "enabled" as const : "disabled" as const,
    credential: readCredential(options).status, last_attempt_at: state.last_attempt_at, last_result: state.last_result,
    blocked: state.blocked?.reason ?? null };
}

export async function reportRuntimeErrors(trigger: "manual" | "automatic", options: RuntimeErrorReportingOptions = {}): Promise<{ readonly status: RuntimeErrorReportStatus; readonly reason?: string }> {
  const state = readRuntimeErrorReportingState(options);
  if (!state.enabled) return { status: "disabled" };
  const found = readCredential(options);
  if (found.status !== "ready") return { status: found.status === "missing" ? "no_credential" : "invalid_credential" };
  const { credential } = found;

  const snapshot = readRuntimeErrorSnapshot({ ...options, afterCursor: 0 });
  if (trigger === "automatic" && snapshot.diagnostics.pending_count === 0) return { status: "nothing_pending" };
  const now = new Date(options.now ?? Date.now());
  const sinceLast = state.last_attempt_at === null ? Number.POSITIVE_INFINITY : now.valueOf() - Date.parse(state.last_attempt_at);
  if (sinceLast < (trigger === "automatic" ? automaticIntervalMs : manualIntervalMs)) return { status: "throttled" };
  if (trigger === "automatic" && state.blocked && state.blocked.key_id === credential.keyId && state.blocked.version === packageVersion) {
    return { status: "blocked", reason: state.blocked.reason };
  }

  // 送る前に時刻を残し、同じ端末の別processが続けて送らないようにする。
  const attempt: RuntimeErrorReportingState = { ...state, last_attempt_at: now.toISOString() };
  writeRuntimeErrorReportingState(attempt, options);

  const reportId = options.reportId ?? randomUUID();
  // observed_atとtsは同じ時刻から作る（契約: tsから±10分以内）。
  const ts = String(Math.floor(now.valueOf() / 1000));
  const body = JSON.stringify({ schema_version: runtimeErrorReportSchemaVersion, report_id: reportId, product_id: "gpt-connector",
    installed_version: packageVersion, observed_at: now.toISOString(), runtime_errors: snapshot.runtime_errors, resolutions: snapshot.resolutions });
  // 署名は、送るUTF-8のバイト列そのものに対して計算する。
  const authorization = `BugHub-HMAC-SHA256 key_id=${credential.keyId}, ts=${ts}, sig=${signRuntimeErrorReport(credential.secret, ts, Buffer.from(body, "utf8"))}`;

  const outcome = await send(credential, reportId, body, authorization, options);
  if (outcome.status === "accepted" && snapshot.cursor.high_watermark > 0) acknowledgeRuntimeErrors(snapshot.cursor.high_watermark, options);
  writeRuntimeErrorReportingState({ ...attempt, last_result: outcome.reason ? `${outcome.status}:${outcome.reason}` : outcome.status,
    blocked: outcome.status === "rejected" ? { reason: outcome.reason ?? "rejected", key_id: credential.keyId, version: packageVersion } : null }, options);
  return outcome;
}

/** 製品の操作を止めないための入口。失敗しても例外を出さない。 */
export async function reportRuntimeErrorsBestEffort(options: RuntimeErrorReportingOptions = {}): Promise<RuntimeErrorReportStatus | "failed"> {
  try { return (await reportRuntimeErrors("automatic", options)).status; } catch { return "failed"; }
}

async function send(credential: Credential, reportId: string, body: string, authorization: string, options: RuntimeErrorReportingOptions): Promise<{ readonly status: RuntimeErrorReportStatus; readonly reason?: string }> {
  let response: Response;
  let text: string;
  try {
    response = await (options.fetch ?? fetch)(credential.url, { method: "POST", body, redirect: "manual",
      headers: { "content-type": "application/json", authorization }, signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs) });
    text = await response.text();
  } catch { return { status: "retry_later", reason: "unreachable" }; }
  let parsed: Record<string, unknown> = {};
  if (Buffer.byteLength(text, "utf8") <= maxResponseBytes) {
    try { const value: unknown = JSON.parse(text); if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>; } catch { /* 形の違う応答は下で未確認として扱う */ }
  }
  if (response.status === 200) {
    // 受領済みにしてよいのは、accepted・report_idの一致・応答の署名の一致がそろった時だけ。
    const receivedAt = parsed.received_at;
    const confirmed = parsed.accepted === true && parsed.report_id === reportId && typeof receivedAt === "string" && typeof parsed.sig === "string"
      && sameHex(parsed.sig, signRuntimeErrorReceipt(credential.secret, reportId, receivedAt));
    return confirmed ? { status: "accepted" } : { status: "unconfirmed" };
  }
  const code = responseCode(parsed);
  // 時計のずれ・本文の衝突・回数の超過・一時的な失敗は、後からその時点の累計を送り直せば通る。
  if (code === "timestamp_skew" || code === "observed_at_skew") return { status: "retry_later", reason: code };
  if (response.status === 409 || response.status === 429 || response.status >= 500) return { status: "retry_later", reason: code ?? `http_${response.status}` };
  if ([401, 403, 413, 422].includes(response.status)) return { status: "rejected", reason: code ?? `http_${response.status}` };
  return { status: "retry_later", reason: `http_${response.status}` };
}

const knownCodes = ["unauthorized", "timestamp_skew", "credential_inactive", "product_binding_mismatch", "report_id_conflict", "report_too_large", "invalid_report", "observed_at_skew", "rate_limited"] as const;
function responseCode(parsed: Record<string, unknown>): string | undefined {
  return knownCodes.find((code) => Object.values(parsed).includes(code));
}

function sameHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function readCredential(options: RuntimeErrorReportingOptions): CredentialResult {
  const path = options.credentialPath ?? defaultBugHubCredentialPath(options.env);
  let info;
  try { info = lstatSync(path); } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" }; }
  // 置かれた時の形（本人所有・本人だけが読める・symlinkでない）でないfileは使わない。
  if (!info.isFile() || info.isSymbolicLink()) return { status: "invalid" };
  if (!isWindows(options.env) && ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))) return { status: "invalid" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "invalid" };
    const { url, key_id: keyId, secret } = parsed as Record<string, unknown>;
    if (typeof url !== "string" || typeof keyId !== "string" || typeof secret !== "string" || secret.length === 0) return { status: "invalid" };
    // key_idはヘッダーへそのまま入れるので、区切りや改行を含む値は使わない。
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(keyId) || !["http:", "https:"].includes(new URL(url).protocol)) return { status: "invalid" };
    return { status: "ready", credential: { url, keyId, secret } };
  } catch { return { status: "invalid" }; }
}
