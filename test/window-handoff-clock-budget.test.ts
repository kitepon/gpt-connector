import assert from "node:assert/strict";
import test from "node:test";
import { createLocalClientClock } from "../src/window-handoff-local-clock.js";
import { PromiseWindowHandoffClient } from "../src/window-handoff-promise-client.js";
import { decodeLocalRequest, encodeLocalReply } from "../src/window-handoff-local-codec.js";
import type { LocalAuthenticatedChannel } from "../src/window-handoff-session-port.js";

function fixture() {
  let utc = 10000, mono = 100;
  const timers = new Map<object, () => void>(), callbacks: (() => void)[] = [];
  const clock = createLocalClientClock({ utcNow: () => utc, monotonicNow: () => mono,
    setTimer(callback) { const key = {}; timers.set(key, callback); callbacks.push(callback); return key; },
    clearTimer(key) { timers.delete(key as object); },
  });
  return { clock, timers, callbacks, set: (raw: number, performance: number) => { utc = raw; mono = performance; } };
}

test("raw UTC stays raw; the same request token expires across RPC rollback", () => {
  const f = fixture(), token = f.clock.startRequest(11000);
  const firstRpcDone = f.clock.atBudget(token, () => assert.fail("not yet due"));
  f.set(10200, 300); firstRpcDone();
  f.set(5000, 1101); assert.equal(f.clock.now(), 5000);
  assert.throws(() => f.clock.remaining(token), { code: "HANDOFF_EXPIRED" });
  let expired = 0; f.clock.atBudget(token, () => { expired++; });
  assert.equal(expired, 1); assert.equal(f.timers.size, 0);
});

test("cleanup after rollback has raw absolute5250 and separate250ms token", () => {
  const f = fixture(); f.clock.startRequest(12000);
  f.set(5000, 1101);
  const token = f.clock.startCleanup(250);
  assert.deepEqual(f.clock.remaining(token), { absoluteDeadline: 5250, maximumWaitMs: 250 });
  f.set(4000, 1131);
  const wait = f.clock.remaining(token);
  assert.deepEqual(wait, { absoluteDeadline: 5250, maximumWaitMs: 220 });
  assert.equal(Math.min(wait.maximumWaitMs, wait.absoluteDeadline - 4000), 220);
});

test("cleanup rollback cannot extend its token; cap floors without a minimum1ms refresh", () => {
  const f = fixture(), token = f.clock.startCleanup(250);
  f.set(5000, 200); assert.deepEqual(f.clock.remaining(token), { absoluteDeadline: 10250, maximumWaitMs: 150 });
  f.set(5000, 349.25);
  assert.throws(() => f.clock.remaining(token), { code: "HANDOFF_EXPIRED" });
  let fired = 0; f.clock.atBudget(token, () => { fired++; });
  assert.equal(fired, 1); assert.equal(f.timers.size, 0);
});

test("raw UTC forward expires admission and removes timer/callback once", () => {
  const f = fixture(), token = f.clock.startCleanup(250); let fired = 0;
  f.clock.atBudget(token, () => { fired++; });
  f.set(10251, 120); assert.equal(f.clock.now(), 10251);
  assert.equal(fired, 1); assert.equal(f.timers.size, 0);
  f.callbacks[0]!(); assert.equal(fired, 1);
  assert.throws(() => f.clock.remaining(token), { code: "HANDOFF_EXPIRED" });
});

test("per-purpose bounds and foreign/copied tokens cannot create a budget", () => {
  const f = fixture();
  assert.throws(() => f.clock.startRequest(130001), { code: "HANDOFF_CLOCK_INVALID" });
  for (const ms of [0, 30001, 0.5]) assert.throws(() => f.clock.startCleanup(ms));
  const token = f.clock.startRequest(130000);
  assert.equal(f.clock.remaining(token).maximumWaitMs, 120000);
  assert.throws(() => f.clock.remaining({ ...token }), { code: "HANDOFF_CLOCK_INVALID" });
  assert.throws(() => fixture().clock.remaining(token), { code: "HANDOFF_CLOCK_INVALID" });
});

test("cancel destroys one timer registration while preserving the original token", () => {
  const f = fixture(), token = f.clock.startCleanup(250); let fired = 0;
  const cancel = f.clock.atBudget(token, () => { fired++; });
  cancel(); cancel(); f.callbacks[0]!(); assert.equal(fired, 0); assert.equal(f.timers.size, 0);
  f.set(5000, 200);
  assert.equal(f.clock.remaining(token).maximumWaitMs, 150); // Never mint another250.
  f.clock.atBudget(token, () => { fired++; });
  f.set(5000, 350); f.callbacks.at(-1)!(); assert.equal(fired, 1); assert.equal(f.timers.size, 0);
});

test("mono expiry during final receipt inspection never publishes armed and cancels its received tuple", async () => {
  const f = fixture(), session = {}, eof = new AbortController(), lost = new AbortController(), native = new AbortController();
  let replied = false, reads = 0, cancelMode: string | undefined;
  const rawNow = f.clock.now.bind(f.clock);
  f.clock.now = () => {
    if (replied && ++reads === 2) f.set(5000, 1101); // Inside receipt validation, after pre-adoption token check.
    return rawNow();
  };
  const tuple = { watchId: "final-clock", hostRegistrationId: "a".repeat(32), expiresAt: 11000,
    identity: { pid: 30, createdAt: "1970-01-01T00:00:00.0010000Z", ownerSid: "S-1-5-21-1", sessionId: 1, hwnd: "40" } };
  const channel: LocalAuthenticatedChannel = { session, hostRegistrationId: tuple.hostRegistrationId, closed: eof.signal,
    subscribeControl() { return { lost: lost.signal, dispose() { lost.abort(); } }; }, async close() { eof.abort(); },
    async exchange(bytes, wait) {
      const request = decodeLocalRequest(bytes);
      if (request.kind === "cancel_watch") {
        cancelMode = request.reference.mode; assert.equal(wait.purpose, "cleanup");
        return { kind: "reply", session, bytes: encodeLocalReply({ version: 1, callId: request.callId, outcome: "cancelled", reference: request.reference }) };
      }
      replied = true;
      return { kind: "reply", session, bytes: encodeLocalReply({ version: 1, callId: request.callId, outcome: "armed", watch: tuple }),
        watchLifetime: { session, beginCallId: request.callId, originalTuple: tuple, invalidated: native.signal } };
    } };
  const client = new PromiseWindowHandoffClient({ channel, clock: f.clock, cleanupBudgetMs: 250,
    capture: async () => { throw new Error("must not capture"); } });
  await assert.rejects(client.beginWatch("40", 11000), { code: "HANDOFF_EXPIRED" });
  assert.equal(cancelMode, "watch"); assert.equal(client.cleanupState, "confirmed");
});
