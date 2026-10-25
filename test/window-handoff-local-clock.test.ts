import assert from "node:assert/strict";
import test from "node:test";
import { createLocalClientClock } from "../src/window-handoff-local-clock.js";
import type { LocalClockSources } from "../src/window-handoff-local-clock.js";
import { PromiseWindowHandoffClient } from "../src/window-handoff-promise-client.js";
import { decodeLocalRequest, encodeLocalReply } from "../src/window-handoff-local-codec.js";
import type { LocalAuthenticatedChannel, LocalExchangeResult } from "../src/window-handoff-session-port.js";

function fixture() {
  let utc = 10000, mono = 100;
  const pending = new Map<object, { at: number; callback: () => void }>();
  const callbacks: (() => void)[] = [], delays: number[] = [];
  const api: LocalClockSources = {
    utcNow: () => utc, monotonicNow: () => mono,
    setTimer(callback, delay) { const token = {}; pending.set(token, { at: mono + delay, callback }); callbacks.push(callback); delays.push(delay); return token; },
    clearTimer(token) { pending.delete(token as object); },
  };
  const clock = createLocalClientClock(api);
  return { api, clock, pending, callbacks, delays,
    set: (nextUtc: number, nextMono: number) => { utc = nextUtc; mono = nextMono; },
    wake() { for (const [token, timer] of [...pending]) if (mono >= timer.at) { pending.delete(token); timer.callback(); } },
  };
}

test("UTC rollback and repeated reads cannot move the original monotonic deadline", () => {
  const f = fixture(); let fired = 0;
  f.clock.at(11000, () => { fired++; });
  f.set(5000, 600);
  for (let i = 0; i < 8; i++) assert.equal(f.clock.now(), 10500); // Deadline epoch, not raw observation UTC.
  assert.deepEqual(f.delays, [1000]); assert.equal(fired, 0);
  f.set(5000, 1100); f.wake();
  assert.equal(fired, 1); assert.equal(f.pending.size, 0);
});

test("early timer delivery reuses the fixed deadline and duplicate old delivery is inert", () => {
  const f = fixture(); let fired = 0;
  f.clock.at(11000, () => { fired++; });
  const old = f.callbacks[0]!;
  f.set(10300, 400); old(); // Early/spurious driver wake.
  assert.deepEqual(f.delays, [1000, 700]); assert.equal(fired, 0);
  old(); assert.deepEqual(f.delays, [1000, 700]);
  f.set(10500, 1100); f.wake();
  assert.equal(fired, 1); f.callbacks.at(-1)!(); assert.equal(fired, 1);
});

test("forward UTC at an admission read or timer wake expires before the monotonic limit", () => {
  for (const trigger of ["read", "wake"] as const) {
    const f = fixture(); let fired = 0;
    f.clock.at(11000, () => { fired++; });
    f.set(12000, 200);
    if (trigger === "read") assert.equal(f.clock.now(), 12000); else f.callbacks[0]!();
    assert.equal(fired, 1); assert.equal(f.pending.size, 0);
    f.callbacks[0]!(); assert.equal(fired, 1);
  }
});

test("registration cancellation/disposal unlinks callback and timer, including ghost delivery", () => {
  const f = fixture(); let fired = 0;
  const dispose = f.clock.at(11000, () => { fired++; });
  dispose(); dispose();
  assert.equal(f.pending.size, 0);
  f.set(12000, 1200); f.callbacks[0]!(); f.clock.now();
  assert.equal(fired, 0);
});

test("an already expired registration fires once synchronously without allocating a timer", () => {
  const f = fixture(); let fired = 0;
  const cancel = f.clock.at(10000, () => { fired++; });
  cancel(); assert.equal(fired, 1); assert.equal(f.delays.length, 0); assert.equal(f.pending.size, 0);
});

test("release occurs before foreign callback reentry creates another registration", () => {
  const f = fixture(); let first = 0, second = 0;
  f.clock.at(11000, () => {
    first++; assert.equal(f.pending.size, 0);
    f.clock.now(); f.clock.at(11100, () => { second++; });
  });
  f.set(11000, 1100); f.wake(); assert.equal(first, 1); assert.equal(second, 0);
  f.set(11100, 1200); f.wake(); assert.equal(second, 1); assert.equal(f.pending.size, 0);
});

test("cancel versus deadline at the boundary settles at most once in either order", () => {
  for (const first of ["cancel", "deadline"] as const) {
    const f = fixture(); let fired = 0;
    const cancel = f.clock.at(11000, () => { fired++; });
    const callback = f.callbacks[0]!; f.set(11000, 1100);
    if (first === "cancel") { cancel(); callback(); } else { f.wake(); cancel(); }
    callback(); f.clock.now();
    assert.equal(fired, first === "cancel" ? 0 : 1); assert.equal(f.pending.size, 0);
  }
});

test("synchronous timer callback cannot leave its not-yet-published handle alive", () => {
  let utc = 10000, mono = 100, cleared = 0, fired = 0;
  const token = {};
  const clock = createLocalClientClock({ utcNow: () => utc, monotonicNow: () => mono,
    setTimer(callback) { utc = 11000; mono = 1100; callback(); return token; },
    clearTimer(handle) { assert.strictEqual(handle, token); cleared++; },
  });
  clock.at(11000, () => { fired++; });
  assert.equal(fired, 1); assert.equal(cleared, 1);
});

test("long waits cap each Node timer without refreshing the fixed final deadline", () => {
  const f = fixture(), max = 2147483647; let fired = 0;
  f.clock.at(10000 + max + 13, () => { fired++; });
  assert.deepEqual(f.delays, [max]);
  f.set(10000, 100 + max); f.wake(); assert.deepEqual(f.delays, [max, 13]);
  f.set(10000, 100 + max + 13); f.wake(); assert.equal(fired, 1); assert.equal(f.pending.size, 0);
});

test("rollback between completed RPC waits cannot give the original UTC deadline another budget", () => {
  const f = fixture(); let fired = 0;
  const firstReceipt = f.clock.at(11000, () => { fired++; });
  f.set(10200, 300); firstReceipt(); // The first RPC completed before the original deadline.
  f.set(5000, 1101);
  assert.equal(f.clock.now(), 11001);
  f.clock.at(11000, () => { fired++; });
  assert.equal(fired, 1); assert.equal(f.pending.size, 0); // No new wait for that expired deadline.
  const cleanup = f.clock.at(f.clock.now() + 250, () => { fired++; });
  assert.equal(f.pending.size, 1); cleanup(); assert.equal(fired, 1);
});

test("a late begin reply after UTC forward jump is not adopted; owner cancel stays separate", async () => {
  const f = fixture(), session = {}, closed = new AbortController(), lost = new AbortController(), native = new AbortController();
  const tuple = { watchId: "clock-fixture", hostRegistrationId: "a".repeat(32), expiresAt: 11000,
    identity: { pid: 30, createdAt: "1970-01-01T00:00:00.0010000Z", ownerSid: "S-1-5-21-1", sessionId: 1, hwnd: "40" } };
  const wait = Promise.withResolvers<LocalExchangeResult>();
  const calls: string[] = [];
  const channel: LocalAuthenticatedChannel = { session, hostRegistrationId: tuple.hostRegistrationId, closed: closed.signal,
    subscribeControl() { return { lost: lost.signal, dispose() { lost.abort(); } }; }, async close() { closed.abort(); },
    async exchange(bytes, options) {
      const request = decodeLocalRequest(bytes); calls.push(request.kind);
      if (request.kind === "begin_watch") return wait.promise;
      assert.equal(request.kind, "cancel_watch"); assert.equal(options.purpose, "cleanup");
      if (request.kind !== "cancel_watch") throw new Error("fixture");
      return { kind: "reply", session, bytes: encodeLocalReply({ version: 1, callId: request.callId, outcome: "cancelled", reference: request.reference }) };
    } };
  const client = new PromiseWindowHandoffClient({ channel, clock: f.clock, cleanupBudgetMs: 250,
    capture: async () => { throw new Error("capture must not run"); } });
  const outcome = assert.rejects(client.beginWatch("40", 11000), { code: "HANDOFF_EXPIRED" });
  assert.deepEqual(calls, ["begin_watch"]);
  f.set(11001, 200);
  wait.resolve({ kind: "reply", session, bytes: encodeLocalReply({ version: 1, callId: 1, outcome: "armed", watch: tuple }),
    watchLifetime: { session, beginCallId: 1, originalTuple: tuple, invalidated: native.signal } });
  await outcome;
  assert.deepEqual(calls, ["begin_watch", "cancel_watch"]); assert.equal(client.cleanupState, "confirmed");
  assert.equal(f.pending.size, 0);
});
