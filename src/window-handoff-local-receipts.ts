// Pure client correlation only. A fixture session object does not authenticate an OS peer.
import type { ArmedWindowWatch, LocalWindowBinding } from "./window-handoff-input.js";
import { decodeLocalReply, decodeLocalRequest, encodeLocalRequest } from "./window-handoff-local-codec.js";
import type { LocalRequest, LocalWatchTuple } from "./window-handoff-local-codec.js";

export class LocalReceiptError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LocalReceiptError"; }
}
const fail = (code = "HANDOFF_BINDING_INVALID"): never => { throw new LocalReceiptError(code); };
export interface LocalPendingCall { readonly bytes: string }
type Begin = Extract<LocalRequest, { kind: "begin_watch" }>;
interface Flow {
  begin: Begin; requestSignal?: AbortSignal; armedAt?: number; tuple?: LocalWatchTuple;
  watchSignal?: AbortSignal; cancelling: boolean; cleanup: "unknown" | "confirmed";
}
interface Pending { request: LocalRequest; flow: Flow; settled: boolean }
const sessions = new WeakSet<object>();
const canonical = (value: unknown): string => {
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
};
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const immutableTuple = (tuple: LocalWatchTuple): LocalWatchTuple => Object.freeze({ ...tuple, identity: Object.freeze({ ...tuple.identity }) });

/** No transport, timers, signal fabrication, native allocation, or CLI connection. */
export class LocalHandoffReceiptMap {
  readonly #session: object;
  readonly #registration: string;
  readonly #now: () => number;
  #nextCallId = 1;
  #closed = false;
  #flow?: Flow;
  readonly #calls = new WeakMap<LocalPendingCall, Pending>();
  readonly #watches = new WeakMap<ArmedWindowWatch, Flow>();
  constructor(session: object, hostRegistrationId: string, now: () => number) {
    if (!session || typeof session !== "object" || sessions.has(session) || !/^[a-f0-9]{32}$/u.test(hostRegistrationId)) fail("HANDOFF_INVALID");
    this.#session = session; this.#registration = hostRegistrationId; this.#now = now;
    sessions.add(session); // Exactly one callId namespace/registry binding per connection object.
  }
  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now <= 0) fail("HANDOFF_INVALID");
    return now;
  }
  #admit(flow: Flow): void {
    if (this.#closed || flow.cancelling || flow.requestSignal?.aborted || flow.watchSignal?.aborted) fail("HANDOFF_UNSUPPORTED");
    if (this.#time() >= flow.begin.deadline || (flow.tuple && this.#time() >= flow.tuple.expiresAt)) fail("HANDOFF_EXPIRED");
  }
  #call(request: LocalRequest, flow: Flow): LocalPendingCall {
    if (this.#closed || !Number.isSafeInteger(this.#nextCallId)) fail("HANDOFF_UNSUPPORTED");
    const bytes = encodeLocalRequest(request);
    const handle = Object.freeze({ bytes });
    this.#calls.set(handle, { request: decodeLocalRequest(bytes), flow, settled: false });
    this.#nextCallId++;
    return handle;
  }
  #owned(watch: ArmedWindowWatch): Flow { return this.#watches.get(watch) ?? fail(); }
  beginWatch(hint: string, deadline: number, signal?: AbortSignal): LocalPendingCall {
    if (this.#closed || (this.#flow && this.#flow.cleanup !== "confirmed")) fail("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED");
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail("HANDOFF_INVALID");
    const now = this.#time();
    if (!Number.isSafeInteger(deadline) || deadline <= now || deadline - now > 120_000) fail("HANDOFF_EXPIRED");
    const begin: Begin = Object.freeze({ version: 1, callId: this.#nextCallId, kind: "begin_watch", hint, deadline, hostRegistrationId: this.#registration });
    const flow: Flow = { begin, requestSignal: signal, cancelling: false, cleanup: "unknown" };
    this.#admit(flow);
    const call = this.#call(begin, flow);
    this.#flow = flow;
    return call;
  }
  assertCurrent(watch: ArmedWindowWatch, deadline: number, signal?: AbortSignal): LocalPendingCall {
    const flow = this.#owned(watch); this.#admit(flow);
    if (deadline !== flow.begin.deadline || signal !== flow.requestSignal) fail();
    return this.#call({ version: 1, callId: this.#nextCallId, kind: "assert_current", watch: flow.tuple!, deadline }, flow);
  }
  bindTarget(watch: ArmedWindowWatch, binding: LocalWindowBinding, deadline: number, signal?: AbortSignal): LocalPendingCall {
    const flow = this.#owned(watch); this.#admit(flow);
    const fixed = decodeLocalRequest(encodeLocalRequest({ version: 1, callId: this.#nextCallId,
      kind: "bind_target", watch: flow.tuple!, binding, deadline }));
    if (fixed.kind !== "bind_target" || deadline !== flow.begin.deadline || signal !== flow.requestSignal
      || !equal(fixed.binding.identity, flow.tuple!.identity)
      || fixed.binding.observedAt < flow.armedAt! || fixed.binding.observedAt > this.#time()) return fail();
    return this.#call(fixed, flow);
  }
  cancelWatch(watch: ArmedWindowWatch): LocalPendingCall {
    const flow = this.#owned(watch);
    const call = this.#call({ version: 1, callId: this.#nextCallId, kind: "cancel_watch", reference: { mode: "watch", watch: flow.tuple! } }, flow);
    flow.cancelling = true;
    return call;
  }
  cancelUnknownBegin(beginCall: LocalPendingCall): LocalPendingCall {
    const pending = this.#calls.get(beginCall);
    if (!pending || pending.request.kind !== "begin_watch" || pending.flow.tuple) return fail();
    const flow = pending.flow;
    const call = this.#call({ version: 1, callId: this.#nextCallId, kind: "cancel_watch", reference: {
      mode: "begin", beginCallId: flow.begin.callId, hostRegistrationId: flow.begin.hostRegistrationId,
    } }, flow);
    flow.cancelling = true;
    return call;
  }
  /** Future IPC adapter must route each reply on this same opaque authenticated session. */
  accept(session: object, call: LocalPendingCall, bytes: string | Uint8Array, watchSignal?: AbortSignal): ArmedWindowWatch | undefined {
    const pending = this.#calls.get(call);
    if (session !== this.#session || this.#closed || !pending || pending.settled) return fail();
    const reply = decodeLocalReply(bytes);
    const { request, flow } = pending;
    if (reply.callId !== request.callId) return fail();
    if (reply.outcome === "error") {
      pending.settled = true;
      // Even effect=none is not this client's exact cancelled owner ACK.
      // Keep any previous confirmed cleanup monotone.
      return fail(reply.code);
    }
    if (request.kind === "cancel_watch") {
      if (reply.outcome !== "cancelled" || !equal(reply.reference, request.reference)) return fail();
      flow.cleanup = "confirmed"; pending.settled = true; return;
    }
    this.#admit(flow);
    if (request.kind === "begin_watch") {
      if (reply.outcome !== "armed" || !(watchSignal instanceof AbortSignal) || watchSignal.aborted
        || flow.tuple || reply.watch.hostRegistrationId !== request.hostRegistrationId
        || reply.watch.identity.hwnd !== request.hint || reply.watch.expiresAt > request.deadline
        || this.#time() >= reply.watch.expiresAt) return fail();
      const armedAt = this.#time();
      this.#admit(flow);
      if (this.#time() >= reply.watch.expiresAt) return fail("HANDOFF_EXPIRED");
      flow.tuple = immutableTuple(reply.watch); flow.armedAt = armedAt; flow.watchSignal = watchSignal;
      const watch: ArmedWindowWatch = { ...flow.tuple, identity: { ...flow.tuple.identity }, signal: watchSignal };
      this.#watches.set(watch, flow); pending.settled = true; return watch;
    }
    const expected = request.kind === "assert_current" ? "current" : "bound";
    if (reply.outcome !== expected || !("watch" in reply) || !equal(reply.watch, flow.tuple)) return fail();
    this.#admit(flow);
    pending.settled = true;
  }
  cleanup(call: LocalPendingCall): "unknown" | "confirmed" {
    return this.#calls.get(call)?.flow.cleanup ?? fail();
  }
  close(): void { this.#closed = true; } // No native cleanup proof; owner retains pending allocation responsibility.
}
