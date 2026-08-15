import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  acknowledgeRuntimeErrors,
  compactRuntimeErrors,
  defaultFactoryReporterConfigPath,
  defaultRuntimeErrorStorePath,
  getRuntimeErrorDiagnostics,
  observeRuntimeError,
  readRuntimeErrorSnapshot,
  reopenRuntimeError,
  resolveRuntimeError,
} from "../src/runtime-error-store.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "gpt-connector-runtime-errors-"));
  const env = { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  return { env, configPath: defaultFactoryReporterConfigPath(env), storePath: defaultRuntimeErrorStorePath(env) };
}
function enable(box: ReturnType<typeof sandbox>) {
  mkdirSync(dirname(box.configPath), { recursive: true, mode: 0o700 });
  writeFileSync(box.configPath, JSON.stringify({ schema_version: "1.0", host: { id: "test-host", profile: "mac" }, collection: { enabled: true }, reporting: { enabled: false } }), { mode: 0o600 });
}
function disable(box: ReturnType<typeof sandbox>) {
  writeFileSync(box.configPath, JSON.stringify({ schema_version: "1.0", host: { id: "test-host", profile: "mac" }, collection: { enabled: false }, reporting: { enabled: false } }), { mode: 0o600 });
}

test("runtime error storeはcanonical collection.enabled=true以外でstateを作らない", () => {
  const box = sandbox();
  assert.deepEqual(observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env }), { status: "disabled" });
  assert.throws(() => statSync(box.storePath), { code: "ENOENT" });
  mkdirSync(dirname(box.configPath), { recursive: true });
  writeFileSync(box.configPath, JSON.stringify({ collection: { enabled: true } }));
  assert.deepEqual(observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env }), { status: "disabled" });
});

test("runtime error storeは固定templateをSHA-256で集約し、raw private inputを拒否する", () => {
  const box = sandbox(); enable(box);
  const first = observeRuntimeError({ code: "RUNTIME_DRIFT", now: "2026-07-13T00:00:00.000Z" }, { env: box.env });
  const second = observeRuntimeError({ code: "RUNTIME_DRIFT", now: "2026-07-13T00:01:00.000Z" }, { env: box.env });
  assert.equal(first.status, "recorded"); assert.equal(second.status, "recorded");
  if (first.status !== "recorded" || second.status !== "recorded") throw new Error("fixture failure");
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/u); assert.equal(first.fingerprint, second.fingerprint);
  const entry = readRuntimeErrorSnapshot({ env: box.env }).runtime_errors[0]!;
  assert.equal(entry.occurrence_count, 2);
  assert.throws(() => observeRuntimeError({ code: "CHAT_FAILED", prompt: "secret" } as never, { env: box.env }), /固定 code/);
  assert.doesNotMatch(readFileSync(box.storePath, "utf8"), /secret|prompt|stack|stderr/i);
});

test("runtime error storeはackを単調にし、resolvedかつack済みだけをretention compactする", () => {
  const box = sandbox(); enable(box);
  const result = observeRuntimeError({ code: "CHAT_FAILED", now: "2026-06-01T00:00:00.000Z" }, { env: box.env });
  if (result.status !== "recorded") throw new Error("fixture failure");
  resolveRuntimeError(result.fingerprint, { env: box.env, now: "2026-06-02T00:00:00.000Z" });
  assert.equal(acknowledgeRuntimeErrors(2, { env: box.env }).acknowledgedThrough, 2);
  assert.equal(compactRuntimeErrors({ env: box.env, now: "2026-07-13T00:00:00.000Z" }).removed, 1);
  assert.throws(() => acknowledgeRuntimeErrors(3, { env: box.env }), /high watermark/);
});

test("collection OFF後も既存storeだけはack、resolve、reopen、compactでき、新規観測とsnapshot収集は止まる", () => {
  const box = sandbox(); enable(box);
  const recorded = observeRuntimeError({ code: "CHAT_FAILED", now: "2026-06-01T00:00:00.000Z" }, { env: box.env });
  if (recorded.status !== "recorded") throw new Error("fixture failure");
  readRuntimeErrorSnapshot({ env: box.env });
  disable(box);
  assert.equal(observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env }).status, "disabled");
  assert.equal(resolveRuntimeError(recorded.fingerprint, { env: box.env, now: "2026-06-02T00:00:00.000Z" }).status, "resolved");
  assert.equal(reopenRuntimeError(recorded.fingerprint, { env: box.env }).status, "open");
  assert.equal(resolveRuntimeError(recorded.fingerprint, { env: box.env, now: "2026-06-02T00:00:00.000Z" }).status, "resolved");
  assert.equal(acknowledgeRuntimeErrors(4, { env: box.env }).status, "acknowledged");
  assert.equal(compactRuntimeErrors({ env: box.env, now: "2026-07-13T00:00:00.000Z" }).removed, 1);
  assert.equal(readRuntimeErrorSnapshot({ env: box.env }).diagnostics.collection, "disabled");
});

test("Windows ACLは注入した正規ACL境界の失敗をstore_unavailableへ変換し、非Windowsでも分岐をfixture化する", () => {
  const box = sandbox(); enable(box);
  const windowsEnv = { ...box.env, OS: "Windows_NT" };
  let calls = 0;
  assert.throws(() => observeRuntimeError({ code: "CHAT_FAILED" }, { env: windowsEnv, configPath: box.configPath, storePath: box.storePath, windowsAcl: () => { calls++; throw new Error("acl denied"); } }));
  assert.ok(calls > 0);
  observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env });
  assert.equal(getRuntimeErrorDiagnostics({ env: windowsEnv, configPath: box.configPath, storePath: box.storePath, windowsAcl: () => { throw new Error("acl denied"); } }).status, "unavailable");
});

test("Windows実ACLはaccount名の大文字小文字差を許容してsnapshotとackを完了する", { skip: process.platform !== "win32" }, () => {
  const box = sandbox(); enable(box);
  assert.equal(observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env }).status, "recorded");
  assert.equal(readRuntimeErrorSnapshot({ env: box.env }).runtime_errors.length, 1);
  assert.equal(acknowledgeRuntimeErrors(1, { env: box.env }).status, "acknowledged");
});

test("runtime error storeはprivate mode、tamper、symlinkを拒否し、診断へpathを出さない", { skip: process.platform === "win32" }, () => {
  const box = sandbox(); enable(box);
  observeRuntimeError({ code: "CDP_UNAVAILABLE" }, { env: box.env });
  assert.equal(statSync(dirname(box.storePath)).mode & 0o777, 0o700);
  assert.equal(statSync(box.storePath).mode & 0o777, 0o600);
  chmodSync(box.storePath, 0o644);
  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, "unavailable");
});

test("tampered store内のraw値はsnapshotへ出さずfail-closedする", () => {
  const box = sandbox(); enable(box);
  observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env });
  const store = JSON.parse(readFileSync(box.storePath, "utf8")) as { records: Array<Record<string, unknown>> };
  store.records[0]!.message_template = "prompt=/Users/private/token=secret raw stack";
  writeFileSync(box.storePath, JSON.stringify(store), { mode: 0o600 });
  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, "unavailable");
  assert.throws(() => readRuntimeErrorSnapshot({ env: box.env }));
});

test("runtime error storeはstate symlinkを拒否する", { skip: process.platform === "win32" }, () => {
  const box = sandbox(); enable(box);
  observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env });
  const target = `${box.storePath}.target`;
  renameSync(box.storePath, target);
  symlinkSync(target, box.storePath);
  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, "unavailable");
  assert.throws(() => readRuntimeErrorSnapshot({ env: box.env }));
});

test("stale lockは診断を偽greenにせず、死んだwriterだけを次のmutationで回収する", { skip: process.platform === "win32" }, () => {
  const box = sandbox(); enable(box);
  observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env });
  const lockPath = `${box.storePath}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, created_at: "2026-07-13T00:00:00.000Z" }), { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath, old, old);

  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, "unavailable");
  assert.equal(observeRuntimeError({ code: "CDP_UNAVAILABLE" }, { env: box.env }).status, "recorded");
  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, "ready");
});

test("生存writerのlockは古くても奪わず診断をunavailableにする", { skip: process.platform === "win32" }, () => {
  const box = sandbox(); enable(box);
  observeRuntimeError({ code: "CHAT_FAILED" }, { env: box.env });
  const lockPath = `${box.storePath}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, created_at: "2026-07-13T00:00:00.000Z" }), { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath, old, old);

  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, "unavailable");
  assert.throws(() => observeRuntimeError({ code: "CDP_UNAVAILABLE" }, { env: box.env }), { code: "EEXIST" });
  assert.equal(statSync(lockPath).isFile(), true);
});
