import assert from "node:assert/strict";
import test from "node:test";
import { prepareOwnedWindowHandoff, WindowHandoffInputError, type ArmedWindowWatch,
  type FreshWindowCapture, type WindowHandoffInputPorts } from "../src/window-handoff-input.js";

function fixture() {
  const base = Date.parse("2026-10-25T09:00:00.000Z"); let now = base + 100;
  const original = new AbortController(); const lifetime = new AbortController();
  const profile = "C:\\private\\original-profile";
  const input = { hint: "456", profile, deadline: base + 1000, signal: original.signal };
  const identity = { pid: 123, createdAt: "2026-10-25T09:00:00.000Z", ownerSid: "S-1-5-21-1", sessionId: 1, hwnd: "456" };
  const watch: ArmedWindowWatch = { watchId: "fixture-watch", hostRegistrationId: "a".repeat(32),
    expiresAt: input.deadline, identity, signal: lifetime.signal };
  const capture: FreshWindowCapture = { identity: { ...identity }, observedAt: base + 150,
    listener: { pid: "123", command: "fixture-only", executable: "C:\\Chrome\\chrome.exe", args: ["C:\\Chrome\\chrome.exe",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`] },
    candidateWindowCount: 1, providerPageCount: 1, windowClass: "Chrome_WidgetWin_1", visible: true,
    minimized: false, targetId: "fixture-target", browserWindowId: 7 };
  let bind = 0; let cancel = 0; let begin = 0;
  const calls: { deadline: number; signal?: AbortSignal; hint?: string }[] = [];
  const ports: WindowHandoffInputPorts = {
    async beginWatch(hint, deadline, signal) { begin++; calls.push({ hint, deadline, signal }); return watch; },
    async assertCurrent(actual, deadline, signal) { assert.equal(actual, watch); calls.push({ deadline, signal }); },
    async capture(actual, deadline, signal) { assert.equal(actual, watch); calls.push({ deadline, signal }); now = base + 150; return capture; },
    async bindTarget(actual, _binding, deadline, signal) { assert.equal(actual, watch); calls.push({ deadline, signal }); bind++; },
    async cancelWatch(actual) { assert.equal(actual, watch); cancel++; },
  };
  const observe = async (scenario: string) => {
    let accepted = false; let errorCode: string | null = null;
    try { await prepareOwnedWindowHandoff(input, ports, () => now); accepted = true; }
    catch (error) { errorCode = error instanceof WindowHandoffInputError ? error.code : "unexpected_error"; }
    const result = { scenario, accepted, bind, cancel, begin, originalSignalAborted: original.signal.aborted, errorCode };
    console.log(JSON.stringify(result)); return result;
  };
  return { input, original, profile, ports, watch, capture, observe, calls, base };
}

test("capture-time caller profile replacement cannot adopt a different profile", async () => {
  const f = fixture(); const capture = f.ports.capture;
  f.ports.capture = async (...args) => {
    await Promise.resolve(); f.input.profile = "C:\\private\\other-profile";
    Object.assign(f.capture.listener, { args: ["C:\\Chrome\\chrome.exe", "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9223", `--user-data-dir=${f.input.profile}`] });
    return capture(...args);
  };
  const result = await f.observe("profile_alias_replaced");
  assert.equal(result.accepted, false); assert.equal(result.bind, 0); assert.equal(result.cancel, 1);
  assert.equal(result.errorCode, "HANDOFF_BINDING_INVALID");
});

test("original signal cancellation survives caller replacement of input.signal", async () => {
  const f = fixture(); const capture = f.ports.capture;
  f.ports.capture = async (...args) => {
    await Promise.resolve(); f.input.signal = new AbortController().signal; f.original.abort();
    return capture(...args);
  };
  const result = await f.observe("signal_alias_replaced");
  assert.equal(result.accepted, false); assert.equal(result.bind, 0); assert.equal(result.cancel, 1);
  assert.equal(result.originalSignalAborted, true); assert.equal(result.errorCode, "HANDOFF_UNSUPPORTED");
});

test("beginWatch-time hint replacement cannot follow a different HWND", async () => {
  const f = fixture(); const begin = f.ports.beginWatch;
  f.ports.beginWatch = async (...args) => {
    await Promise.resolve(); f.input.hint = "999"; f.watch.identity.hwnd = "999"; f.capture.identity.hwnd = "999";
    return begin(...args);
  };
  const result = await f.observe("hint_alias_replaced");
  assert.equal(result.accepted, false); assert.equal(result.bind, 0); assert.equal(result.cancel, 1);
  assert.equal(f.calls[0]?.hint, "456");
});

test("unchanged initial tuple binds once and every local port receives its original signal and deadline", async () => {
  const f = fixture(); const result = await f.observe("original_tuple_unchanged");
  assert.equal(result.accepted, true); assert.equal(result.bind, 1); assert.equal(result.cancel, 0);
  assert.equal(result.begin, 1); assert.equal(Object.isFrozen(f.input), false);
  for (const call of f.calls) { assert.equal(call.signal, f.original.signal); assert.equal(call.deadline, f.base + 1000); }
  assert.equal(f.input.profile, f.profile);
});
