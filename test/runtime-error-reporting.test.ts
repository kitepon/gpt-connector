import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { defaultBugHubCredentialPath, defaultFactoryReporterConfigPath, defaultRuntimeErrorStorePath } from "../src/platform/state.js";
import {
  getRuntimeErrorReportingStatus,
  reportRuntimeErrors,
  reportRuntimeErrorsBestEffort,
  setRuntimeErrorReporting,
  signRuntimeErrorReceipt,
  signRuntimeErrorReport,
  type RuntimeErrorReportingOptions,
} from "../src/runtime-error-reporting.js";
import { getRuntimeErrorDiagnostics, observeRuntimeError, resolveRuntimeError } from "../src/runtime-error-store.js";
import { packageVersion } from "../src/version.js";

const secret = "bughub-test-secret-do-not-use-0123456789abcdef";
const url = "http://192.168.1.2:39310/api/products/v1/runtime-errors";
const posix = process.platform !== "win32";

interface Sent { readonly url: string; readonly body: string; readonly authorization: string; readonly redirect: string | undefined; }

// 契約どおりに署名と時刻を確かめ、署名付きの応答を返すBugHubの代役。
function fakeBugHub(reply?: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    const record: Sent = { url: String(input), body, authorization: new Headers(init?.headers).get("authorization") ?? "", redirect: init?.redirect };
    sent.push(record);
    if (reply) return reply(record);
    const match = /^BugHub-HMAC-SHA256 key_id=([^,]+), ts=(\d+), sig=([a-f0-9]{64})$/u.exec(record.authorization);
    if (!match || match[1] !== "key-1" || match[3] !== signRuntimeErrorReport(secret, match[2]!, Buffer.from(body, "utf8"))) return Response.json({ error: "unauthorized" }, { status: 401 });
    const report = JSON.parse(body) as { report_id: string; observed_at: string };
    if (Math.abs(Date.parse(report.observed_at) - Number(match[2]) * 1000) > 600_000) return Response.json({ error: "observed_at_skew" }, { status: 422 });
    const receivedAt = "2026-10-03T08:00:01.000Z";
    return Response.json({ accepted: true, report_id: report.report_id, duplicate: false, received_at: receivedAt, sig: signRuntimeErrorReceipt(secret, report.report_id, receivedAt) });
  }) as typeof fetch;
  return { sent, fetcher };
}

function sandbox(now = "2026-10-03T08:00:00.000Z") {
  const root = mkdtempSync(join(tmpdir(), "gpt-connector-reporting-"));
  const env = { HOME: join(root, "home"), USERPROFILE: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const options = { env, configPath: defaultFactoryReporterConfigPath(env), storePath: defaultRuntimeErrorStorePath(env), credentialPath: defaultBugHubCredentialPath(env), windowsAcl: () => undefined, now };
  return { root, env, options };
}

function placeCredential(path: string, value: unknown = { url, key_id: "key-1", secret }, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode });
  chmodSync(path, mode);
}

function with_(options: RuntimeErrorReportingOptions, extra: Partial<RuntimeErrorReportingOptions>): RuntimeErrorReportingOptions { return { ...options, ...extra }; }

test("署名は契約の試験値と一致する", () => {
  const body = Buffer.from('{"schema_version":"1.0","report_id":"00000000-0000-4000-8000-000000000001","product_id":"caveat","installed_version":"0.19.13","observed_at":"2026-09-21T14:13:20.000Z","runtime_errors":[],"resolutions":[]}', "utf8");
  assert.equal(body.length, 205);
  assert.equal(createHash("sha256").update(body).digest("hex"), "6a8ae99ecebde0f6d50b8e8d5273604c6e02c3df150645bd96de0e79d7710b2f");
  assert.equal(signRuntimeErrorReport(secret, "1790000000", body), "e4ba0355c9d9058286a82d9622747eae264f780aa575e74859c40a6e529fa73a");
  assert.equal(signRuntimeErrorReceipt(secret, "00000000-0000-4000-8000-000000000001", "2026-09-21T14:13:21.000Z"), "cc4ebb409cdd6a2be5f69f6acf8ebcd7f18acbe14b9ac82836797572f74a64bb");
});

test("既定では通信しない。有効にしても合鍵が無い端末では通信しない", async () => {
  const { options } = sandbox();
  const hub = fakeBugHub();
  assert.deepEqual(await reportRuntimeErrors("manual", with_(options, { fetch: hub.fetcher })), { status: "disabled" });
  // 送信が無効で工場の設定も無い端末では、収集もしない。
  assert.equal(observeRuntimeError({ code: "CHAT_FAILED" }, options).status, "disabled");

  assert.equal(setRuntimeErrorReporting(true, options).reporting, "enabled");
  assert.equal(getRuntimeErrorReportingStatus(options).credential, "missing");
  assert.equal(observeRuntimeError({ code: "CHAT_FAILED" }, options).status, "recorded");
  assert.deepEqual(await reportRuntimeErrors("manual", with_(options, { fetch: hub.fetcher })), { status: "no_credential" });
  assert.equal(await reportRuntimeErrorsBestEffort(with_(options, { fetch: hub.fetcher })), "no_credential");
  assert.equal(hub.sent.length, 0);

  assert.equal(setRuntimeErrorReporting(false, options).reporting, "disabled");
  placeCredential(options.credentialPath);
  assert.deepEqual(await reportRuntimeErrors("manual", with_(options, { fetch: hub.fetcher })), { status: "disabled" });
  assert.equal(hub.sent.length, 0);
});

test("受領の4条件がそろった時だけ受領済みにし、契約の本文と署名で送る", async () => {
  const { options } = sandbox();
  setRuntimeErrorReporting(true, options);
  placeCredential(options.credentialPath);
  observeRuntimeError({ code: "CHAT_FAILED", now: "2026-10-03T07:00:00.000Z" }, options);
  const resolved = observeRuntimeError({ code: "CDP_UNAVAILABLE", now: "2026-10-03T07:10:00.000Z" }, options);
  assert.equal(resolved.status, "recorded");
  if (resolved.status === "recorded") resolveRuntimeError(resolved.fingerprint, with_(options, { now: "2026-10-03T07:20:00.000Z" }));
  assert.equal(getRuntimeErrorDiagnostics(options).pending_count, 2);

  const hub = fakeBugHub();
  const reportId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: hub.fetcher, reportId })), { status: "accepted" });
  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0]!.url, url);
  assert.equal(hub.sent[0]!.redirect, "manual");
  assert.match(hub.sent[0]!.authorization, /^BugHub-HMAC-SHA256 key_id=key-1, ts=1791014400, sig=[a-f0-9]{64}$/u);
  assert.doesNotMatch(`${hub.sent[0]!.authorization}${hub.sent[0]!.body}`, new RegExp(secret, "u"));
  const report = JSON.parse(hub.sent[0]!.body) as Record<string, unknown> & { runtime_errors: Record<string, unknown>[]; resolutions: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(report), ["schema_version", "report_id", "product_id", "installed_version", "observed_at", "runtime_errors", "resolutions"]);
  assert.deepEqual({ ...report, runtime_errors: undefined, resolutions: undefined }, { schema_version: "1.0", report_id: reportId, product_id: "gpt-connector",
    installed_version: packageVersion, observed_at: "2026-10-03T08:00:00.000Z", runtime_errors: undefined, resolutions: undefined });
  assert.deepEqual(report.runtime_errors.map((item) => Object.keys(item).sort()), [["component", "error_code", "fingerprint", "first_seen", "last_seen", "message_template", "occurrence_count", "product_version", "severity", "state_schema_version", "status"]]);
  assert.deepEqual(report.runtime_errors.map((item) => [item.error_code, item.status, item.occurrence_count]), [["CHAT_FAILED", "open", 1]]);
  assert.deepEqual(report.resolutions.map((item) => Object.keys(item).sort()), [["fingerprint", "reason_code", "resolved_at"]]);
  assert.equal(getRuntimeErrorDiagnostics(options).pending_count, 0);
  assert.equal(getRuntimeErrorReportingStatus(options).last_result, "accepted");

  // 未受領が無ければ、自動では送らない。
  assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: hub.fetcher, now: "2026-10-03T10:00:00.000Z" })), { status: "nothing_pending" });
  assert.equal(hub.sent.length, 1);
});

test("そろわない200は受領済みにせず、後から送り直せる", async () => {
  for (const tamper of [
    (value: Record<string, unknown>) => ({ ...value, sig: "0".repeat(64) }),
    (value: Record<string, unknown>) => ({ ...value, report_id: "22222222-2222-4222-8222-222222222222" }),
    (value: Record<string, unknown>) => ({ ...value, accepted: false }),
    (value: Record<string, unknown>) => ({ accepted: true, report_id: value.report_id }),
  ]) {
    const { options } = sandbox();
    setRuntimeErrorReporting(true, options);
    placeCredential(options.credentialPath);
    observeRuntimeError({ code: "CHAT_FAILED" }, options);
    const reportId = "11111111-1111-4111-8111-111111111111";
    const receivedAt = "2026-10-03T08:00:01.000Z";
    const hub = fakeBugHub(() => Response.json(tamper({ accepted: true, report_id: reportId, duplicate: false, received_at: receivedAt, sig: signRuntimeErrorReceipt(secret, reportId, receivedAt) })));
    assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: hub.fetcher, reportId })), { status: "unconfirmed" });
    assert.equal(getRuntimeErrorDiagnostics(options).pending_count, 1);
    // 1時間たてば、その時点の累計を新しいreport_idで送り直す。
    const retry = fakeBugHub();
    assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: retry.fetcher, now: "2026-10-03T09:00:00.000Z" })), { status: "accepted" });
    assert.notEqual((JSON.parse(retry.sent[0]!.body) as { report_id: string }).report_id, reportId);
    assert.equal(getRuntimeErrorDiagnostics(options).pending_count, 0);
  }
});

test("自動の送信は1時間に1回まで、手動は1分に1回まで", async () => {
  const { options } = sandbox();
  setRuntimeErrorReporting(true, options);
  placeCredential(options.credentialPath);
  observeRuntimeError({ code: "CHAT_FAILED" }, options);
  const hub = fakeBugHub();
  assert.equal((await reportRuntimeErrors("automatic", with_(options, { fetch: hub.fetcher }))).status, "accepted");
  observeRuntimeError({ code: "CHAT_FAILED" }, options);
  assert.equal((await reportRuntimeErrors("automatic", with_(options, { fetch: hub.fetcher, now: "2026-10-03T08:59:59.000Z" }))).status, "throttled");
  assert.equal((await reportRuntimeErrors("manual", with_(options, { fetch: hub.fetcher, now: "2026-10-03T08:00:59.000Z" }))).status, "throttled");
  assert.equal(hub.sent.length, 1);
  assert.equal((await reportRuntimeErrors("manual", with_(options, { fetch: hub.fetcher, now: "2026-10-03T08:01:00.000Z" }))).status, "accepted");
  assert.deepEqual((JSON.parse(hub.sent[1]!.body) as { runtime_errors: { occurrence_count: number }[] }).runtime_errors.map((item) => item.occurrence_count), [2]);
});

test("再送しても通らない拒否は自動では送り直さず、一時的な失敗は送り直す", async () => {
  const { options } = sandbox();
  setRuntimeErrorReporting(true, options);
  placeCredential(options.credentialPath);
  observeRuntimeError({ code: "CHAT_FAILED" }, options);
  const denied = fakeBugHub(() => Response.json({ error: "credential_inactive" }, { status: 403 }));
  assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: denied.fetcher })), { status: "rejected", reason: "credential_inactive" });
  assert.equal(getRuntimeErrorReportingStatus(options).blocked, "credential_inactive");
  assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: denied.fetcher, now: "2026-10-03T12:00:00.000Z" })), { status: "blocked", reason: "credential_inactive" });
  assert.equal(denied.sent.length, 1);
  // 合鍵が入れ替われば、自動の送信へ戻る。
  placeCredential(options.credentialPath, { url, key_id: "key-2", secret });
  const skew = fakeBugHub(() => Response.json({ error: "timestamp_skew", server_time: "2026-10-03T12:30:00.000Z" }, { status: 401 }));
  assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: skew.fetcher, now: "2026-10-03T13:00:00.000Z" })), { status: "retry_later", reason: "timestamp_skew" });
  assert.equal(getRuntimeErrorReportingStatus(options).blocked, null);
  const down = fakeBugHub(() => { throw new TypeError("fetch failed"); });
  assert.deepEqual(await reportRuntimeErrors("automatic", with_(options, { fetch: down.fetcher, now: "2026-10-03T14:00:00.000Z" })), { status: "retry_later", reason: "unreachable" });
  assert.equal(await reportRuntimeErrorsBestEffort(with_(options, { fetch: down.fetcher, now: "2026-10-03T15:00:00.000Z" })), "retry_later");
  assert.equal(getRuntimeErrorDiagnostics(options).pending_count, 1);
});

test("置かれた時の形でない合鍵は使わず、秘密値を状態へ出さない", { skip: !posix }, async () => {
  const hub = fakeBugHub();
  const cases: ((path: string) => void)[] = [
    (path) => placeCredential(path, { url, key_id: "key-1", secret }, 0o644),
    (path) => placeCredential(path, { url, key_id: "key 1, ts=1", secret }),
    (path) => placeCredential(path, { url: "file:///etc/passwd", key_id: "key-1", secret }),
    (path) => placeCredential(path, { url, key_id: "key-1" }),
    (path) => { placeCredential(`${path}.real`); symlinkSync(`${path}.real`, path); },
  ];
  for (const place of cases) {
    const { options } = sandbox();
    setRuntimeErrorReporting(true, options);
    observeRuntimeError({ code: "CHAT_FAILED" }, options);
    place(options.credentialPath);
    assert.equal(getRuntimeErrorReportingStatus(options).credential, "invalid");
    assert.deepEqual(await reportRuntimeErrors("manual", with_(options, { fetch: hub.fetcher })), { status: "invalid_credential" });
  }
  assert.equal(hub.sent.length, 0);

  const { options } = sandbox();
  setRuntimeErrorReporting(true, options);
  placeCredential(options.credentialPath);
  observeRuntimeError({ code: "CHAT_FAILED" }, options);
  await reportRuntimeErrors("manual", with_(options, { fetch: hub.fetcher }));
  const status = getRuntimeErrorReportingStatus(options);
  assert.deepEqual(Object.keys(status), ["schema", "reporting", "credential", "last_attempt_at", "last_result", "blocked"]);
  assert.doesNotMatch(JSON.stringify(status) + readFileSync(join(dirname(options.storePath), "runtime-error-reporting.json"), "utf8"), new RegExp(`${secret}|192\\.168`, "u"));
});
