import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createLocalClientClock } from "../src/window-handoff-local-clock.js";
const createClock: typeof createLocalClientClock = process.env.EXPIRY_PROBE_REPO
  ? (await import(pathToFileURL(`${process.env.EXPIRY_PROBE_REPO}/src/window-handoff-local-clock.ts`).href)).createLocalClientClock
  : createLocalClientClock;

function fixture() {
  let raw = 10000, mono = 100;
  const timers = new Map<object, () => void>(), callbacks: (() => void)[] = [];
  const clock = createClock({ utcNow: () => raw, monotonicNow: () => mono,
    setTimer(callback) { const key = {}; timers.set(key, callback); callbacks.push(callback); return key; },
    clearTimer(key) { timers.delete(key as object); },
  });
  return { clock, timers, callbacks, set: (utc: number, performance: number) => { raw = utc; mono = performance; } };
}
for (const purpose of ["request", "cleanup"] as const) for (const observedBy of ["remaining", "timer", "now"] as const) {
  test(`${purpose} forward expiry observed by ${observedBy} survives rollback/re-registration`, () => {
    const f = fixture();
    const token = purpose === "request" ? f.clock.startRequest(10250) : f.clock.startCleanup(250);
    let fired = 0;
    if (observedBy === "timer") f.clock.atBudget(token, () => { fired++; });
    f.set(10251, 120);
    if (observedBy === "remaining") assert.throws(() => f.clock.remaining(token), { code: "HANDOFF_EXPIRED" });
    else if (observedBy === "timer") f.callbacks[0]!(); else assert.equal(f.clock.now(), 10251);
    f.set(10000, 121);
    let remainsExpired = false;
    try { f.clock.remaining(token); } catch { remainsExpired = true; }
    const prior = fired;
    f.clock.atBudget(token, () => { fired++; });
    console.log(JSON.stringify({ purpose, observedBy, remainsExpired, firedBefore: prior, firedAfter: fired, pending: f.timers.size, rawNow: f.clock.now(), realIO: 0 }));
    assert.equal(remainsExpired, true);
    assert.equal(fired, prior + 1); assert.equal(f.timers.size, 0); assert.equal(f.clock.now(), 10000);
  });
}
test("old request expiry does not poison a new legitimate cleanup token", () => {
  const f = fixture(), old = f.clock.startRequest(10250);
  f.set(10251, 120); assert.throws(() => f.clock.remaining(old), { code: "HANDOFF_EXPIRED" });
  f.set(10000, 121);
  const cleanup = f.clock.startCleanup(250);
  assert.deepEqual(f.clock.remaining(cleanup), { absoluteDeadline: 10250, maximumWaitMs: 250 });
  assert.throws(() => f.clock.remaining(old), { code: "HANDOFF_EXPIRED" });
  assert.equal(f.clock.now(), 10000);
});
