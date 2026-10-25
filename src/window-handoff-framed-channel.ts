// Unpublished client-side composition. The injected pipe owns authentication/native lifetimes.
import { FrameV2Decoder, LocalFrameV2 } from "./window-handoff-frame-v2.js";
import type { FrameWait } from "./window-handoff-frame-v2.js";
import { decodeLocalReply, decodeLocalRequest } from "./window-handoff-local-codec.js";
import type { LocalRequest, LocalReply, LocalWatchTuple } from "./window-handoff-local-codec.js";
import type { LocalFramedClientClock } from "./window-handoff-local-clock.js";
import { LocalClockError } from "./window-handoff-local-clock.js";
import type { LocalAuthenticatedChannel, LocalControl, LocalControlSubscription, LocalExchangeResult,
  LocalTransportFailure, LocalWait, LocalWaitBudget, LocalWatchLifetime, LocalWatchLoss } from "./window-handoff-session-port.js";

export type AuthenticatedFrameEvent =
  | { readonly kind: "bytes"; readonly session: object; readonly bytes: Uint8Array }
  | { readonly kind: "eof"; readonly session: object };
export type FrameWriteResult = { readonly kind: "written" }
  | { readonly kind: "failure"; readonly reason: LocalTransportFailure; readonly delivery: "not_sent" | "unknown" };
export interface AuthenticatedFramePipe {
  readonly session: object;
  readonly hostRegistrationId: string;
  readonly closed: AbortSignal;
  subscribe(receive: (event: AuthenticatedFrameEvent) => void): LocalControlSubscription;
  // Invoke prepare exactly once, at the real write boundary. A thrown prepare sends zero bytes.
  // A written result means the whole frame was written; never reconnect/retry internally.
  write(prepare: () => Uint8Array): Promise<FrameWriteResult>;
  // The original authenticated/native provider supplies this signal; the adapter cannot issue it.
  watchLifetime(beginCallId: number, originalTuple: LocalWatchTuple): LocalWatchLifetime | undefined;
  close(): Promise<void>; // Session seal only, not an owner cleanup ACK.
}
const same = (a: unknown, b: unknown): boolean => {
  const normalize = (v: unknown): unknown => v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, child]) => [k, normalize(child)])) : v;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};
const tuple = (value: LocalWatchTuple): LocalWatchTuple => Object.freeze({ ...value, identity: Object.freeze({ ...value.identity }) });
const fail = (reason: LocalTransportFailure, started: boolean): LocalExchangeResult =>
  Object.freeze({ kind: "failure", reason, delivery: started ? "unknown" : "not_sent" });
const framedSessions = new WeakSet<object>(); // One framing/call namespace per authenticated connection.
interface Begin { readonly request: Extract<LocalRequest, { kind: "begin_watch" }>; watch?: LocalWatchTuple; lost: boolean; cancelling: boolean }
interface Call {
  readonly request: LocalRequest; readonly body: Uint8Array; readonly wait: FrameWait;
  readonly token: LocalWaitBudget; readonly signal?: AbortSignal;
  started: boolean; written: boolean; done: boolean; replied: boolean;
  reply?: { bytes: Uint8Array; lifetime?: LocalWatchLifetime };
  finish(result: LocalExchangeResult): void;
}

/** Client half of the fixed Windows v2 state/SessionPort contract. No default pipe. */
export class FramedLocalAuthenticatedChannel implements LocalAuthenticatedChannel {
  readonly session: object;
  readonly hostRegistrationId: string;
  readonly #write: AuthenticatedFramePipe["write"];
  readonly #lifetime: AuthenticatedFramePipe["watchLifetime"];
  readonly #pipeClose: AuthenticatedFramePipe["close"];
  readonly #clock: LocalFramedClientClock;
  readonly #decoder = new FrameV2Decoder("host_to_client");
  readonly #closed = new AbortController(); // Local transport termination, never watch readiness.
  readonly #listeners = new Set<(control: LocalControl) => void>();
  readonly #calls = new Map<number, Call>();
  readonly #begins = new Map<number, Begin>();
  readonly #subscription: LocalControlSubscription;
  #tail = Promise.resolve();
  #state: "new" | "hello" | "welcome" | "ready" | "acknowledged" | "established" | "sealed" = "new";
  #lastCall = 0;
  #open?: Promise<boolean>;
  #close?: Promise<void>;
  #closeState: "not_requested" | "pending" | "completed" | "failed" = "not_requested";
  #subscriptionState: "held" | "released" | "release_failed" = "held";
  #welcome?: () => void;
  #readyAck?: () => void;
  #handshakeBudget?: LocalWaitBudget;
  constructor(pipe: AuthenticatedFramePipe, clock: LocalFramedClientClock) {
    const { session, hostRegistrationId, closed } = pipe;
    if (!session || typeof session !== "object" || framedSessions.has(session)
      || !/^[a-f0-9]{32}$/u.test(hostRegistrationId) || !(closed instanceof AbortSignal))
      throw new Error("HANDOFF_INVALID");
    framedSessions.add(session);
    this.session = session; this.hostRegistrationId = hostRegistrationId;
    this.#clock = Object.freeze({ now: clock.now.bind(clock), startRequest: clock.startRequest.bind(clock),
      startCleanup: clock.startCleanup.bind(clock), remaining: clock.remaining.bind(clock), atBudget: clock.atBudget.bind(clock),
      startBoundedWait: clock.startBoundedWait.bind(clock), framePoint: clock.framePoint.bind(clock) });
    this.#write = pipe.write.bind(pipe); this.#lifetime = pipe.watchLifetime.bind(pipe); this.#pipeClose = pipe.close.bind(pipe);
    try {
      this.#subscription = pipe.subscribe(event => this.#receive(event));
      if (!(this.#subscription.lost instanceof AbortSignal)) throw new Error("HANDOFF_INVALID");
    } catch { this.#seal("protocol_invalid"); throw new Error("HANDOFF_INVALID"); }
    closed.addEventListener("abort", () => this.#seal("peer_eof"), { once: true });
    this.#subscription.lost.addEventListener("abort", () => this.#seal("peer_eof"), { once: true });
    if (closed.aborted || this.#subscription.lost.aborted) this.#seal("peer_eof");
    if (this.#closed.signal.aborted) this.#release();
    Object.freeze(this);
  }
  get closed() { return this.#closed.signal; }
  get established() { return this.#state === "established" && !this.#closed.signal.aborted; }
  get closeState() { return this.#closeState; }
  get subscriptionState() { return this.#subscriptionState; }
  subscribeControl(receive: (control: LocalControl) => void): LocalControlSubscription {
    if (this.#closed.signal.aborted) throw new Error("HANDOFF_INVALID");
    this.#listeners.add(receive);
    return Object.freeze({ lost: this.#closed.signal, dispose: () => { this.#listeners.delete(receive); } });
  }
  #emit(control: LocalControl): void {
    // Each consumer gets owned metadata; no consumer can mutate a later delivery.
    for (const receive of [...this.#listeners]) receive(control.kind === "watch_lost"
      ? Object.freeze({ ...control, originalTuple: tuple(control.originalTuple) }) : Object.freeze({ ...control }));
  }
  #seal(reason: LocalTransportFailure): void {
    if (this.#state === "sealed") return;
    this.#state = "sealed"; this.#decoder.seal();
    for (const call of this.#calls.values()) call.finish(fail(reason, call.started));
    this.#closed.abort();
    this.#release();
    this.#requestClose();
  }
  #release(): void {
    if (!this.#subscription || this.#subscriptionState !== "held") return;
    this.#subscriptionState = "released";
    try { this.#subscription.dispose(); } catch { this.#subscriptionState = "release_failed"; }
  }
  #requestClose(): Promise<void> {
    if (!this.#close) {
      const reservation = Promise.withResolvers<void>(); this.#close = reservation.promise;
      this.#closeState = "pending";
      // Record completion privately; closing a channel does not confirm backend reclamation.
      const failed = () => { this.#closeState = "failed"; reservation.reject(new Error("HANDOFF_CLOSE_UNCONFIRMED")); };
      try { void this.#pipeClose().then(() => { this.#closeState = "completed"; reservation.resolve(); }, failed); }
      catch { failed(); }
      void this.#close.catch(() => {});
    }
    return this.#close;
  }
  close(): Promise<void> { this.#seal("session_closed"); return this.#requestClose(); }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation);
    this.#tail = pending.then(() => {}, () => {});
    return pending;
  }
  #remaining(token: LocalWaitBudget) {
    if (this.#closed.signal.aborted) throw new Error("HANDOFF_INVALID");
    const remaining = this.#clock.remaining(token);
    if (this.#closed.signal.aborted) throw new Error("HANDOFF_INVALID");
    return remaining;
  }
  open(absoluteDeadline: number): Promise<boolean> {
    if (this.#open) return this.#open;
    const reservation = Promise.withResolvers<boolean>(); this.#open = reservation.promise;
    void this.#handshake(absoluteDeadline).then(reservation.resolve, () => { this.#seal("protocol_invalid"); reservation.resolve(false); });
    return this.#open;
  }
  async #handshake(deadline: number): Promise<boolean> {
    if (this.#state !== "new") return false;
    const token = this.#clock.startRequest(deadline); this.#handshakeBudget = token;
    const welcome = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
    this.#welcome = welcome.resolve; this.#readyAck = ready.resolve;
    const termination = Promise.withResolvers<void>();
    const expired = () => { this.#seal("deadline_expired"); termination.resolve(); };
    const closed = () => termination.resolve();
    this.#closed.signal.addEventListener("abort", closed, { once: true });
    let stop = () => {};
    const send = (tag: 1 | 3, value: object, state: "hello" | "ready") => this.#enqueue(async () => {
      const body = new TextEncoder().encode(JSON.stringify(value));
      let prepared = false;
      const result = await this.#write(() => {
        this.#remaining(token); if (prepared) throw new Error("HANDOFF_INVALID");
        prepared = true; this.#state = state;
        return new LocalFrameV2(tag, body, null, "client_to_host").encode();
      });
      this.#remaining(token);
      if (!prepared || result.kind !== "written") throw new Error("HANDOFF_INVALID");
    });
    try {
      stop = this.#clock.atBudget(token, expired);
      await Promise.race([(async () => {
        await send(1, { version: 1, capability: "window_handoff_local_v1" }, "hello"); await welcome.promise;
        await send(3, { version: 1, capability: "window_handoff_local_v1", hostRegistrationId: this.hostRegistrationId }, "ready");
        await ready.promise; this.#remaining(token); this.#state = "established";
      })(), termination.promise.then(() => { throw new Error("HANDOFF_INVALID"); })]);
      return this.established;
    } finally { stop(); this.#closed.signal.removeEventListener("abort", closed); this.#welcome = this.#readyAck = undefined; }
  }
  #matches(begin: Begin, watch: LocalWatchTuple): boolean {
    return watch.hostRegistrationId === this.hostRegistrationId && watch.identity.hwnd === begin.request.hint && watch.expiresAt <= begin.request.deadline;
  }
  #find(reference: { mode: "begin"; beginCallId: number; hostRegistrationId: string } | { mode: "watch"; watch: LocalWatchTuple }): Begin {
    if (reference.mode === "begin") {
      const begin = this.#begins.get(reference.beginCallId);
      if (!begin || reference.hostRegistrationId !== this.hostRegistrationId) throw new Error("HANDOFF_INVALID");
      return begin;
    }
    const matches = [...this.#begins.values()].filter(begin => begin.watch && same(begin.watch, reference.watch));
    if (matches.length !== 1) throw new Error("HANDOFF_INVALID");
    return matches[0]!;
  }
  exchange(bytes: string, suppliedWait: LocalWait): Promise<LocalExchangeResult> {
    // Reserve/copy before any foreign clock/pipe callback. Frame bytes are built only at actual write.
    let request: LocalRequest, body: Uint8Array, wait: FrameWait, signal: AbortSignal | undefined, token: LocalWaitBudget;
    try {
      if (!this.established || this.#listeners.size === 0) return Promise.resolve(fail("offline", false));
      body = new TextEncoder().encode(bytes); request = decodeLocalRequest(body);
      const { purpose, absoluteDeadline, maximumWaitMs } = suppliedWait;
      signal = purpose === "request" ? suppliedWait.originalAbort : undefined;
      wait = new LocalFrameV2(16, body, { purpose, absoluteDeadline, maximumWaitMs }, "client_to_host").wait!;
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("HANDOFF_INVALID");
      if (request.callId <= this.#lastCall) throw new Error("HANDOFF_INVALID");
      if (request.kind === "begin_watch") {
        if (request.hostRegistrationId !== this.hostRegistrationId) throw new Error("HANDOFF_INVALID");
        this.#begins.set(request.callId, { request, lost: false, cancelling: false });
      } else if (request.kind === "cancel_watch") this.#find(request.reference).cancelling = true;
      else {
        const begin = this.#find({ mode: "watch", watch: request.watch });
        if (begin.lost || begin.cancelling || request.deadline !== begin.request.deadline) throw new Error("HANDOFF_INVALID");
      }
      this.#lastCall = request.callId;
      token = this.#clock.startBoundedWait(wait.absoluteDeadline, wait.maximumWaitMs);
    } catch (error) {
      if (error instanceof LocalClockError && error.code === "HANDOFF_EXPIRED") return Promise.resolve(fail("deadline_expired", false));
      this.#seal("protocol_invalid"); return Promise.resolve(fail("protocol_invalid", false));
    }
    const reservation = Promise.withResolvers<LocalExchangeResult>();
    let stop = () => {};
    const aborted = () => call.finish(fail("request_aborted", call.started));
    const call: Call = { request, body, wait, token, signal, started: false, written: false, done: false, replied: false,
      finish: result => {
        if (call.done) return;
        call.done = true; stop(); signal?.removeEventListener("abort", aborted); reservation.resolve(result);
      } };
    this.#calls.set(request.callId, call);
    try {
      stop = this.#clock.atBudget(token, () => call.finish(fail("deadline_expired", call.started)));
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      if (call.done) { stop(); return reservation.promise; }
      void this.#enqueue(async () => {
        if (call.done) return;
        try {
          const result = await this.#write(() => {
            if (call.done || signal?.aborted || call.started) throw new Error("HANDOFF_INVALID");
            const remaining = this.#remaining(token);
            const owned = new LocalFrameV2(16, body, { ...wait, maximumWaitMs: remaining.maximumWaitMs }, "client_to_host").encode();
            call.started = true; // From this boundary onward absence cannot be inferred.
            return owned;
          });
          if (result.kind !== "written") {
            // A post-boundary not_sent claim is inconsistent; keep unknown and seal.
            if (call.started && result.delivery === "not_sent") this.#seal("protocol_invalid");
            call.finish(fail(result.reason, call.started || result.delivery === "unknown")); return;
          }
          if (!call.started) { this.#seal("protocol_invalid"); return; }
          call.written = true; this.#deliver(call);
        } catch { call.finish(fail("io_failed", call.started)); }
      });
    } catch { call.finish(fail("deadline_expired", call.started)); }
    return reservation.promise;
  }
  #deliver(call: Call): void {
    if (call.done || !call.written || !call.reply) return;
    try {
      this.#remaining(call.token);
      call.finish(Object.freeze({ kind: "reply", session: this.session, bytes: new Uint8Array(call.reply.bytes), watchLifetime: call.reply.lifetime }));
    } catch { call.finish(fail("deadline_expired", call.started)); }
  }
  #reply(frame: LocalFrameV2): void {
    const reply: LocalReply = decodeLocalReply(frame.bodySnapshot()), call = this.#calls.get(reply.callId);
    if (!call || !call.started || call.replied) throw new Error("HANDOFF_INVALID");
    const request = call.request;
    let life: LocalWatchLifetime | undefined;
    if (reply.outcome !== "error") {
      if (request.kind === "cancel_watch") {
        if (reply.outcome !== "cancelled" || !same(request.reference, reply.reference)) throw new Error("HANDOFF_INVALID");
      } else if (request.kind === "begin_watch") {
        const begin = this.#begins.get(request.callId)!;
        if (reply.outcome !== "armed" || begin.cancelling || begin.lost || !this.#matches(begin, reply.watch)
          || (begin.watch && !same(begin.watch, reply.watch))) throw new Error("HANDOFF_INVALID");
        begin.watch = tuple(reply.watch);
        const supplied = this.#lifetime(request.callId, tuple(reply.watch));
        if (!supplied) throw new Error("HANDOFF_INVALID");
        const { session, beginCallId, originalTuple, invalidated, loss } = supplied;
        life = Object.freeze({ session, beginCallId, originalTuple: tuple(originalTuple), invalidated, loss });
        if (session !== this.session || beginCallId !== request.callId || !same(life.originalTuple, begin.watch)
          || !(invalidated instanceof AbortSignal) || ((begin.lost || loss !== undefined) && !invalidated.aborted)) throw new Error("HANDOFF_INVALID");
      } else {
        const begin = this.#find({ mode: "watch", watch: request.watch });
        if (reply.outcome !== (request.kind === "assert_current" ? "current" : "bound") || !("watch" in reply)
          || !same(request.watch, reply.watch) || begin.lost || begin.cancelling) throw new Error("HANDOFF_INVALID");
      }
    }
    call.replied = true; call.reply = { bytes: frame.bodySnapshot(), lifetime: life };
    this.#deliver(call); // Fully owned bytes; no await allows caller aliases to change them.
  }
  #receive(event: AuthenticatedFrameEvent): void {
    try {
      if (this.#state === "sealed") return;
      const { session, kind } = event;
      if (session !== this.session) throw new Error("HANDOFF_INVALID");
      if (kind === "eof") { this.#decoder.endOfInput(); this.#seal("peer_eof"); return; }
      if (kind !== "bytes") throw new Error("HANDOFF_INVALID");
      const bytes = event.bytes;
      if (!(bytes instanceof Uint8Array)) throw new Error("HANDOFF_INVALID");
      const owned = new Uint8Array(bytes), frames = this.#decoder.feed(owned, this.#clock.framePoint());
      for (const frame of frames) {
        if (frame.tag === 2 && this.#state === "hello") {
          this.#remaining(this.#handshakeBudget!);
          const value = frame.valueSnapshot() as { hostRegistrationId: string };
          if (value.hostRegistrationId !== this.hostRegistrationId) throw new Error("HANDOFF_INVALID");
          this.#state = "welcome"; this.#welcome!();
        } else if (frame.tag === 4 && this.#state === "ready") {
          this.#remaining(this.#handshakeBudget!);
          const value = frame.valueSnapshot() as { hostRegistrationId: string };
          if (value.hostRegistrationId !== this.hostRegistrationId) throw new Error("HANDOFF_INVALID");
          this.#state = "acknowledged";
          this.#readyAck!(); // The full strict frame, not its first byte, completes client admission.
        } else if (this.#state !== "established") throw new Error("HANDOFF_INVALID");
        else if (frame.tag === 17) this.#reply(frame);
        else if (frame.tag === 32) {
          const loss = frame.valueSnapshot() as { beginCallId: number; watch: LocalWatchTuple; reason: LocalWatchLoss };
          const begin = this.#begins.get(loss.beginCallId);
          if (!begin || begin.lost || !this.#matches(begin, loss.watch) || (begin.watch && !same(begin.watch, loss.watch))) throw new Error("HANDOFF_INVALID");
          begin.watch = tuple(loss.watch); begin.lost = true;
          this.#emit({ kind: "watch_lost", session: this.session, beginCallId: loss.beginCallId, originalTuple: begin.watch, reason: loss.reason });
        } else if (frame.tag === 33) {
          const end = frame.valueSnapshot() as { reason: LocalTransportFailure };
          this.#emit({ kind: "session_ended", session: this.session, reason: end.reason }); this.#seal(end.reason);
        } else throw new Error("HANDOFF_INVALID");
      }
    } catch { this.#seal("protocol_invalid"); }
  }
}
