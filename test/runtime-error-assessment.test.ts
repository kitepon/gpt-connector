import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ConnectorError } from "../src/errors.js";
import { assessRuntimeFailure, runtimeFailureDecision, type FailureAssessment } from "../src/runtime-error-assessment.js";
import { readRuntimeErrorEvents, runtimeOperationFromCli } from "../src/runtime-error-events.js";

test("endpoint待ち段階はv3へ残し旧v2の記録を書き換えない", () => {
  const options = sandbox();
  recordRuntimeErrorBestEffort(new ConnectorError("CDP_UNAVAILABLE", "old"), { ...options, now: "2026-10-29T00:00:00.000Z" });
  const store = defaultRuntimeErrorStorePath(options.env);
  const old = readFileSync(`${store}.events.v3`, "utf8");
  writeFileSync(`${store}.events.v2`, old, { mode: 0o600 });
  recordRuntimeErrorBestEffort(new ConnectorError("CDP_UNAVAILABLE", "private-token", { cdpStage: "browser_endpoint_wait", cdpReason: "timeout" }), { ...options, now: "2026-10-30T01:32:26.212Z", operation: "browser_start", entrypoint: "cli" });
  const event = readRuntimeErrorEvents(options).at(-1)!;
  assert.equal(event.context?.cdp?.stage, "browser_endpoint_wait");
  assert.equal(event.context?.cdp?.reason, "timeout");
  assert.equal(event.decision.severity, "high");
  assert.equal(readFileSync(`${store}.events.v2`, "utf8"), old);
  assert.doesNotMatch(readFileSync(`${store}.events.v3`, "utf8"), /private-token/);
  console.log("SAFE_BROWSER_ENDPOINT_EVENT_JSON", JSON.stringify(event));
});

test("CDPの操作/段階/固定flagと版を記録し、集約と同じfingerprint/時刻で照合できる", () => {
  const options = sandbox();
  assert.equal(recordRuntimeErrorBestEffort(new ConnectorError("CDP_UNAVAILABLE", "private-prompt", {
    cdpStage: "target_discovery", cdpReason: "target_missing", targetMissing: true, unreachable: "private-token", beforeSubmission: false,
    url: "https://private.invalid/?secret=credential",
  }), { ...options, operation: "browser_show", entrypoint: "cli", assessment: failed }), "recorded");
  const event = readRuntimeErrorEvents(options)[0]!;
  const aggregate = readRuntimeErrorSnapshot(options).runtime_errors[0]!;
  assert.equal(event.product_version, aggregate.product_version);
  assert.equal(event.fingerprint, aggregate.fingerprint);
  assert.equal(event.observed_at, aggregate.last_seen);
  assert.deepEqual(event.context, { source: "public_operation", failures: [], operation: "browser_show", entrypoint: "cli",
    cdp: { stage: "target_discovery", reason: "target_missing", target_missing: true, unreachable: null, before_submission: false } });
  assert.doesNotMatch(JSON.stringify(event), /private|credential|secret=|https:/u);
  console.log("SAFE_CDP_EVENT_JSON", JSON.stringify(event));
});

test("CLI操作名は固定語だけにし、未知argvやprovider値を診断へ写さない", () => {
  assert.equal(runtimeOperationFromCli(["browser", "show"]), "browser_show");
  assert.equal(runtimeOperationFromCli(["browser", "start", "--provider", "grok"]), "grok_browser_start");
  assert.equal(runtimeOperationFromCli(["chat", "--prompt", "private-prompt"]), "chat");
  assert.equal(runtimeOperationFromCli(["private-token"]), "unknown");
  assert.equal(runtimeOperationFromCli(["browser", "private-token"]), "unknown");
  const options = sandbox();
  recordRuntimeErrorBestEffort(new ConnectorError("CDP_UNAVAILABLE", "secret", { cdpStage: "private-token" }), { ...options, operation: "chat", entrypoint: "mcp", assessment: failed });
  assert.equal(readRuntimeErrorEvents(options)[0]?.context?.cdp?.stage, "unknown");
  assert.doesNotMatch(JSON.stringify(readRuntimeErrorEvents(options)), /private-token|secret/u);
});
import { defaultFactoryReporterConfigPath, defaultRuntimeErrorStorePath, observeRuntimeError, readRuntimeErrorSnapshot, recordRuntimeErrorBestEffort, resolveRuntimeError } from "../src/runtime-error-store.js";
import { setupRuntimeDriftOptions } from "../src/setup.js";

const failed: FailureAssessment = { cause: "unknown", impact: "operation_failed", handling: "unknown", recovery: "unknown", cancelled: false };
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "gpt-connector-network-policy-"));
  const env = { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const config = defaultFactoryReporterConfigPath(env);
  mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  writeFileSync(config, JSON.stringify({ schema_version: "1.0", host: { id: "test-host", profile: "mac" }, collection: { enabled: true }, reporting: { enabled: false } }), { mode: 0o600 });
  return { env };
}

test("同じcodeでも対処・実害・復帰の観測で登録と重大度が変わり、環境の重大な影響も報告する", () => {
  for (const cause of ["unknown", "environment", "application"] as const) {
    assert.deepEqual(runtimeFailureDecision({ ...failed, cause, handling: "handled", recovery: "safe" }), { register: false, severity: "info" });
    assert.deepEqual(runtimeFailureDecision({ ...failed, cause, handling: "defective", recovery: "status_first" }), { register: true, severity: "warn" });
    assert.deepEqual(runtimeFailureDecision({ ...failed, cause, impact: "data_loss", handling: "handled", recovery: "safe" }), { register: true, severity: "high" });
    assert.deepEqual(runtimeFailureDecision({ ...failed, cause, impact: "service_stopped" }), { register: true, severity: "fatal" });
  }
});

test("取消確認のないAbortという本文だけでは正常な取消と決めず、結果不明の失敗を隠さない", () => {
  const error = new ConnectorError("CHAT_FAILED", "AbortError token=private");
  assert.deepEqual(assessRuntimeFailure(error), failed);
  const options = sandbox();
  assert.equal(recordRuntimeErrorBestEffort(error, options), "recorded");
  assert.equal(readRuntimeErrorSnapshot(options).runtime_errors[0]?.severity, "high");
  assert.doesNotMatch(readFileSync(`${defaultRuntimeErrorStorePath(options.env)}.events.v3`, "utf8"), /private|AbortError|token/);
  const cancelled = new ConnectorError("CHAT_FAILED", "cancelled", { cancellationConfirmed: true });
  assert.equal(recordRuntimeErrorBestEffort(cancelled, options), "disabled");
  assert.equal(readRuntimeErrorSnapshot(options).runtime_errors[0]?.occurrence_count, 1);
  assert.equal(readRuntimeErrorEvents(options).at(-1)?.assessment.cancelled, true);
});

test("正常対処とcodeだけの観測は診断のみ、既存のhigh記録・累計・時刻・fingerprintを訂正せず保持する", () => {
  const options = sandbox();
  observeRuntimeError({ severity: "high", code: "CDP_UNAVAILABLE", now: "2026-10-01T00:00:00.000Z" }, options);
  const before = readRuntimeErrorSnapshot(options).runtime_errors;
  assert.equal(recordRuntimeErrorBestEffort(new ConnectorError("CDP_UNAVAILABLE", "offline", { unreachable: true }), options), "disabled");
  assert.equal(recordRuntimeErrorBestEffort("CHAT_FAILED", options), "disabled");
  assert.deepEqual(readRuntimeErrorSnapshot(options).runtime_errors, before);
  assert.equal(readRuntimeErrorEvents(options).at(-1)?.assessment.impact, "unknown");
});

test("同じfingerprintの真の新規発生だけが累計を増やし、重大度はその発生の影響から決める", () => {
  const options = sandbox();
  recordRuntimeErrorBestEffort("CHAT_FAILED", { ...options, assessment: failed });
  const before = readRuntimeErrorSnapshot(options).runtime_errors[0]!;
  recordRuntimeErrorBestEffort("CHAT_FAILED", { ...options, assessment: { ...failed, recovery: "status_first" } });
  assert.equal(readRuntimeErrorSnapshot(options).runtime_errors[0]!.severity, "high");
  resolveRuntimeError(before.fingerprint, options);
  recordRuntimeErrorBestEffort("CHAT_FAILED", { ...options, assessment: { ...failed, recovery: "status_first" } });
  const after = readRuntimeErrorSnapshot(options).runtime_errors[0]!;
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.occurrence_count, 3);
  assert.equal(after.first_seen, before.first_seen);
  assert.equal(after.severity, "warn");
});

test("旧eventsを読み、過去の累計を変えずに新しいsetup診断を追記できる。public操作は区別する", () => {
  const options = sandbox();
  const first = "2026-10-10T00:00:00.000Z";
  observeRuntimeError({ code: "RUNTIME_DRIFT", severity: "high", now: first }, options);
  const store = defaultRuntimeErrorStorePath(options.env);
  const old = { code: "RUNTIME_DRIFT", observed_at: first, assessment: { ...failed, cause: "application", handling: "defective", recovery: "unavailable" }, decision: { register: true, severity: "high" } };
  writeFileSync(`${store}.events`, JSON.stringify([old]), { mode: 0o600 });
  const before = readFileSync(store, "utf8");
  assert.deepEqual(readRuntimeErrorEvents(options), [old]);
  assert.equal(readFileSync(store, "utf8"), before);
  recordRuntimeErrorBestEffort("RUNTIME_DRIFT", { ...options, ...setupRuntimeDriftOptions([{ stage: "runtime_discovery", tag: "rspack_runtime" }]), now: "2026-10-12T00:00:00.000Z" });
  const events = readRuntimeErrorEvents(options);
  assert.deepEqual(events[0], old);
  assert.equal(events[1]!.context!.source, "setup_live_check");
  assert.deepEqual(events[1]!.assessment, failed);
  assert.equal(events[1]!.decision.severity, "high");
  const record = readRuntimeErrorSnapshot(options).runtime_errors[0]!;
  assert.equal(record.first_seen, first);
  assert.equal(record.occurrence_count, 2);
  assert.equal(record.last_seen, "2026-10-12T00:00:00.000Z");
  assert.equal(record.severity, "high");
  assert.deepEqual(JSON.parse(readFileSync(`${store}.events`, "utf8")), [old]);
  const prior = JSON.parse(before).records[0];
  assert.equal(record.fingerprint, prior.fingerprint);
  assert.equal(record.error_code, prior.error_code);
  recordRuntimeErrorBestEffort(new ConnectorError("RUNTIME_DRIFT", "secret prompt", { runtimeStage: "bridge_bootstrap", runtimeTag: "sender", secret: "private-token" }), options);
  assert.deepEqual(readRuntimeErrorEvents(options).at(-1)?.context, { source: "public_operation", failures: [{ stage: "bridge_bootstrap", tag: "sender" }] });
  assert.doesNotMatch(readFileSync(`${store}.events.v3`, "utf8"), /private-token|secret prompt/u);
});

test("不正な診断contextは保存せず、実害の登録を隠さない", () => {
  const options = sandbox();
  const context = { source: "setup_live_check", failures: [{ stage: "private-token", tag: "secret" }], extra: "private-prompt" };
  assert.equal(recordRuntimeErrorBestEffort("RUNTIME_DRIFT", { ...options, assessment: { ...failed, cause: "environment", impact: "data_loss" }, context: context as never }), "recorded");
  assert.equal(readRuntimeErrorSnapshot(options).runtime_errors[0]!.severity, "high");
  assert.equal(readRuntimeErrorEvents(options)[0]!.context, undefined);
  assert.doesNotMatch(readFileSync(`${defaultRuntimeErrorStorePath(options.env)}.events.v3`, "utf8"), /private-token|secret|private-prompt/u);
  recordRuntimeErrorBestEffort(new ConnectorError("RUNTIME_DRIFT", "secret", { runtimeStage: "runtime_discovery", runtimeTag: "private-token" }), options);
  assert.deepEqual(readRuntimeErrorEvents(options).at(-1)?.context?.failures, [{ stage: "unknown", tag: "unknown" }]);
});

test("4組の診断付きeventsを128件保持しても読取上限内で、古い1件だけを落とす", () => {
  const options = sandbox();
  const context = setupRuntimeDriftOptions([
    { stage: "browser_preparation", tag: "unknown" },
    { stage: "runtime_discovery", tag: "rspack_runtime" },
    { stage: "bridge_bootstrap", tag: "scopeWrapper" },
    { stage: "authentication", tag: "official_origin" },
  ]);
  for (let second = 0; second < 129; second++) {
    assert.equal(recordRuntimeErrorBestEffort("RUNTIME_DRIFT", { ...options, ...context, now: new Date(Date.UTC(2026, 9, 12, 0, 0, second)).toISOString() }), "recorded");
  }
  const events = readRuntimeErrorEvents(options);
  assert.equal(events.length, 128);
  assert.equal(events[0]!.observed_at, "2026-10-12T00:00:01.000Z");
  assert.equal(events.at(-1)!.observed_at, "2026-10-12T00:02:08.000Z");
  assert.ok(readFileSync(`${defaultRuntimeErrorStorePath(options.env)}.events.v3`).length < 128 * 1024);
});
