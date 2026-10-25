import { fixtureDeadlineClock } from "./fixtures/local-deadline-clock.js";
import assert from "node:assert/strict";
import test from "node:test";
import { prepareOwnedWindowHandoff, WindowHandoffInputError } from "../src/window-handoff-input.js";
import type { FreshWindowCapture } from "../src/window-handoff-input.js";
import { decodeLocalRequest, encodeLocalReply } from "../src/window-handoff-local-codec.js";
import type { LocalRequest } from "../src/window-handoff-local-codec.js";
import { PromiseWindowHandoffClient } from "../src/window-handoff-promise-client.js";
import type { LocalAuthenticatedChannel, LocalExchangeResult, LocalControl, LocalWatchLifetime } from "../src/window-handoff-session-port.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Clock {
  value = 1000;
  readonly timers = new Map<object, { deadline: number; callback: () => void }>();
  now() { return this.value; }
  at(deadline: number, callback: () => void) {
    const key = {}; this.timers.set(key, { deadline, callback });
    return () => { this.timers.delete(key); };
  }
  advance(value: number) {
    this.value = value;
    for (const [key, task] of [...this.timers]) if (value >= task.deadline) { this.timers.delete(key); task.callback(); }
  }
}
const errorCode = (code: string) => (error: unknown) => error instanceof WindowHandoffInputError
  && error.code === code && !String(error).includes("private");
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  assert.equal(predicate(), true, "deterministic microtask checkpoint");
}
function fixture() {
  const session = {}, clock = new Clock();
  const original = new AbortController(), eof = new AbortController(), lossClosed = new AbortController();
  const native = new AbortController(); // Fake Windows-owned watch signal; never created by the client.
  const registration = "a".repeat(32), profile = "C:\\private\\profile";
  const tuple = { watchId: "fake-native-watch", hostRegistrationId: registration, expiresAt: 2000,
    identity: { pid: 30, createdAt: "1970-01-01T00:00:00.0010000Z", ownerSid: "S-1-5-21-1", sessionId: 1, hwnd: "40" } };
  const calls: { request: LocalRequest; deadline: number; purpose: "request" | "cleanup"; signal?: AbortSignal }[] = [];
  let captures = 0, closes = 0, subscribed = false;
  let receive: (control: LocalControl) => void = () => {};
  let handler: ((request: LocalRequest) => Promise<LocalExchangeResult>) | undefined;
  let onCapture: (() => void) | undefined;
  const defaultReply = (request: LocalRequest): LocalExchangeResult => {
    const common = { version: 1, callId: request.callId };
    const value = request.kind === "cancel_watch" ? { ...common, outcome: "cancelled", reference: request.reference }
      : { ...common, outcome: request.kind === "begin_watch" ? "armed" : request.kind === "assert_current" ? "current" : "bound", watch: tuple };
    return { kind: "reply", session, bytes: encodeLocalReply(value), watchLifetime: request.kind === "begin_watch"
      ? { session, beginCallId: request.callId, originalTuple: tuple, invalidated: native.signal } : undefined };
  };
  const channel: LocalAuthenticatedChannel = {
    session, hostRegistrationId: registration, closed: eof.signal,
    subscribeControl(callback) { subscribed = true; receive = callback; return { lost: lossClosed.signal, dispose() { lossClosed.abort(); } }; },
    async close() { closes++; eof.abort(); native.abort(); },
    async exchange(bytes, options) {
      assert.equal(subscribed, true);
      const request = decodeLocalRequest(bytes);
      calls.push({ request, deadline: options.absoluteDeadline, purpose: options.purpose, signal: options.purpose === "request" ? options.originalAbort : undefined });
      return handler ? handler(request) : defaultReply(request);
    },
  };
  const capture = async (): Promise<FreshWindowCapture> => {
    captures++; onCapture?.();
    return { identity: { ...tuple.identity }, observedAt: clock.now(), candidateWindowCount: 1, providerPageCount: 1,
      listener: { pid: "30", command: "fake-only", executable: "C:\\Chrome\\chrome.exe", args: ["C:\\Chrome\\chrome.exe",
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`] },
      windowClass: "Chrome_WidgetWin_1", visible: true, minimized: false, targetId: "fake-cdp-target", browserWindowId: 1 };
  };
  const make = () => new PromiseWindowHandoffClient({ channel, clock: fixtureDeadlineClock(clock), capture, cleanupBudgetMs: 250 });
  const run = (client: PromiseWindowHandoffClient) => prepareOwnedWindowHandoff({ hint: "40", profile, deadline: 2000, signal: original.signal }, client, () => clock.now());
  return { session, clock, original, eof, lossClosed, native, tuple, calls, channel, defaultReply, make, run,
    setHandler: (next: typeof handler) => { handler = next; },
    control: (control: LocalControl) => receive(control),
    setCapture: (next: () => void) => { onCapture = next; },
    get captures() { return captures; }, get closes() { return closes; } };
}

test("normal Promise composition keeps original session/lifetime, signal and five-RPC sequence", async () => {
  const f = fixture(), client = f.make();
  const result = await f.run(client);
  assert.strictEqual(result.watch.signal, f.native.signal);
  assert.deepEqual(f.calls.map(call => call.request.kind), ["begin_watch", "assert_current", "assert_current", "bind_target", "assert_current"]);
  assert.equal(f.captures, 1); assert.equal(f.closes, 0);
  for (const call of f.calls) { assert.equal(call.deadline, 2000); assert.equal(call.purpose, "request"); assert.strictEqual(call.signal, f.original.signal); }
  await client.cancelWatch(result.watch);
  assert.equal(client.cleanupState, "confirmed"); assert.equal(client.beginTransportState, "reply_received");
  assert.equal(f.calls.at(-1)?.signal, undefined); assert.equal(f.clock.timers.size, 0);
});

test("begin-before-abort and lost subscription produce no begin/write", async () => {
  const f = fixture(); f.original.abort(); const client = f.make();
  await assert.rejects(client.beginWatch("40", 2000, f.original.signal), errorCode("HANDOFF_UNSUPPORTED"));
  assert.equal(f.calls.length, 0); assert.equal(client.cleanupState, "not_started");
  const waiting = fixture(), other = waiting.make(); waiting.lossClosed.abort();
  await assert.rejects(waiting.run(other), errorCode("HANDOFF_UNSUPPORTED"));
  assert.equal(waiting.calls.length, 0); assert.equal(other.cleanupState, "not_started"); assert.equal(waiting.closes, 1);
});

test("unreceived not_sent and unknown/throw retain distinct delivery but require exact owner cancel", async () => {
  for (const delivery of ["not_sent", "unknown", "throw", "owner_unknown"] as const) {
    const f = fixture();
    f.setHandler(async request => {
      if (request.kind !== "begin_watch") return f.defaultReply(request);
      if (delivery === "throw") throw new Error("private transport error");
      if (delivery === "owner_unknown") return { kind: "reply", session: f.session, bytes: encodeLocalReply({ version: 1,
        callId: request.callId, outcome: "error", code: "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED", effect: "unknown" }) };
      return { kind: "failure", reason: "offline", delivery };
    });
    const client = f.make();
    await assert.rejects(f.run(client), errorCode("HANDOFF_UNSUPPORTED"));
    assert.equal(client.beginTransportState, delivery === "throw" ? "unknown" : delivery === "owner_unknown" ? "reply_received" : delivery);
    assert.equal(client.cleanupState, "confirmed");
    assert.deepEqual(f.calls.map(call => call.request.kind), ["begin_watch", "cancel_watch"]);
    const cancellation = f.calls[1]!;
    assert.equal(cancellation.signal, undefined); assert.equal(cancellation.purpose, "cleanup");
    if (cancellation.request.kind === "cancel_watch") assert.deepEqual(cancellation.request.reference,
      { mode: "begin", beginCallId: 1, hostRegistrationId: f.tuple.hostRegistrationId });
    assert.equal(f.captures, 0);
  }
});

test("aborted pending begin cancels original call independently; late armed cannot revive it", async () => {
  const f = fixture(), delayed = deferred<LocalExchangeResult>();
  f.setHandler(async request => request.kind === "begin_watch" ? delayed.promise : f.defaultReply(request));
  const client = f.make(), done = assert.rejects(f.run(client), errorCode("HANDOFF_UNSUPPORTED"));
  await until(() => f.calls.length === 1); f.original.abort();
  await done;
  assert.equal(client.cleanupState, "confirmed");
  assert.equal(f.calls[1]?.signal, undefined);
  delayed.resolve(f.defaultReply(f.calls[0]!.request));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(client.cleanupState, "confirmed"); assert.equal(f.captures, 0);
  assert.equal(f.calls.filter(call => call.request.kind === "begin_watch").length, 1);
});

test("original expiry during capture still sends exact watch cancellation with new fixed cleanup deadline", async () => {
  const f = fixture(); f.setCapture(() => { f.clock.advance(2001); f.original.abort(); f.native.abort(); });
  const client = f.make();
  await assert.rejects(f.run(client), errorCode("HANDOFF_EXPIRED"));
  const cancelled = f.calls.at(-1)!;
  assert.equal(cancelled.purpose, "cleanup"); assert.equal(cancelled.deadline, 2251); assert.equal(cancelled.signal, undefined);
  if (cancelled.request.kind === "cancel_watch") assert.deepEqual(cancelled.request.reference, { mode: "watch", watch: f.tuple });
  assert.equal(client.cleanupState, "confirmed");
  assert.equal(f.calls.filter(call => call.request.kind === "bind_target").length, 0);
});

test("EOF seals session and pending begin stays cleanup unknown without reconnect", async () => {
  const f = fixture(), hanging = deferred<LocalExchangeResult>();
  f.setHandler(async () => hanging.promise);
  const client = f.make(), done = assert.rejects(f.run(client), errorCode("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"));
  await until(() => f.calls.length === 1);
  f.native.abort(); f.lossClosed.abort(); f.eof.abort(); // Fake Windows-owned EOF invalidates all watches independently.
  await done;
  assert.equal(client.cleanupState, "unknown"); assert.equal(f.calls.length, 1);
  assert.equal(client.subscriptionState, "released");
  await assert.rejects(client.beginWatch("40", 2000, f.original.signal));
  hanging.resolve(f.defaultReply(f.calls[0]!.request));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(f.calls.length, 1); assert.equal(client.cleanupState, "unknown");
});

test("cleanup ACK loss ends at one finite absolute deadline and never extends/retries", async () => {
  const f = fixture(), cleanup = deferred<LocalExchangeResult>();
  f.setHandler(async request => request.kind === "cancel_watch" ? cleanup.promise
    : { kind: "failure", reason: "offline", delivery: "unknown" });
  const client = f.make(), done = assert.rejects(f.run(client), errorCode("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"));
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1]!.deadline, 1250); f.clock.advance(1250); await done;
  assert.equal(client.cleanupState, "unknown"); assert.equal(f.calls.length, 2);
  cleanup.resolve(f.defaultReply(f.calls[1]!.request));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(client.cleanupState, "unknown"); assert.equal(f.calls.length, 2); assert.equal(f.clock.timers.size, 0);
});

test("pre-armed loss is retained; subscription loss seals session instead of reviving a watch", async () => {
  for (const loss of ["native", "subscription"] as const) {
    const f = fixture();
    f.setHandler(async request => {
      if (request.kind === "begin_watch") {
        (loss === "native" ? f.native : f.lossClosed).abort();
        if (loss === "native") f.control({ kind: "watch_lost", session: f.session, beginCallId: request.callId,
          originalTuple: f.tuple, reason: "window_destroyed" });
      }
      return f.defaultReply(request);
    });
    const client = f.make();
    await assert.rejects(f.run(client), errorCode(loss === "native" ? "HANDOFF_UNSUPPORTED" : "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"));
    assert.equal(client.cleanupState, loss === "native" ? "confirmed" : "unknown"); assert.equal(f.captures, 0);
    assert.equal(f.calls.at(-1)?.purpose, loss === "native" ? "cleanup" : "request");
  }
});

test("corrupted reply/session and unconfirmed cleanup error cannot become success or leak details", async () => {
  for (const corrupt of ["parse", "session", "cancelled"] as const) {
    const f = fixture();
    f.setHandler(async request => {
      if (request.kind === "cancel_watch") return { kind: "failure", reason: "offline", delivery: "unknown" };
      if (corrupt === "parse") return { kind: "reply", session: f.session, bytes: "private nonjson" };
      if (corrupt === "session") return { kind: "reply", session: {}, bytes: encodeLocalReply({ version: 1, callId: request.callId, outcome: "armed", watch: f.tuple }) };
      return { kind: "reply", session: f.session, bytes: encodeLocalReply({ version: 1, callId: request.callId, outcome: "cancelled",
        reference: { mode: "begin", beginCallId: 1, hostRegistrationId: f.tuple.hostRegistrationId } }) };
    });
    const client = f.make();
    await assert.rejects(f.run(client), errorCode("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"));
    assert.equal(client.cleanupState, "unknown"); assert.equal(f.captures, 0);
  }
});

test("duplicate cancel uses one original receipt and one bounded exchange even after handle mutation", async () => {
  const f = fixture(), client = f.make(); const result = await f.run(client);
  Object.assign(result.watch, { watchId: "changed", expiresAt: 999999 }); result.watch.identity.hwnd = "99";
  f.original.abort(); f.native.abort();
  await Promise.all([client.cancelWatch(result.watch), client.cancelWatch(result.watch)]);
  assert.equal(f.calls.filter(call => call.request.kind === "cancel_watch").length, 1);
  const cancelled = f.calls.at(-1)!.request;
  if (cancelled.kind === "cancel_watch") assert.deepEqual(cancelled.reference, { mode: "watch", watch: f.tuple });
  assert.equal(client.cleanupState, "confirmed"); assert.equal(f.clock.timers.size, 0);
});

test("wrong-session/unknown-call/other-tuple/unknown control seal the original session", async () => {
  for (const mismatch of ["session", "call", "tuple", "kind"] as const) {
    const f = fixture();
    f.setHandler(async request => {
      if (request.kind === "begin_watch") {
        const control = { kind: "watch_lost", session: mismatch === "session" ? {} : f.session,
          beginCallId: mismatch === "call" ? 99 : request.callId, reason: "anchor_lost",
          originalTuple: mismatch === "tuple" ? { ...f.tuple, identity: { ...f.tuple.identity, hwnd: "41" } } : f.tuple };
        f.control({ ...control, kind: mismatch === "kind" ? "unknown" : control.kind } as LocalControl);
      }
      return f.defaultReply(request);
    });
    const client = f.make();
    await assert.rejects(f.run(client), errorCode("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"));
    assert.equal(client.cleanupState, "unknown"); assert.equal(f.closes, 1); assert.equal(f.captures, 0);
    assert.equal(f.calls.length, 1);
  }
});

test("old-session/call/tuple and missing lifetime cannot supply a watch signal", async () => {
  for (const mismatch of ["session", "call", "tuple", "missing"] as const) {
    const f = fixture();
    f.setHandler(async request => {
      const result = f.defaultReply(request);
      if (request.kind !== "begin_watch" || result.kind !== "reply") return result;
      const life = result.watchLifetime!;
      return { ...result, watchLifetime: mismatch === "missing" ? undefined : { ...life,
        session: mismatch === "session" ? {} : f.session, beginCallId: mismatch === "call" ? 99 : request.callId,
        originalTuple: mismatch === "tuple" ? { ...f.tuple, identity: { ...f.tuple.identity, createdAt: "1970-01-01T00:00:00.0010001Z" } } : f.tuple } };
    });
    const client = f.make();
    await assert.rejects(f.run(client), errorCode("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"));
    assert.equal(client.cleanupState, "unknown"); assert.equal(f.closes, 1); assert.equal(f.captures, 0);
  }
});

test("received buffer and lifetime originals are snapshotted before subsequent mutation", async () => {
  const f = fixture(); let changed: Uint8Array | undefined;
  f.setHandler(async request => {
    const result = f.defaultReply(request);
    if (request.kind !== "begin_watch" || result.kind !== "reply") return result;
    const bytes = new TextEncoder().encode(result.bytes as string); changed = bytes;
    const tuple = structuredClone(f.tuple);
    const lifetime: LocalWatchLifetime = { session: f.session, beginCallId: request.callId, originalTuple: tuple,
      get invalidated() { bytes.fill(0); tuple.identity.hwnd = "99"; return f.native.signal; } };
    return { ...result, bytes, watchLifetime: lifetime };
  });
  const client = f.make(), result = await f.run(client);
  assert.ok(changed?.every(value => value === 0));
  assert.equal(result.watch.identity.hwnd, "40"); assert.strictEqual(result.watch.signal, f.native.signal);
  await client.cancelWatch(result.watch); assert.equal(client.cleanupState, "confirmed");
});
