import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeLocalReply, decodeLocalRequest, encodeLocalReply, encodeLocalRequest } from "../src/window-handoff-local-codec.js";
import type { LocalRequest, LocalWatchTuple } from "../src/window-handoff-local-codec.js";
import { LocalHandoffReceiptMap } from "../src/window-handoff-local-receipts.js";

const fixtureBytes = readFileSync(new URL("./fixtures/window-handoff-local-synthetic.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as { requests: unknown[]; replies: unknown[] };
const registration = "abcdef0123456789abcdef0123456789";
const original = decodeLocalReply(JSON.stringify(fixture.replies[0]));
assert.equal(original.outcome, "armed");
if (original.outcome !== "armed") throw new Error("fixture");
const tuple = original.watch;
const reply = (callId: number, outcome: "armed" | "current" | "bound", watch = tuple) => encodeLocalReply({ version: 1, callId, outcome, watch });
const request = (bytes: string): LocalRequest => decodeLocalRequest(bytes);
function harness() {
  let time = 1000;
  const session = {};
  const map = new LocalHandoffReceiptMap(session, registration, () => time);
  const signal = new AbortController();
  const monitor = new AbortController();
  const begin = map.beginWatch("40", 121000, signal.signal);
  const arm = () => map.accept(session, begin, reply(1, "armed"), monitor.signal)!;
  return { session, map, signal, monitor, begin, arm, time: (next: number) => { time = next; } };
}

test("exact Windows Encode fixture bytes and all four request/reply kinds roundtrip", () => {
  assert.equal(fixtureBytes.length, 4490);
  assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), "7567222655ff65ee3db7b310bd4ebdb2340ecdbb92fe8e3118ecb51e1cba7b6c");
  for (const item of fixture.requests) assert.deepEqual(decodeLocalRequest(encodeLocalRequest(item)), item);
  for (const item of fixture.replies) assert.deepEqual(decodeLocalReply(encodeLocalReply(item)), item);
});

test("strict lexical JSON, exact keys, value ranges and bounded UTF8", () => {
  const valid = JSON.stringify(fixture.requests[0]);
  const bad = [
    valid.replace('"callId":1', '"callId":1,"callId":2'),
    valid.replace('"callId":1', '"callId":1,"call\\u0049d":2'),
    ...["1e0", "1.0", "true", "null", "0", "-1", "9007199254740992", '"1"'].map(value => valid.replace('"callId":1', `"callId":${value}`)),
    valid.replace('"hint":"40"', '"hint":"040"'),
    valid.replace('"version":1', '"version":2'),
    valid.replace('"kind":"begin_watch"', '"kind":"begin_watch","signal":true'),
    valid.replace('"hint":"40",', ""),
    `\uFEFF${valid}`, `${valid}null`, "{\"a\":".repeat(9) + "1" + "}".repeat(9),
  ];
  for (const bytes of bad) assert.throws(() => decodeLocalRequest(bytes), { message: "HANDOFF_INVALID" });
  assert.throws(() => decodeLocalRequest(new Uint8Array([0xc3, 0x28])));
  assert.throws(() => decodeLocalRequest(" ".repeat(4097)));
  assert.throws(() => encodeLocalRequest({ ...fixture.requests[0] as object, extra: "x" }));
  assert.throws(() => encodeLocalRequest({ get version() { throw new Error("private fixture detail"); } }), { message: "HANDOFF_INVALID" });
  assert.throws(() => encodeLocalReply({ version: 1, callId: 1, outcome: "error", code: "arbitrary secret", effect: "unknown" }));
});

test("FILETIME UTC precision and UInt64 HWND remain strings without rounding", () => {
  const precise: LocalWatchTuple = { ...tuple, identity: { ...tuple.identity,
    createdAt: "2026-10-25T07:09:16.2041234Z", hwnd: "18446744073709551615", pid: 4294967295, sessionId: 4294967295 } };
  const decoded = decodeLocalReply(reply(1, "armed", precise));
  assert.equal(decoded.outcome, "armed");
  if (decoded.outcome !== "armed") return;
  assert.equal(decoded.watch.identity.createdAt, precise.identity.createdAt);
  assert.equal(decoded.watch.identity.hwnd, precise.identity.hwnd);
  assert.notEqual(reply(1, "armed", precise), reply(1, "armed", { ...precise,
    identity: { ...precise.identity, createdAt: "2026-10-25T07:09:16.2041235Z" } }));
  for (const createdAt of ["1601-01-01T00:00:00Z", "2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00.12345678Z", "2026-01-01T00:00:00+00:00"])
    assert.throws(() => reply(1, "armed", { ...tuple, identity: { ...tuple.identity, createdAt } }));
  assert.doesNotThrow(() => reply(1, "armed", { ...tuple, identity: { ...tuple.identity, createdAt: "1601-01-01T00:00:00.0000001Z" } }));
  for (const value of [{ hwnd: "18446744073709551616" }, { pid: 4294967296 }, { sessionId: 0 }])
    assert.throws(() => reply(1, "armed", { ...tuple, identity: { ...tuple.identity, ...value } }));
});

test("source mapping admits original begin/assert/bind and exact cancellation ACK", () => {
  const h = harness(); const watch = h.arm();
  assert.strictEqual(watch.signal, h.monitor.signal);
  const current = h.map.assertCurrent(watch, 121000, h.signal.signal);
  h.map.accept(h.session, current, reply(2, "current"));
  h.time(1500);
  const bound = h.map.bindTarget(watch, { identity: { ...tuple.identity }, observedAt: 1500, targetId: "synthetic_target", browserWindowId: 1 }, 121000, h.signal.signal);
  h.map.accept(h.session, bound, reply(3, "bound"));
  assert.equal(h.map.cleanup(h.begin), "unknown");
  const cancel = h.map.cancelWatch(watch); const wire = request(cancel.bytes);
  assert.equal(wire.kind, "cancel_watch");
  if (wire.kind !== "cancel_watch") return;
  h.map.accept(h.session, cancel, encodeLocalReply({ version: 1, callId: wire.callId, outcome: "cancelled", reference: wire.reference }));
  assert.equal(h.map.cleanup(h.begin), "confirmed");
  for (const call of [h.begin, current, bound, cancel]) assert.doesNotMatch(call.bytes, /signal|profile|cookie|sessionId":true/u);
});

test("mutable public watch never changes privately retained original tuple or cancellation", () => {
  const h = harness(); const watch = h.arm();
  Object.assign(watch, { watchId: "forged", hostRegistrationId: "0".repeat(32), expiresAt: 999999 });
  Object.assign(watch.identity, { hwnd: "99", createdAt: "2026-10-25T00:00:00.0000000Z" });
  const current = request(h.map.assertCurrent(watch, 121000, h.signal.signal).bytes);
  assert.equal(current.kind, "assert_current");
  if (current.kind === "assert_current") assert.deepEqual(current.watch, tuple);
  h.time(999999); h.signal.abort(); h.monitor.abort();
  const cancel = request(h.map.cancelWatch(watch).bytes);
  assert.equal(cancel.kind, "cancel_watch");
  if (cancel.kind === "cancel_watch") assert.deepEqual(cancel.reference, { mode: "watch", watch: tuple });
  assert.throws(() => h.map.cancelWatch({ ...watch }));
});

test("unknown begin retains owner call/session before receipt; no new begin as recovery", () => {
  for (const response of ["null", '{"version":1}', encodeLocalReply({ version: 1, callId: 1, outcome: "error", code: "HOST_OFFLINE", effect: "unknown" }),
    encodeLocalReply({ version: 1, callId: 1, outcome: "error", code: "HANDOFF_UNSUPPORTED", effect: "none" })]) {
    const h = harness();
    assert.throws(() => h.map.accept(h.session, h.begin, response));
    assert.equal(h.map.cleanup(h.begin), "unknown");
    assert.throws(() => h.map.beginWatch("99", 121000));
    h.time(121001); h.signal.abort();
    const cancel = h.map.cancelUnknownBegin(h.begin); const wire = request(cancel.bytes);
    assert.deepEqual(wire, { version: 1, callId: 2, kind: "cancel_watch", reference: { mode: "begin", beginCallId: 1, hostRegistrationId: registration } });
    assert.equal(h.map.cleanup(cancel), "unknown");
    assert.equal(wire.kind, "cancel_watch");
    if (wire.kind === "cancel_watch") h.map.accept(h.session, cancel,
      encodeLocalReply({ version: 1, callId: 2, outcome: "cancelled", reference: wire.reference }));
    assert.equal(h.map.cleanup(h.begin), "confirmed");
  }
});

test("session, call, outcome, registration, hint and exact receipt correlation reject mismatches", () => {
  const h = harness();
  assert.throws(() => new LocalHandoffReceiptMap(h.session, registration, () => 1000));
  assert.throws(() => h.map.accept({}, h.begin, reply(1, "armed"), h.monitor.signal));
  assert.throws(() => h.map.accept(h.session, { ...h.begin }, reply(1, "armed"), h.monitor.signal));
  for (const bytes of [reply(2, "armed"), reply(1, "current"), reply(1, "armed", { ...tuple, hostRegistrationId: "0".repeat(32) }),
    reply(1, "armed", { ...tuple, identity: { ...tuple.identity, hwnd: "41" } }), reply(1, "armed", { ...tuple, expiresAt: 121001 })])
    assert.throws(() => h.map.accept(h.session, h.begin, bytes, h.monitor.signal));
  const watch = h.arm();
  assert.throws(() => h.map.assertCurrent(watch, 121001, h.signal.signal));
  assert.throws(() => h.map.assertCurrent(watch, 121000, new AbortController().signal));
  const call = h.map.assertCurrent(watch, 121000, h.signal.signal);
  assert.throws(() => h.map.accept(h.session, call, reply(2, "bound")));
  assert.throws(() => h.map.accept(h.session, call, reply(2, "current", { ...tuple, identity: { ...tuple.identity, createdAt: "1970-01-01T00:00:00.0010001Z" } })));
  const cancel = h.map.cancelWatch(watch);
  assert.throws(() => h.map.accept(h.session, cancel, encodeLocalReply({ version: 1, callId: 3, outcome: "cancelled", reference: { mode: "begin", beginCallId: 1, hostRegistrationId: registration } })));
  assert.equal(h.map.cleanup(h.begin), "unknown");
});

test("cancelled, expired and EOF begin cannot adopt late armed; confirmed stays monotone", () => {
  const h = harness(); const cancel = h.map.cancelUnknownBegin(h.begin);
  const wire = request(cancel.bytes);
  assert.throws(() => h.arm());
  if (wire.kind !== "cancel_watch") return;
  h.map.accept(h.session, cancel, encodeLocalReply({ version: 1, callId: 2, outcome: "cancelled", reference: wire.reference }));
  assert.throws(() => h.arm());
  assert.throws(() => h.map.accept(h.session, h.begin, encodeLocalReply({ version: 1, callId: 1, outcome: "error", code: "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED", effect: "unknown" })));
  assert.equal(h.map.cleanup(h.begin), "confirmed");
  const expired = harness(); expired.time(120000); assert.throws(() => expired.arm());
  const eof = harness(); eof.map.close(); assert.throws(() => eof.arm());
  assert.equal(eof.map.cleanup(eof.begin), "unknown");
  assert.throws(() => eof.map.cancelUnknownBegin(eof.begin));
});

test("local original abort/monitor loss and capture age stop admission, never serialize signal", () => {
  const h = harness(); const watch = h.arm();
  assert.throws(() => h.map.bindTarget(watch, { identity: tuple.identity, observedAt: 999, targetId: "x", browserWindowId: 1 }, 121000, h.signal.signal));
  const call = h.map.assertCurrent(watch, 121000, h.signal.signal);
  h.signal.abort();
  assert.throws(() => h.map.accept(h.session, call, reply(2, "current")));
  assert.doesNotThrow(() => h.map.cancelWatch(watch));
  const monitored = harness(); const owned = monitored.arm(); monitored.monitor.abort();
  assert.throws(() => monitored.map.assertCurrent(owned, 121000, monitored.signal.signal));
  assert.doesNotThrow(() => monitored.map.cancelWatch(owned));
  const noSignal = harness(); assert.throws(() => noSignal.map.accept(noSignal.session, noSignal.begin, reply(1, "armed")));
});
