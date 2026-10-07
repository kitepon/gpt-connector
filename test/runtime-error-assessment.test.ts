import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ConnectorError } from "../src/errors.js";
import { assessRuntimeFailure, runtimeFailureDecision, type FailureAssessment } from "../src/runtime-error-assessment.js";
import { readRuntimeErrorEvents } from "../src/runtime-error-events.js";
import { defaultFactoryReporterConfigPath, defaultRuntimeErrorStorePath, observeRuntimeError, readRuntimeErrorSnapshot, recordRuntimeErrorBestEffort, resolveRuntimeError } from "../src/runtime-error-store.js";

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
  assert.doesNotMatch(readFileSync(`${defaultRuntimeErrorStorePath(options.env)}.events`, "utf8"), /private|AbortError|token/);
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
