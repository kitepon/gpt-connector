import assert from "node:assert/strict";
import test from "node:test";
import { FramedLocalAuthenticatedChannel } from "../src/window-handoff-framed-channel.js";
import type { AuthenticatedFrameEvent, AuthenticatedFramePipe, FrameWriteResult } from "../src/window-handoff-framed-channel.js";
import { FrameV2Decoder, LocalFrameV2 } from "../src/window-handoff-frame-v2.js";
import { createLocalClientClock } from "../src/window-handoff-local-clock.js";
import { decodeLocalRequest, encodeLocalReply, encodeLocalRequest } from "../src/window-handoff-local-codec.js";
import type { LocalRequest, LocalReply } from "../src/window-handoff-local-codec.js";
import { PromiseWindowHandoffClient } from "../src/window-handoff-promise-client.js";
import { prepareOwnedWindowHandoff } from "../src/window-handoff-input.js";

const deferred = <T>() => Promise.withResolvers<T>();
async function until(condition: () => boolean) {
  for (let n = 0; n < 200 && !condition(); n++) await Promise.resolve();
  assert.ok(condition(), "finite deterministic microtask checkpoint");
}
function fixture() {
  const session = {}, eof = new AbortController(), subscription = new AbortController(), native = new AbortController();
  const registration = "a".repeat(32), profile = "C:\\private\\profile";
  const originalWatch = { watchId: "fixture-native", hostRegistrationId: registration, expiresAt: 2000,
    identity: { pid: 30, createdAt: "1970-01-01T00:00:00.0010000Z", ownerSid: "S-1-5-21-1", sessionId: 1, hwnd: "40" } };
  let raw = 1000, mono = 0, receive: (event: AuthenticatedFrameEvent) => void = () => {};
  const timers = new Map<object, { deadline: number; callback: () => void }>();
  const clock = createLocalClientClock({ utcNow: () => raw, monotonicNow: () => mono,
    setTimer(callback, delay) { const id = {}; timers.set(id, { deadline: mono + delay, callback }); return id; },
    clearTimer(id) { timers.delete(id as object); } });
  const frames: LocalFrameV2[] = [], requests: LocalRequest[] = [];
  let partialAck = false, ackTail: Uint8Array | undefined, hostReady = false, allocated = false, backendReclaimed = false;
  let writes = 0, closes = 0, captures = 0, lifetimeMissing = false;
  let nextBefore: (() => Promise<FrameWriteResult | undefined>) | undefined;
  let afterWrite: FrameWriteResult | undefined;
  let handler: ((request: LocalRequest) => void) | undefined;
  const emit = (bytes: Uint8Array, from = session) => receive({ kind: "bytes", session: from, bytes });
  const hostFrame = (tag: 2 | 4 | 17 | 32, value: unknown) => new LocalFrameV2(tag, new TextEncoder().encode(JSON.stringify(value)), null, "host_to_client").encode();
  const reply = (value: LocalReply) => {
    const body = new TextEncoder().encode(` \n${encodeLocalReply(value)}\t`), bytes = new LocalFrameV2(17, body, null, "host_to_client").encode();
    emit(bytes); bytes.fill(0); return body;
  };
  const normal = (request: LocalRequest) => {
    const common = { version: 1 as const, callId: request.callId };
    if (request.kind === "begin_watch") reply({ ...common, outcome: "armed", watch: structuredClone(originalWatch) });
    else if (request.kind === "cancel_watch") { allocated = false; backendReclaimed = true; reply({ ...common, outcome: "cancelled", reference: request.reference }); }
    else reply({ ...common, outcome: request.kind === "assert_current" ? "current" : "bound", watch: structuredClone(originalWatch) });
  };
  const pipe: AuthenticatedFramePipe = {
    session, hostRegistrationId: registration, closed: eof.signal,
    subscribe(listener) { receive = listener; return { lost: subscription.signal, dispose() {} }; },
    async write(prepare) {
      writes++;
      const after = afterWrite; afterWrite = undefined;
      const before = nextBefore; nextBefore = undefined;
      const early = await before?.(); if (early) return early;
      let bytes: Uint8Array;
      try { bytes = prepare(); } catch { return { kind: "failure", reason: "deadline_expired", delivery: "not_sent" }; }
      const parsed = new FrameV2Decoder("client_to_host").feed(bytes, clock.framePoint())[0]!;
      frames.push(parsed); bytes.fill(0);
      if (parsed.tag === 1) emit(hostFrame(2, { version: 1, capability: "window_handoff_local_v1", hostRegistrationId: registration }));
      else if (parsed.tag === 3) {
        const ack = hostFrame(4, { version: 1, capability: "window_handoff_local_v1", hostRegistrationId: registration });
        if (partialAck) { emit(ack.slice(0, -1)); ackTail = ack.slice(-1); }
        else { hostReady = true; emit(ack); }
      } else {
        assert.equal(hostReady, true, "fake Host queue opens only after full ack write");
        const request = decodeLocalRequest(parsed.bodySnapshot()); requests.push(request);
        if (request.kind === "begin_watch") allocated = true;
        (handler ?? normal)(request);
      }
      return after ?? { kind: "written" };
    },
    watchLifetime(beginCallId, watch) { return lifetimeMissing ? undefined : {
      session, beginCallId, originalTuple: structuredClone(watch), invalidated: native.signal };
    },
    async close() { closes++; eof.abort(); native.abort(); },
  };
  const channel = new FramedLocalAuthenticatedChannel(pipe, clock);
  const begin = (callId = 1) => encodeLocalRequest({ version: 1, callId, kind: "begin_watch", hint: "40", deadline: 2000, hostRegistrationId: registration });
  const cancel = (callId: number, beginCallId = 1) => encodeLocalRequest({ version: 1, callId, kind: "cancel_watch",
    reference: { mode: "begin", beginCallId, hostRegistrationId: registration } });
  const subscribe = () => channel.subscribeControl(() => {});
  const client = () => new PromiseWindowHandoffClient({ channel, clock, cleanupBudgetMs: 250, capture: async () => {
    captures++; return { identity: { ...originalWatch.identity }, observedAt: raw, candidateWindowCount: 1, providerPageCount: 1,
      listener: { pid: "30", command: "fixture-only", executable: "C:\\Chrome\\chrome.exe", args: ["C:\\Chrome\\chrome.exe",
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`] },
      windowClass: "Chrome_WidgetWin_1", visible: true, minimized: false, targetId: "fixture-target", browserWindowId: 1 };
  } });
  return { session, clock, channel, pipe, eof, subscription, native, originalWatch, frames, requests, timers, begin, cancel, subscribe, client,
    emit, reply, normal, hostFrame, profile, advance(utc: number, monotonic: number) {
      raw = utc; mono = monotonic; clock.now();
      for (const [id, task] of [...timers]) if (task.deadline <= mono) { timers.delete(id); task.callback(); }
    },
    before(next: NonNullable<typeof nextBefore>) { nextBefore = next; }, handle(next: NonNullable<typeof handler>) { handler = next; },
    after(result: FrameWriteResult) { afterWrite = result; },
    partial() { partialAck = true; }, finishAck() { assert.ok(ackTail); hostReady = true; emit(ackTail); },
    missingLifetime() { lifetimeMissing = true; }, get ackPending() { return !!ackTail; }, get allocated() { return allocated; },
    get backendReclaimed() { return backendReclaimed; }, get captures() { return captures; }, get writes() { return writes; }, get closes() { return closes; } };
}
const requestWait = () => ({ purpose: "request" as const, absoluteDeadline: 2000, maximumWaitMs: 1000 });

test("strict client handshake waits for complete Host ACK and opens no request queue on partial ACK", async () => {
  const f = fixture(); f.partial(); const opening = f.channel.open(1500);
  await until(() => f.ackPending); assert.equal(f.channel.established, false); f.subscribe();
  assert.deepEqual(await f.channel.exchange(f.begin(), requestWait()), { kind: "failure", reason: "offline", delivery: "not_sent" });
  assert.equal(f.requests.length, 0); f.finishAck(); assert.equal(await opening, true);
  assert.deepEqual(f.frames.map(frame => frame.tag), [1, 3]); assert.equal(f.timers.size, 0);
});

test("new byte-frame to Promise/input composition retains native lifetime and exact owner cancellation", async () => {
  const f = fixture(); assert.equal(await f.channel.open(1500), true); const client = f.client();
  const result = await prepareOwnedWindowHandoff({ hint: "40", profile: f.profile, deadline: 2000 }, client, () => f.clock.now());
  assert.strictEqual(result.watch.signal, f.native.signal); assert.equal(f.captures, 1);
  assert.deepEqual(f.requests.map(r => r.kind), ["begin_watch", "assert_current", "assert_current", "bind_target", "assert_current"]);
  await client.cancelWatch(result.watch); assert.equal(client.cleanupState, "confirmed"); assert.equal(f.backendReclaimed, true);
  assert.equal(f.frames.at(-1)!.wait!.purpose, "cleanup"); assert.equal(f.timers.size, 0);
});

test("sender queue consumes the original capped token on rollback and owns Wait/body snapshots", async () => {
  const f = fixture(); await f.channel.open(1500); f.subscribe(); const gate = deferred<undefined>();
  f.before(() => gate.promise); const wait = requestWait(), pending = f.channel.exchange(f.begin(), wait);
  Object.assign(wait, { maximumWaitMs: 120000, absoluteDeadline: 999999 });
  await until(() => f.writes === 3); f.advance(900, 50); gate.resolve(undefined);
  const result = await pending; assert.equal(result.kind, "reply");
  const frame = f.frames.at(-1)!; assert.equal(frame.wait!.absoluteDeadline, 2000); assert.equal(frame.wait!.maximumWaitMs, 950);
  if (result.kind === "reply") { assert.ok(new TextDecoder().decode(result.bytes as Uint8Array).startsWith(" \n")); }
  assert.equal(f.timers.size, 0);
});

test("sub-ms queue exhaustion/abort-before-write emits no begin and a separate cleanup budget remains legal", async () => {
  for (const mode of ["fraction", "abort", "forward_rollback"] as const) {
    const f = fixture(); await f.channel.open(1500); f.subscribe(); const gate = deferred<undefined>(), signal = new AbortController();
    f.before(() => gate.promise); const pending = f.channel.exchange(f.begin(), { ...requestWait(), originalAbort: signal.signal });
    await until(() => f.writes === 3);
    if (mode === "fraction") f.advance(900, 999.5);
    else if (mode === "forward_rollback") { f.advance(2001, 1); f.advance(1000, 2); }
    else signal.abort();
    const failure = await pending; assert.equal(failure.kind, "failure"); if (failure.kind === "failure") assert.equal(failure.delivery, "not_sent");
    gate.resolve(undefined);
    const cleanup = await f.channel.exchange(f.cancel(2), { purpose: "cleanup", absoluteDeadline: f.clock.now() + 250, maximumWaitMs: 250 });
    assert.equal(cleanup.kind, "reply"); assert.deepEqual(f.requests.map(r => r.kind), ["cancel_watch"]);
    assert.equal(f.frames.at(-1)!.wait!.maximumWaitMs, 250); assert.equal(f.timers.size, 0);
  }
});

test("NotSent before boundary and Unknown after boundary both use same-session original-begin owner ACK", async () => {
  for (const delivery of ["not_sent", "unknown"] as const) {
    const f = fixture(); await f.channel.open(1500); const client = f.client();
    if (delivery === "not_sent") f.before(async () => ({ kind: "failure", reason: "offline", delivery }));
    else {
      f.after({ kind: "failure", reason: "offline", delivery: "unknown" });
      f.handle(request => { if (request.kind === "cancel_watch") f.normal(request); });
    }
    if (delivery === "unknown") {
      await assert.rejects(client.beginWatch("40", 2000));
      assert.equal(client.beginTransportState, "unknown");
    } else await assert.rejects(client.beginWatch("40", 2000));
    assert.equal(client.cleanupState, "confirmed"); assert.equal(f.backendReclaimed, true);
    const last = f.requests.at(-1)!; assert.equal(last.kind, "cancel_watch");
    if (last.kind === "cancel_watch") assert.equal(last.reference.mode, "begin");
    assert.equal(f.requests.filter(r => r.kind === "begin_watch").length, delivery === "not_sent" ? 0 : 1);
  }
});

test("original abort after begin has independent cleanup cap; late armed cannot revive confirmed cancellation", async () => {
  const f = fixture(); await f.channel.open(1500); const client = f.client(), original = new AbortController();
  f.handle(request => { if (request.kind === "cancel_watch") f.normal(request); });
  const pending = client.beginWatch("40", 2000, original.signal), rejected = assert.rejects(pending);
  await until(() => f.requests.length === 1); f.advance(900, 10); original.abort(); await rejected;
  assert.equal(client.cleanupState, "confirmed"); assert.equal(f.frames.at(-1)!.wait!.absoluteDeadline, 1150);
  assert.equal(f.frames.at(-1)!.wait!.maximumWaitMs, 250);
  f.reply({ version: 1, callId: 1, outcome: "armed", watch: f.originalWatch });
  assert.equal(f.channel.closed.aborted, true); assert.equal(client.cleanupState, "confirmed");
  assert.equal(f.captures, 0); assert.equal(f.timers.size, 0);
});

test("first watch-loss is retained before armed/error; control bytes cannot mutate the original tuple", async () => {
  const f = fixture(); await f.channel.open(1500); const client = f.client();
  f.handle(request => {
    if (request.kind !== "begin_watch") { f.normal(request); return; }
    f.native.abort(); const bytes = f.hostFrame(32, { version: 1, type: "watch_lost", beginCallId: request.callId,
      watch: f.originalWatch, reason: "window_destroyed" }); f.emit(bytes); bytes.fill(0);
    f.reply({ version: 1, callId: request.callId, outcome: "error", code: "HANDOFF_UNSUPPORTED", effect: "unknown" });
  });
  await assert.rejects(client.beginWatch("40", 2000)); assert.equal(client.cleanupState, "confirmed"); assert.equal(f.captures, 0);
});

test("missing native lifetime is unknown; stale session/call/registration and wrong cancelled reference seal", async () => {
  for (const mode of ["lifetime", "session", "call", "registration", "cancel"] as const) {
    const f = fixture(); await f.channel.open(1500); const client = f.client();
    if (mode === "lifetime") f.missingLifetime();
    else f.handle(request => {
      if (mode === "cancel" && request.kind === "begin_watch") return;
      if (mode === "session") f.emit(f.hostFrame(17, { version: 1, callId: request.callId, outcome: "armed", watch: f.originalWatch }), {});
      else if (mode === "cancel") f.reply({ version: 1, callId: request.callId, outcome: "cancelled",
        reference: { mode: "begin", beginCallId: 999, hostRegistrationId: f.originalWatch.hostRegistrationId } });
      else f.reply({ version: 1, callId: mode === "call" ? 99 : request.callId, outcome: "armed",
        watch: mode === "registration" ? { ...f.originalWatch, hostRegistrationId: "b".repeat(32) } : f.originalWatch });
    });
    const abort = new AbortController(), pending = client.beginWatch("40", 2000, abort.signal), rejected = assert.rejects(pending);
    if (mode === "cancel") { await until(() => f.requests.length === 1); abort.abort(); }
    await rejected; assert.equal(client.cleanupState, "unknown"); assert.equal(f.channel.closed.aborted, true);
  }
});

test("EOF and unknown cleanup ACK seal finite client state but do not manufacture backend reclamation", async () => {
  for (const mode of ["eof", "unknown_ack"] as const) {
    const f = fixture(); await f.channel.open(1500); const client = f.client();
    f.handle(request => { if (request.kind === "cancel_watch") f.reply({ version: 1, callId: request.callId,
      outcome: "error", code: "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED", effect: "unknown" }); });
    const original = new AbortController(), pending = client.beginWatch("40", 2000, original.signal), rejected = assert.rejects(pending);
    await until(() => f.requests.length === 1);
    if (mode === "eof") f.eof.abort(); else original.abort();
    await rejected; assert.equal(client.cleanupState, "unknown"); assert.equal(f.allocated, true);
    assert.equal(f.backendReclaimed, false); assert.equal(f.timers.size, 0);
  }
});

test("wrong/duplicate handshake and handshake timeout never admit application frames", async () => {
  for (const mode of ["duplicate", "registration", "timeout"] as const) {
    const f = fixture(); f.partial(); const opening = f.channel.open(1500); await until(() => f.ackPending);
    if (mode === "timeout") f.advance(1500, 500);
    else if (mode === "registration") {
      // Finish the original partial frame with bad content: strict parse must seal.
      f.emit(Uint8Array.of(0));
    } else { f.finishAck(); f.emit(f.hostFrame(4, { version: 1, capability: "window_handoff_local_v1", hostRegistrationId: "a".repeat(32) })); }
    assert.equal(await opening, false); assert.equal(f.channel.established, false); assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
  }
});

test("post-write NotSent claims cannot infer absence or become owner cleanup success", async () => {
  const f = fixture(); await f.channel.open(1500); f.subscribe();
  f.handle(() => {}); f.after({ kind: "failure", reason: "offline", delivery: "not_sent" });
  const result = await f.channel.exchange(f.begin(), requestWait());
  assert.equal(result.kind, "failure"); if (result.kind === "failure") assert.equal(result.delivery, "unknown");
  assert.equal(f.allocated, true); assert.equal(f.backendReclaimed, false); assert.equal(f.channel.closed.aborted, true);
  await until(() => f.channel.closeState === "completed"); assert.equal(f.channel.subscriptionState, "released");
});

test("framing namespace cannot be duplicated and lifecycle failures remain explicit safe states", async () => {
  const f = fixture(); assert.throws(() => new FramedLocalAuthenticatedChannel(f.pipe, f.clock), /HANDOFF_INVALID/u);
  const closed = new AbortController(), lost = new AbortController();
  const pipe: AuthenticatedFramePipe = { ...f.pipe, session: {}, closed: closed.signal,
    subscribe() { return { lost: lost.signal, dispose() { throw new Error("private dispose details"); } }; },
    async close() { throw new Error("private close details"); } };
  const channel = new FramedLocalAuthenticatedChannel(pipe, f.clock);
  await assert.rejects(channel.close(), /^Error: HANDOFF_CLOSE_UNCONFIRMED$/u);
  assert.equal(channel.closeState, "failed"); assert.equal(channel.subscriptionState, "release_failed");
  assert.equal(channel.closed.aborted, true); assert.equal(channel.established, false);
});
