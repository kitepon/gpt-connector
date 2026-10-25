import assert from "node:assert/strict";
import test from "node:test";
import { prepareOwnedWindowHandoff, WindowHandoffInputError, type ArmedWindowWatch,
  type FreshWindowCapture, type WindowHandoffInputPorts } from "../src/window-handoff-input.js";

function fixture() {
  const base = Date.parse("2026-10-25T09:00:00.000Z");
  let time = base + 100;
  const calls: string[] = [];
  const profile = "C:\\private\\browser-profile";
  const control = new AbortController();
  const identity = { pid: 123, createdAt: "2026-10-25T09:00:00.000Z", ownerSid: "S-1-5-21-1", sessionId: 1, hwnd: "456" };
  const watch: ArmedWindowWatch = { watchId: "local-fixture-watch", hostRegistrationId: "a".repeat(32),
    expiresAt: base + 1000, identity, signal: control.signal };
  const capture: FreshWindowCapture = { identity: { ...identity }, observedAt: base + 150,
    listener: { pid: "123", command: "fixture-only", executable: "C:\\Chrome\\chrome.exe", args: ["C:\\Chrome\\chrome.exe",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`] },
    candidateWindowCount: 1, providerPageCount: 1, windowClass: "Chrome_WidgetWin_1", visible: true,
    minimized: false, targetId: "fixture-cdp-target", browserWindowId: 7 };
  const ports: WindowHandoffInputPorts = {
    async beginWatch(hint, deadline) { assert.equal(hint, "456"); assert.equal(deadline, base + 1000); calls.push("armed"); return watch; },
    async assertCurrent(actual, deadline) { assert.equal(actual, watch); assert.equal(deadline, base + 1000); calls.push("assert"); },
    async capture(actual, deadline) { assert.equal(actual, watch); assert.equal(deadline, base + 1000); calls.push("capture"); time = base + 150; return capture; },
    async bindTarget(actual, binding, deadline) {
      assert.equal(actual, watch); assert.equal(deadline, base + 1000); assert.ok(Object.isFrozen(binding));
      assert.deepEqual(Object.keys(binding).sort(), ["browserWindowId", "identity", "observedAt", "targetId"]);
      assert.ok(!JSON.stringify(binding).includes(profile)); calls.push("bind");
    },
    async cancelWatch(actual) { assert.equal(actual, watch); calls.push("cancel"); },
  };
  const run = () => prepareOwnedWindowHandoff({ hint: "456", profile, deadline: base + 1000 }, ports, () => time);
  return { base, ports, run, watch, capture, calls, control, setTime: (v: number) => { time = base + v; } };
}
const code = (expected: string) => (error: unknown) => error instanceof WindowHandoffInputError && error.code === expected;

test("Host watchArmed precedes new capture and immutable bind; original watch and deadline survive final guard", async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(f.calls, ["armed", "assert", "capture", "assert", "bind", "assert"]);
  assert.equal(result.watch, f.watch); assert.equal(result.deadline, f.base + 1000);
  assert.equal(result.binding.observedAt, f.base + 150); assert.ok(Object.isFrozen(result.binding.identity));
  assert.equal("requestId" in result, false); // No offer, URL or network authorization is emitted.
});

test("PID reuse, stale capture, wrong profile and ambiguous windows never reach bind", async () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.capture.identity.createdAt = "2026-10-25T09:01:00.000Z"; },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.capture, { observedAt: f.base + 99 }); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.capture.listener, { args: ["C:\\Chrome\\chrome.exe", "--user-data-dir=C:\\other"] }); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.capture, { candidateWindowCount: 2 }); },
  ]) {
    const f = fixture(); mutation(f);
    await assert.rejects(f.run(), code("HANDOFF_BINDING_INVALID"));
    assert.equal(f.calls.includes("bind"), false); assert.equal(f.calls.at(-1), "cancel");
  }
});

test("same-PID same-HWND reuse requires the original Host anchor; no marker recreation or fallback", async () => {
  const f = fixture(); let assertions = 0;
  f.ports.assertCurrent = async () => { if (++assertions === 2) throw new Error("private OS anchor destroyed"); };
  await assert.rejects(f.run(), code("HANDOFF_UNSUPPORTED"));
  assert.equal(f.calls.includes("bind"), false); assert.equal(f.calls.filter(v => v === "armed").length, 1);
  assert.equal(f.calls.at(-1), "cancel");
});

test("missing or lost monitoring stops before bind instead of treating attributes as lifetime proof", async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    if (missing) Object.assign(f.watch, { signal: undefined });
    else f.ports.capture = async () => { f.control.abort(); return f.capture; };
    await assert.rejects(f.run(), code(missing ? "HANDOFF_UNSUPPORTED" : "HANDOFF_BINDING_INVALID"));
    assert.equal(f.calls.includes("bind"), false); assert.equal(f.calls.at(-1), "cancel");
  }
});

test("receipt after original deadline rejects both late capture and late bind without extending admission", async () => {
  for (const stage of ["capture", "bind"] as const) {
    const f = fixture();
    if (stage === "capture") f.ports.capture = async () => { f.setTime(1015); return f.capture; };
    else f.ports.bindTarget = async (_watch, _binding, deadline) => { assert.equal(deadline, f.base + 1000); f.calls.push("bind"); f.setTime(1015); };
    await assert.rejects(f.run(), code("HANDOFF_EXPIRED"));
    assert.equal(f.calls.filter(v => v === "bind").length, stage === "bind" ? 1 : 0);
    assert.equal(f.calls.at(-1), "cancel");
  }
});

test("generation mutation during final verification rejects the already returned bind receipt", async () => {
  const f = fixture(); let assertions = 0;
  f.ports.assertCurrent = async () => { if (++assertions === 3) Object.assign(f.watch, { hostRegistrationId: "b".repeat(32) }); };
  await assert.rejects(f.run(), code("HANDOFF_BINDING_INVALID")); assert.equal(f.calls.at(-1), "cancel");
});

test("unconfirmed owner cleanup stays explicit and never exposes a private port exception", async () => {
  const f = fixture(); f.ports.capture = async () => { throw new Error("secret transport body"); };
  f.ports.cancelWatch = async () => { throw new Error("secret OS principal"); };
  await assert.rejects(f.run(), error => code("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED")(error)
    && !String(error).includes("secret"));
});
