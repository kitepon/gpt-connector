import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createCoreProcessBridge } from "../src/update-ledger-core-process-bridge.js";
import type { CoreHelperLaunch, FixedCoreHelperBootstrap } from "../src/update-ledger-core-process-bridge.js";
import { createProductCoreObserver, createCoreWriteObserver } from "../src/update-ledger-core-observer.js";
import { createPublicJsonFrame } from "../src/public-json.js";
import { setupNext } from "../src/setup-public-text.js";

const runtime = { pid: 222, ppid: 111, uid: 1000, gid: 1000, cwd: "/fixture", exec_path: "/fixture/node",
  process_version: "v24.22.1", entry_path: "/fixture/core" };
const control = () => ({ mode: "setup" as const, run_id: "123e4567-e89b-42d3-a456-426614174001", runtime_self: { ...runtime } });
const unknown = { status: "unknown", reason: "fixture_authority_unavailable", result_original: null,
  normal_job_binding: "unknown_until_dispatcher_source_correlation", reporting_allowed: false, resource_read_authorized: false };

function childFixture() {
  const events = new EventEmitter(), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), reply = new PassThrough();
  const received: Buffer[] = [];
  stdin.on("data", chunk => received.push(Buffer.from(chunk)));
  let kills = 0;
  const child = Object.assign(events, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, reply],
    kill(signal: string) { assert.equal(signal, "SIGKILL"); kills++; return true; } }) as unknown as ChildProcess;
  return { child, stdin, stdout, stderr, reply, events, get body() { return Buffer.concat(received); }, get kills() { return kills; },
    async finish(bytes: Uint8Array = Buffer.from(`${JSON.stringify(unknown)}\n`), code = 0) {
      reply.end(bytes); stdout.end(); stderr.end();
      await new Promise<void>(resolve => setImmediate(resolve));
      events.emit("exit", code, null); events.emit("close", code, null);
    } };
}
const noTimeout = () => () => {};

test("bootstrap sees one exact immutable control string and owned original frame", async () => {
  for (const phase of ["core_begin", "core_result"] as const) {
    const fixture = childFixture(), source = control(), frame = new Uint8Array([123, 125, 10]);
    const expected = JSON.stringify(source); let serializations = 0, invocation: CoreHelperLaunch | undefined;
    Object.defineProperty(source, "toJSON", { value() { serializations++; return { mode: source.mode, run_id: source.run_id, runtime_self: source.runtime_self }; } });
    const bridge = createCoreProcessBridge({ start(value) {
      invocation = value; assert.equal(Object.isFrozen(value), true);
      Object.assign(source.runtime_self, { entry_path: "/fixture/changed" }); frame.fill(0);
      return fixture.child;
    } }, { scheduleTimeout: noTimeout });
    const pending = bridge.exchange(phase, source, phase === "core_begin" ? null : frame);
    await fixture.finish(); assert.deepEqual(await pending, unknown);
    assert.equal(serializations, 1); assert.equal(invocation?.controlJson, expected);
    assert.equal(invocation?.replyFd, 3); assert.equal(invocation?.authorityFd, 4); assert.equal(invocation?.timeoutMs, 2500);
    assert.deepEqual(fixture.body, phase === "core_begin" ? Buffer.alloc(0) : Buffer.from([123, 125, 10]));
  }
});

test("new process bridge composes with the owned observer frame/write without changing ordinary text", async () => {
  const ref = { ref: "fixture-original", sha256: "a".repeat(64), bytes: 10 };
  const calls: { invocation: CoreHelperLaunch; fixture: ReturnType<typeof childFixture> }[] = [];
  const bridge = createCoreProcessBridge({ start(invocation) {
    const fixture = childFixture(); calls.push({ invocation, fixture });
    const request = JSON.parse(invocation.controlJson);
    const result = invocation.phase === "core_begin" ? {
      status: "recorded_raw", kind: "fixture_core", original: ref,
      kernel_identity: { boot_id: "123e4567-e89b-42d3-a456-426614174000", pid: runtime.pid, start_ticks: "99",
        effective_uid: runtime.uid, effective_gid: runtime.gid, cwd: runtime.cwd, executable_realpath: runtime.exec_path },
      launcher_identity: "fixture:launcher", public_setup_before: ref,
      normal_job_binding: unknown.normal_job_binding, reporting_allowed: false, resource_read_authorized: false,
    } : { status: "recorded_raw", kind: "fixture_core", original: ref,
      result_original: { ref: "fixture-frame", sha256: request.completion.serialized_result_sha256, bytes: request.completion.serialized_result_bytes },
      normal_job_binding: unknown.normal_job_binding, reporting_allowed: false, resource_read_authorized: false };
    queueMicrotask(() => { void fixture.finish(Buffer.from(`${JSON.stringify(result)}\n`)); });
    return fixture.child;
  } }, { scheduleTimeout: noTimeout });
  const observer = createProductCoreObserver(bridge, { ownRuntime: () => ({ ...runtime }), now: () => 1000, uuid: () => control().run_id });
  const run = await observer.beginOwnCore("setup", runtime); assert.ok("token" in run);
  const frame = createPublicJsonFrame({ schema: "gpt-connector.setup.v1", version: "0.16.4", overall: "partial", package: "ready",
    registrations: [{ client: "grok", path: "/fixture/config", mcp: "not_checked" }], live: { supported: false }, next: setupNext });
  const normalText = frame.text, write = createCoreWriteObserver(frame, 2, () => 1000);
  let ordinaryWrites = 0; ordinaryWrites++; write.callback();
  const outcome = await observer.completeOwnCore(run, await write.completed);
  assert.equal(outcome.status, "recorded_raw"); assert.equal(ordinaryWrites, 1); assert.equal(frame.text, normalText);
  assert.equal(calls.length, 2); assert.equal(calls[0]!.fixture.body.length, 0);
  assert.equal(calls[1]!.fixture.body.toString(), normalText);
  assert.equal(JSON.parse(calls[1]!.invocation.controlJson).completion.exit_code, 2);
  assert.equal(outcome.status === "recorded_raw" && outcome.reporting_allowed, false);
});

test("no-body completion preserves the helper's unknown reason", async () => {
  const fixture = childFixture();
  const bridge = createCoreProcessBridge({ start: () => fixture.child }, { scheduleTimeout: noTimeout });
  const pending = bridge.exchange("core_result", control(), null);
  await fixture.finish(); assert.deepEqual(await pending, unknown); assert.equal(fixture.body.length, 0);
});

test("partial, oversize, malformed, stdout and failed process outputs cannot become a reply", async () => {
  for (const mode of ["partial", "oversize", "utf8", "newline", "two-json", "array", "stdout", "exit", "missing-fd3"]) {
    const fixture = childFixture();
    if (mode === "missing-fd3") fixture.child.stdio[3] = null;
    const bridge = createCoreProcessBridge({ start: () => fixture.child }, { scheduleTimeout: noTimeout });
    const pending = bridge.exchange("core_result", control(), null);
    const rejected = assert.rejects(pending, /core_helper_/u);
    if (mode === "partial") { fixture.events.emit("exit", 0, null); fixture.events.emit("close", 0, null); }
    else if (mode !== "missing-fd3") {
      if (mode === "stdout") fixture.stdout.write("private-sentinel");
      const bytes = mode === "oversize" ? Buffer.alloc(16385) : mode === "utf8" ? Buffer.from([255, 10])
        : mode === "newline" ? Buffer.from("{}") : mode === "two-json" ? Buffer.from("{}\n{}\n")
        : mode === "array" ? Buffer.from("[]\n") : Buffer.from("{}\n");
      await fixture.finish(bytes, mode === "exit" ? 1 : 0);
    }
    await rejected;
  }
});

test("timeout, late completion and failed signalling remain unknown", async () => {
  for (const killFails of [false, true]) {
    const fixture = childFixture(); let expire = () => {};
    if (killFails) fixture.child.kill = () => false;
    const bridge = createCoreProcessBridge({ start: () => fixture.child }, { scheduleTimeout: (ms, callback) => {
      assert.equal(ms, 2500); expire = callback; return () => {};
    } });
    const pending = bridge.exchange("core_result", control(), null);
    const rejected = assert.rejects(pending, killFails ? /core_helper_cleanup_unconfirmed/u : /core_helper_timeout/u);
    expire(); await fixture.finish(); await rejected;
    assert.equal(fixture.kills, killFails ? 0 : 1);
  }
});

test("oversize inputs and missing bootstrap cannot start a helper", async () => {
  let starts = 0;
  const bootstrap: FixedCoreHelperBootstrap = { start() { starts++; throw new Error("fixture-start-secret"); } };
  const bridge = createCoreProcessBridge(bootstrap, { scheduleTimeout: noTimeout });
  await assert.rejects(bridge.exchange("core_result", control(), new Uint8Array(65537)), /core_helper_input_invalid/u);
  await assert.rejects(bridge.exchange("core_begin", control(), new Uint8Array(0)), /core_helper_input_invalid/u);
  const oversized = control(); oversized.runtime_self.cwd = "x".repeat(16384);
  await assert.rejects(bridge.exchange("core_result", oversized, null), /core_helper_input_invalid/u);
  assert.equal(starts, 0);
  await assert.rejects(bridge.exchange("core_result", control(), null), /^Error: core_helper_start_failed$/u);
  assert.equal(starts, 1);
});
