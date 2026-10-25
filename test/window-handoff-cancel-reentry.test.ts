import { fixtureDeadlineClock } from "./fixtures/local-deadline-clock.js";
import assert from "node:assert/strict";
import test from "node:test";
import { PromiseWindowHandoffClient } from "../src/window-handoff-promise-client.js";
import { decodeLocalRequest, encodeLocalReply } from "../src/window-handoff-local-codec.js";
import type { LocalAuthenticatedChannel } from "../src/window-handoff-session-port.js";

for (const stimulus of ["direct", "native"] as const) for (const outcome of ["confirmed", "unknown"] as const) {
  test(`cancel reservation precedes synchronous ${stimulus} reentry, cleanup ${outcome}`, async () => {
    const session = {}, closed = new AbortController(), lost = new AbortController(), native = new AbortController();
    const tuple = { watchId: "reentry-fixture", hostRegistrationId: "a".repeat(32), expiresAt: 2000,
      identity: { pid: 30, createdAt: "1970-01-01T00:00:00.0010000Z", ownerSid: "S-1-5-21-1", sessionId: 1, hwnd: "40" } };
    let now = 1000, entered = false;
    let nested: Promise<void> | undefined;
    const calls: { callId: number; kind: string; deadline: number; originalAbortPresent: boolean; reference?: unknown }[] = [];
    const reenter = () => { nested = client.cancelWatch(watch); };
    native.signal.addEventListener("abort", reenter, { once: true });
    const channel: LocalAuthenticatedChannel = {
      session, hostRegistrationId: tuple.hostRegistrationId, closed: closed.signal,
      subscribeControl() { return { lost: lost.signal, dispose() { lost.abort(); } }; },
      async close() { closed.abort(); },
      async exchange(bytes, wait) {
        const request = decodeLocalRequest(bytes);
        calls.push({ callId: request.callId, kind: request.kind, deadline: wait.absoluteDeadline,
          originalAbortPresent: "originalAbort" in wait, reference: request.kind === "cancel_watch" ? request.reference : undefined });
        if (request.kind === "cancel_watch") {
          if (!entered) {
            entered = true; now = 1010; // A second cleanup would incorrectly allocate deadline1260.
            if (stimulus === "native") native.abort(); else reenter();
          }
          if (outcome === "unknown") return { kind: "failure", reason: "offline", delivery: "unknown" };
          return { kind: "reply", session, bytes: encodeLocalReply({ version: 1, callId: request.callId,
            outcome: "cancelled", reference: request.reference }) };
        }
        return { kind: "reply", session, bytes: encodeLocalReply({ version: 1, callId: request.callId, outcome: "armed", watch: tuple }),
          watchLifetime: { session, beginCallId: request.callId, originalTuple: tuple, invalidated: native.signal } };
      },
    };
    const client = new PromiseWindowHandoffClient({ channel, clock: fixtureDeadlineClock({ now: () => now, at: () => () => {} }), cleanupBudgetMs: 250,
      capture: async () => { throw new Error("fixture capture not used"); } });
    const watch = await client.beginWatch("40", 2000);
    const outer = client.cancelWatch(watch);
    assert.ok(nested, "external callback reentered synchronously");
    const settled = await Promise.allSettled([outer, nested]);
    const cancellation = calls.filter(call => call.kind === "cancel_watch");
    console.log(JSON.stringify({ stimulus, outcome, callIds: calls.map(call => call.callId), kinds: calls.map(call => call.kind),
      cancelCount: cancellation.length, samePromise: outer === nested, deadlines: cancellation.map(call => call.deadline),
      settled: settled.map(item => item.status), cleanupState: client.cleanupState, realIO: 0 }));
    assert.strictEqual(outer, nested, "reserve the shared Promise before external code runs");
    assert.equal(cancellation.length, 1, "one recovery operation owns one cancel RPC");
    assert.deepEqual(cancellation.map(call => call.deadline), [1250], "reserve one fixed cleanup budget");
    assert.equal(cancellation[0]!.originalAbortPresent, false);
    assert.deepEqual(cancellation[0]!.reference, { mode: "watch", watch: tuple });
    assert.deepEqual(calls.map(call => call.callId), [1, 2]);
    assert.equal(client.cleanupState, outcome);
    assert.strictEqual(client.cancelWatch(watch), outer, "settled failure also retains the original shared Promise");
    assert.deepEqual(settled.map(item => item.status), outcome === "confirmed" ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"]);
    if (outcome === "unknown") for (const item of settled) if (item.status === "rejected")
      assert.equal(item.reason.code, "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED");
  });
}
