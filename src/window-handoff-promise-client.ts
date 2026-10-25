// Unpublished composition candidate. No pipe, handshake, CLI import or native implementation.
import { WindowHandoffInputError } from "./window-handoff-input.js";
import type { ArmedWindowWatch, WindowHandoffInputPorts, LocalWindowBinding } from "./window-handoff-input.js";
import { decodeLocalReply, decodeLocalRequest } from "./window-handoff-local-codec.js";
import type { LocalWatchTuple } from "./window-handoff-local-codec.js";
import { LocalHandoffReceiptMap, LocalReceiptError } from "./window-handoff-local-receipts.js";
import type { LocalPendingCall } from "./window-handoff-local-receipts.js";

import { encodeLocalReply } from "./window-handoff-local-codec.js";
import type { LocalAuthenticatedChannel, LocalClientClock, LocalControl, LocalControlSubscription,
  LocalWatchLifetime, LocalWatchLoss } from "./window-handoff-session-port.js";

export type BeginTransportState = "not_called" | "not_sent" | "unknown" | "reply_received";
interface FlowControl { readonly callId: number; tuple?: LocalWatchTuple; lossTuple?: LocalWatchTuple;
  loss?: LocalWatchLoss; lifetime?: LocalWatchLifetime }
const sameTuple = (a: LocalWatchTuple, b: LocalWatchTuple) => encodeLocalReply({ version: 1, callId: 1, outcome: "armed", watch: a })
  === encodeLocalReply({ version: 1, callId: 1, outcome: "armed", watch: b });
const fixedTuple = (tuple: LocalWatchTuple): LocalWatchTuple => {
  const decoded = decodeLocalReply(encodeLocalReply({ version: 1, callId: 1, outcome: "armed", watch: tuple }));
  if (decoded.outcome !== "armed") throw failure();
  return Object.freeze({ ...decoded.watch, identity: Object.freeze({ ...decoded.watch.identity }) });
};
const losses = new Set(["window_destroyed", "process_exited", "anchor_lost", "monitor_lost", "registration_changed", "deadline_expired", "session_closed"]);
interface WatchContext { readonly deadline: number; readonly signal?: AbortSignal; readonly watchSignal: AbortSignal }
const failure = (code: "HANDOFF_UNSUPPORTED" | "HANDOFF_EXPIRED" | "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED" = "HANDOFF_UNSUPPORTED") => new WindowHandoffInputError(code);
const safeError = (error: unknown): WindowHandoffInputError => {
  if (error instanceof WindowHandoffInputError) return error;
  if (error instanceof LocalReceiptError) {
    switch (error.code) {
      case "HANDOFF_INVALID": case "HANDOFF_EXPIRED": case "HANDOFF_BINDING_INVALID":
      case "HANDOFF_UNSUPPORTED": case "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED": return new WindowHandoffInputError(error.code);
    }
  }
  return failure();
};

export class PromiseWindowHandoffClient implements WindowHandoffInputPorts {
  readonly #session: object;
  readonly #closed: AbortSignal;
  readonly #subscription?: LocalControlSubscription;
  readonly #subscriptionLost: AbortSignal;
  #subscriptionState: "held" | "released" | "release_failed" = "held";
  readonly #sealed = new AbortController(); // Local wait termination only, never a watch-readiness signal.
  readonly #channelClose: LocalAuthenticatedChannel["close"];
  readonly #flows = new Map<number, FlowControl>();
  #closeState: "not_requested" | "pending" | "completed" | "failed" = "not_requested";
  readonly #exchange: LocalAuthenticatedChannel["exchange"];
  readonly #now: LocalClientClock["now"];
  readonly #at: LocalClientClock["at"];
  readonly #capture: WindowHandoffInputPorts["capture"];
  readonly #budget: number;
  readonly #map: LocalHandoffReceiptMap;
  readonly #watches = new WeakMap<ArmedWindowWatch, WatchContext>();
  readonly #cancels = new WeakMap<ArmedWindowWatch, Promise<void>>();
  readonly #delivery = new WeakMap<LocalPendingCall, BeginTransportState>();
  #begin?: LocalPendingCall;

  constructor(options: { channel: LocalAuthenticatedChannel; clock: LocalClientClock;
    cleanupBudgetMs: number; capture: WindowHandoffInputPorts["capture"] }) {
    const { channel, clock, cleanupBudgetMs, capture } = options;
    const { session, hostRegistrationId, closed } = channel;
    if (!(closed instanceof AbortSignal)
      || !Number.isSafeInteger(cleanupBudgetMs) || cleanupBudgetMs <= 0 || cleanupBudgetMs > 30_000) throw failure();
    this.#session = session; this.#closed = closed;
    this.#channelClose = channel.close.bind(channel); this.#exchange = channel.exchange.bind(channel);
    this.#now = clock.now.bind(clock); this.#at = clock.at.bind(clock); this.#capture = capture;
    this.#budget = cleanupBudgetMs; this.#map = new LocalHandoffReceiptMap(session, hostRegistrationId, this.#now);
    try { this.#subscription = channel.subscribeControl(control => this.#control(control)); }
    catch { this.#seal(); throw failure(); }
    this.#subscriptionLost = this.#subscription.lost;
    if (!(this.#subscriptionLost instanceof AbortSignal)) { this.#seal(); throw failure(); }
    if (this.#sealed.signal.aborted) this.#releaseSubscription();
    if (closed.aborted || this.#subscriptionLost.aborted) this.#seal();
    else {
      closed.addEventListener("abort", () => this.#seal(), { once: true });
      this.#subscriptionLost.addEventListener("abort", () => this.#seal(), { once: true });
    }
  }
  #seal(): void {
    this.#map.close(); this.#sealed.abort();
    if (this.#closeState !== "not_requested") return;
    this.#closeState = "pending";
    this.#releaseSubscription();
    try { void this.#channelClose().then(() => { this.#closeState = "completed"; }, () => { this.#closeState = "failed"; }); }
    catch { this.#closeState = "failed"; }
  }
  #releaseSubscription(): void {
    if (!this.#subscription || this.#subscriptionState !== "held") return;
    this.#subscriptionState = "released";
    try { this.#subscription.dispose(); } catch { this.#subscriptionState = "release_failed"; }
  }
  #control(control: LocalControl): void {
    try {
      if (this.#sealed.signal.aborted) return;
      if (control.session !== this.#session || control.kind !== "watch_lost") { this.#seal(); return; }
      const flow = this.#flows.get(control.beginCallId);
      if (!flow || !losses.has(control.reason)) { this.#seal(); return; }
      const tuple = fixedTuple(control.originalTuple);
      if ((flow.tuple && !sameTuple(flow.tuple, tuple)) || (flow.lossTuple && !sameTuple(flow.lossTuple, tuple))) { this.#seal(); return; }
      flow.lossTuple = tuple; flow.loss = control.reason;
      if (flow.lifetime && !flow.lifetime.invalidated.aborted) this.#seal();
    } catch { this.#seal(); }
  }
  #time(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value <= 0) throw failure();
    return value;
  }
  #bounded<T>(operation: () => Promise<T>, deadline: number, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let stop = () => {};
      const sources = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
      const finish = (error?: WindowHandoffInputError, result?: T) => {
        if (settled) return;
        settled = true; stop();
        for (const source of sources) source.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(result as T);
      };
      const aborted = () => finish(failure());
      try {
        if (!Number.isSafeInteger(deadline) || this.#time() >= deadline) { finish(failure("HANDOFF_EXPIRED")); return; }
        for (const source of sources) {
          source.addEventListener("abort", aborted, { once: true });
          if (source.aborted) { finish(failure()); return; }
        }
        stop = this.#at(deadline, () => finish(failure("HANDOFF_EXPIRED")));
        if (settled) { stop(); return; }
        // The port owns actual I/O termination. Late completion can never settle this call again.
        void operation().then(result => {
          try {
            if (this.#time() >= deadline) finish(failure("HANDOFF_EXPIRED"));
            else if (sources.some(signal => signal.aborted)) finish(failure());
            else finish(undefined, result);
          } catch { finish(failure()); }
        }, error => finish(safeError(error)));
      } catch { finish(failure()); }
    });
  }
  async #rpc(call: LocalPendingCall, deadline: number, purpose: "request" | "cleanup",
    signal?: AbortSignal, watchSignal?: AbortSignal): Promise<ArmedWindowWatch | undefined> {
    const sources = purpose === "cleanup" ? [this.#closed, this.#sealed.signal] : [this.#closed, this.#sealed.signal, this.#subscriptionLost, signal, watchSignal];
    const envelope = await this.#bounded(async () => {
      this.#delivery.set(call, "unknown"); // Invocation/throw alone proves no absence.
      const result = await this.#exchange(call.bytes, purpose === "request"
        ? Object.freeze({ absoluteDeadline: deadline, purpose, originalAbort: signal })
        : Object.freeze({ absoluteDeadline: deadline, purpose }));
      if (result.kind === "failure") {
        this.#delivery.set(call, result.delivery === "not_sent" ? "not_sent" : "unknown");
        if (["peer_eof", "io_failed", "protocol_invalid", "session_closed"].includes(result.reason)) this.#seal();
        throw failure(result.reason === "deadline_expired" ? "HANDOFF_EXPIRED" : "HANDOFF_UNSUPPORTED");
      }
      this.#delivery.set(call, "reply_received");
      if (result.kind !== "reply") { this.#seal(); throw failure(); }
      // Own bytes/session/lifetime before the next await/consumer can mutate the source buffer.
      try {
        const life = result.watchLifetime, bytes = result.bytes;
        if (typeof bytes !== "string" && (!(bytes instanceof Uint8Array) || bytes.byteLength > 4096)) throw failure();
        return Object.freeze({ kind: "reply" as const, session: result.session,
          bytes: typeof bytes === "string" ? bytes : new Uint8Array(bytes),
          watchLifetime: life && Object.freeze({ session: life.session, beginCallId: life.beginCallId,
            originalTuple: fixedTuple(life.originalTuple), invalidated: life.invalidated, loss: life.loss }) });
      } catch { this.#seal(); throw failure(); }
    }, deadline, sources);
    if (this.#time() >= deadline) throw failure("HANDOFF_EXPIRED");
    let nativeSignal: AbortSignal | undefined;
    let wire;
    try { wire = decodeLocalReply(envelope.bytes); } catch { this.#seal(); throw failure(); }
    const request = decodeLocalRequest(call.bytes);
    if (envelope.session !== this.#session || wire.callId !== request.callId) { this.#seal(); throw failure(); }
    if (envelope.watchLifetime && (request.kind !== "begin_watch" || wire.outcome !== "armed")) { this.#seal(); throw failure(); }
    if (request.kind === "begin_watch" && wire.outcome === "armed") {
      if (wire.watch.hostRegistrationId !== request.hostRegistrationId || wire.watch.identity.hwnd !== request.hint
        || wire.watch.expiresAt > request.deadline) { this.#seal(); throw failure(); }
      if (this.#time() >= wire.watch.expiresAt) throw failure("HANDOFF_EXPIRED");
      const tuple = fixedTuple(wire.watch), flow = this.#flows.get(request.callId), life = envelope.watchLifetime;
      if (!flow || !life || life.session !== this.#session || life.beginCallId !== request.callId
        || !sameTuple(life.originalTuple, tuple) || !(life.invalidated instanceof AbortSignal)
        || (flow.lossTuple && !sameTuple(flow.lossTuple, tuple))) { this.#seal(); throw failure(); }
      nativeSignal = life.invalidated;
      flow.tuple = tuple; flow.lifetime = life;
      if (flow.loss || life.loss !== undefined || nativeSignal.aborted || this.#subscriptionLost.aborted || this.#sealed.signal.aborted) throw failure();
    }
    try { return this.#map.accept(envelope.session, call, envelope.bytes, nativeSignal); }
    catch (error) { if (error instanceof LocalReceiptError && error.code === "HANDOFF_BINDING_INVALID") this.#seal(); throw error; }
  }
  async #cleanup(makeCall: () => LocalPendingCall): Promise<void> {
    // Fixed once for this cleanup; independent of request abort, watch loss, and original expiry.
    try {
      const deadline = this.#time() + this.#budget;
      if (!Number.isSafeInteger(deadline)) throw failure();
      const call = makeCall();
      await this.#rpc(call, deadline, "cleanup");
      if (this.#map.cleanup(call) !== "confirmed") throw failure();
    } catch { this.#seal(); throw failure("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"); }
  }
  async beginWatch(hint: string, deadline: number, signal?: AbortSignal): Promise<ArmedWindowWatch> {
    let call: LocalPendingCall | undefined;
    try {
      const started = this.#time();
      if (!Number.isSafeInteger(deadline) || deadline <= started || deadline - started > 120_000) throw failure("HANDOFF_EXPIRED");
      if (signal?.aborted || this.#closed.aborted || this.#sealed.signal.aborted || this.#subscriptionLost.aborted) throw failure();
      call = this.#map.beginWatch(hint, deadline, signal); this.#begin = call;
      const request = decodeLocalRequest(call.bytes);
      this.#flows.set(request.callId, { callId: request.callId });
      const watch = await this.#rpc(call, deadline, "request", signal);
      if (!watch) throw failure();
      this.#watches.set(watch, Object.freeze({ deadline, signal, watchSignal: watch.signal }));
      return watch;
    } catch (error) {
      if (call) await this.#cleanup(() => this.#map.cancelUnknownBegin(call!));
      const original = safeError(error);
      // A later exact owner ACK has resolved the cleanup uncertainty, while begin still failed.
      if (call && original.code === "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED") throw failure();
      throw original;
    }
  }
  #context(watch: ArmedWindowWatch, deadline: number, signal?: AbortSignal): WatchContext {
    const context = this.#watches.get(watch);
    if (!context || context.deadline !== deadline || context.signal !== signal) throw failure();
    return context;
  }
  async assertCurrent(watch: ArmedWindowWatch, deadline: number, signal?: AbortSignal): Promise<void> {
    try {
      const context = this.#context(watch, deadline, signal);
      await this.#rpc(this.#map.assertCurrent(watch, deadline, signal), deadline, "request", signal, context.watchSignal);
    } catch (error) { throw safeError(error); }
  }
  async bindTarget(watch: ArmedWindowWatch, binding: LocalWindowBinding, deadline: number, signal?: AbortSignal): Promise<void> {
    try {
      const context = this.#context(watch, deadline, signal);
      await this.#rpc(this.#map.bindTarget(watch, binding, deadline, signal), deadline, "request", signal, context.watchSignal);
    } catch (error) { throw safeError(error); }
  }
  async capture(watch: ArmedWindowWatch, deadline: number, signal?: AbortSignal) {
    const context = this.#context(watch, deadline, signal);
    return this.#bounded(() => this.#capture(watch, deadline, signal), deadline,
      [signal, context.watchSignal, this.#closed, this.#sealed.signal, this.#subscriptionLost]);
  }
  cancelWatch(watch: ArmedWindowWatch): Promise<void> {
    if (!this.#watches.has(watch)) return Promise.reject(failure("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"));
    let pending = this.#cancels.get(watch);
    if (!pending) {
      // Reserve ownership before clock/transport/native callbacks can reenter.
      const reservation = Promise.withResolvers<void>();
      pending = reservation.promise;
      this.#cancels.set(watch, pending);
      void this.#cleanup(() => this.#map.cancelWatch(watch)).then(reservation.resolve, reservation.reject);
    }
    return pending;
  }
  get cleanupState(): "not_started" | "unknown" | "confirmed" {
    return this.#begin ? this.#map.cleanup(this.#begin) : "not_started";
  }
  get closeState() { return this.#closeState; }
  get subscriptionState() { return this.#subscriptionState; }
  get beginTransportState(): BeginTransportState { return this.#begin ? this.#delivery.get(this.#begin) ?? "not_called" : "not_called"; }
}
