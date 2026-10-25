import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { CoreHelperLaunch, FixedCoreHelperBootstrap } from "../src/update-ledger-core-process-bridge.js";
import type * as Registration from "../src/update-ledger-core-registration.js";
import { setupNext } from "../src/setup-public-text.js";

let sequence = 0;
const fresh = (): Promise<typeof Registration> => import(new URL(`../src/update-ledger-core-registration.ts?registration=${++sequence}`, import.meta.url).href);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const flags = { normal_job_binding: "unknown_until_dispatcher_source_correlation", reporting_allowed: false, resource_read_authorized: false };
const unknown = { status: "unknown", reason: "fixture_unconfirmed", result_original: null, ...flags };

function bootstrap(unknownBegin = false) {
  const calls: { invocation: CoreHelperLaunch; body: Buffer }[] = [];
  const port: FixedCoreHelperBootstrap = { start(invocation) {
    const child = new EventEmitter() as ChildProcess;
    const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough(), reply = new PassThrough();
    const row = { invocation, body: Buffer.alloc(0) }; calls.push(row);
    const chunks: Buffer[] = []; input.on("data", chunk => chunks.push(Buffer.from(chunk)));
    Object.assign(child, { stdin: input, stdout: output, stderr: errors, stdio: [input, output, errors, reply], kill: () => true });
    input.on("finish", () => {
      row.body = Buffer.concat(chunks);
      const control = JSON.parse(invocation.controlJson), self = control.runtime_self;
      const ref = { ref: "fixture-original", bytes: 12, sha256: "a".repeat(64) };
      const value = invocation.phase === "core_begin" ? unknownBegin ? unknown : {
        status: "recorded_raw", kind: "fixture_core", original: ref, public_setup_before: ref, launcher_identity: "fixture:launcher",
        kernel_identity: { boot_id: "123e4567-e89b-42d3-a456-426614174000", pid: self.pid, start_ticks: "99",
          effective_uid: self.uid, effective_gid: self.gid, cwd: self.cwd, executable_realpath: self.exec_path }, ...flags,
      } : control.completion.stdout_write === "callback_completed" ? {
        status: "recorded_raw", kind: "fixture_core", original: ref,
        result_original: { ref: "fixture-frame", bytes: row.body.length, sha256: createHash("sha256").update(row.body).digest("hex") }, ...flags,
      } : unknown;
      reply.end(`${JSON.stringify(value)}\n`);
      output.end(); errors.end();
      void (async () => { await tick(); child.emit("exit", 0, null); child.emit("close", 0, null); })();
    });
    return child;
  } };
  return { port, calls };
}
const result = (overall = "partial") => ({ schema: "gpt-connector.setup.v1", version: "0.16.4", overall,
  package: "ready", registrations: [{ client: "grok", path: "/fixture/config", mcp: "not_checked" }],
  live: { supported: false }, next: setupNext });

test("unregistered selection does not run setup or output and refuses a late registration", async () => {
  const registry = await fresh();
  assert.equal(await registry.runRegisteredCoreSetup("setup", async () => { throw new Error("must not execute"); }, {
    write() { throw new Error("must not write"); }, setExitCode() { throw new Error("must not set exit"); },
  }), false);
  assert.throws(() => registry.registerCoreHelperBootstrap(bootstrap().port), /registration_unavailable/);
});

test("registration reserves before a getter reenters and privately captures the original start", async () => {
  const registry = await fresh(), original = bootstrap(true);
  const port = { get start() {
    assert.throws(() => registry.registerCoreHelperBootstrap(original.port), /registration_unavailable/);
    return original.port.start;
  } };
  registry.registerCoreHelperBootstrap(port);
  assert.throws(() => registry.registerCoreHelperBootstrap(original.port), /registration_unavailable/);
  original.port.start = () => { throw new Error("late replacement"); };
  let writes = 0;
  assert.equal(await registry.runRegisteredCoreSetup("check", async () => result(), {
    write(_text, callback) { writes++; callback(); }, setExitCode(code) { assert.equal(code, 2); },
  }), true);
  assert.equal(original.calls.length, 1); assert.equal(writes, 1);
});

test("registered setup owns one result serialization/write and completes only after its callback", async () => {
  const registry = await fresh(), helper = bootstrap(); registry.registerCoreHelperBootstrap(helper.port);
  let executions = 0, serializations = 0, writes = 0, exitCode: number | undefined, callback: (() => void) | undefined, text = "";
  const original = result();
  const pending = registry.runRegisteredCoreSetup("setup", async () => {
    executions++; return { ...original, toJSON() { serializations++; return original; } };
  }, { write(value, done) { writes++; text = value; callback = () => done(); }, setExitCode(code) { exitCode = code; } });
  while (!callback) await tick();
  assert.equal(helper.calls.length, 1); assert.equal(serializations, 1); assert.equal(writes, 1); assert.equal(exitCode, 2);
  callback(); assert.equal(await pending, true);
  assert.equal(executions, 1); assert.equal(helper.calls.length, 2);
  assert.equal(text, `${JSON.stringify(original, null, 2)}\n`);
  assert.equal(helper.calls[1]!.body.toString(), text);
  const control = JSON.parse(helper.calls[1]!.invocation.controlJson);
  assert.equal(control.completion.exit_code, 2); assert.equal(control.completion.stdout_write, "callback_completed");
  assert.equal(control.run_id, JSON.parse(helper.calls[0]!.invocation.controlJson).run_id);
  await assert.rejects(registry.runRegisteredCoreSetup("setup", async () => { executions++; return original; }, {
    write() { writes++; }, setExitCode() {},
  }), /registration_consumed/);
  assert.equal(executions, 1); assert.equal(writes, 1);
});

test("failed original write keeps its exit and never supplies the frame body to a helper", async () => {
  const registry = await fresh(), helper = bootstrap(); registry.registerCoreHelperBootstrap(helper.port);
  let writes = 0;
  assert.equal(await registry.runRegisteredCoreSetup("check", async () => result("failed"), {
    write(_text, callback) { writes++; callback(new Error("fixture-write-failed")); }, setExitCode(code) { assert.equal(code, 1); },
  }), true);
  assert.equal(writes, 1); assert.equal(helper.calls.length, 2); assert.equal(helper.calls[1]!.body.length, 0);
  assert.equal(JSON.parse(helper.calls[1]!.invocation.controlJson).completion.stdout_write, "failed");
});

test("unknown begin preserves ordinary setup body/exit without fabricating a result observation", async () => {
  const registry = await fresh(), helper = bootstrap(true); registry.registerCoreHelperBootstrap(helper.port);
  let executed = 0, text = "";
  await registry.runRegisteredCoreSetup("setup", async () => { executed++; return result("ready"); }, {
    write(value, callback) { text = value; callback(); }, setExitCode(code) { assert.equal(code, 0); },
  });
  assert.equal(executed, 1); assert.equal(helper.calls.length, 1); assert.equal(text, `${JSON.stringify(result("ready"), null, 2)}\n`);
});

test("an original setup exception propagates once without a fabricated public frame", async () => {
  const registry = await fresh(), helper = bootstrap(true); registry.registerCoreHelperBootstrap(helper.port);
  const error = new Error("fixture-setup-error"); let executed = 0;
  await assert.rejects(registry.runRegisteredCoreSetup("setup", async () => { executed++; throw error; }, {
    write() { throw new Error("no result to write"); }, setExitCode() { throw new Error("no result exit"); },
  }), value => value === error);
  assert.equal(executed, 1); assert.equal(helper.calls.length, 1);
});
