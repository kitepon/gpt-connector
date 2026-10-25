// Pure byte/stream candidate for quolu/OL-RemoteWindow@30aea928. No session/auth/native implementation.
import { z } from "zod";
import { decodeLocalJsonValue, decodeLocalReply, decodeLocalRequest, localWatchTupleSchema } from "./window-handoff-local-codec.js";
import type { LocalRequest } from "./window-handoff-local-codec.js";

export type FrameDirection = "client_to_host" | "host_to_client";
export type FrameTag = 1 | 2 | 3 | 4 | 16 | 17 | 32 | 33;
export interface FrameWait { readonly purpose: "request" | "cleanup"; readonly absoluteDeadline: number; readonly maximumWaitMs: number }
export interface FramePoint { readonly rawUtcMs: number; readonly monotonicMs: number; readonly domain: object }
export class FrameV2Error extends Error {
  constructor(readonly code: "HANDOFF_INVALID" | "HANDOFF_EXPIRED" = "HANDOFF_INVALID") { super(code); this.name = "FrameV2Error"; }
}
const invalid = (): never => { throw new FrameV2Error(); };
const expired = (): never => { throw new FrameV2Error("HANDOFF_EXPIRED"); };
const tags = new Set<number>([1, 2, 3, 4, 16, 17, 32, 33]);
const clientTags = new Set<number>([1, 3, 16]);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const registration = z.string().regex(/^[a-f0-9]{32}$/u);
const hello = z.object({ version: z.literal(1), capability: z.literal("window_handoff_local_v1") }).strict();
const handshake = hello.extend({ hostRegistrationId: registration }).strict();
const lost = z.object({ version: z.literal(1), type: z.literal("watch_lost"), beginCallId: positive, watch: localWatchTupleSchema,
  reason: z.enum(["window_destroyed", "process_exited", "anchor_lost", "monitor_lost", "registration_changed", "deadline_expired", "session_closed"]) }).strict();
const ended = z.object({ version: z.literal(1), type: z.literal("session_ended"),
  reason: z.enum(["offline", "request_aborted", "deadline_expired", "peer_eof", "io_failed", "protocol_invalid", "session_closed"]) }).strict();
const waitSchema = z.object({ purpose: z.enum(["request", "cleanup"]), absoluteDeadline: positive, maximumWaitMs: positive }).strict();
function direction(tag: number, lane: FrameDirection): asserts tag is FrameTag {
  if (!tags.has(tag) || !["client_to_host", "host_to_client"].includes(lane)
    || clientTags.has(tag) !== (lane === "client_to_host")) invalid();
}
function parseBody(tag: FrameTag, bytes: Uint8Array): unknown {
  if (tag === 16) return decodeLocalRequest(bytes);
  if (tag === 17) return decodeLocalReply(bytes);
  const value = decodeLocalJsonValue(bytes);
  const parsed = (tag === 1 ? hello : tag === 32 ? lost : tag === 33 ? ended : handshake).safeParse(value);
  return parsed.success ? parsed.data : invalid();
}
function headerWait(tag: FrameTag, supplied: FrameWait | null): FrameWait | null {
  if (tag !== 16) return supplied === null ? null : invalid();
  const parsed = waitSchema.safeParse(supplied);
  if (!parsed.success || parsed.data.maximumWaitMs > (parsed.data.purpose === "cleanup" ? 30000 : 120000)) return invalid();
  return Object.freeze(parsed.data);
}
function point(value: FramePoint): FramePoint {
  const fixed = { rawUtcMs: value.rawUtcMs, monotonicMs: value.monotonicMs, domain: value.domain };
  if (!Number.isSafeInteger(fixed.rawUtcMs) || fixed.rawUtcMs <= 0 || !Number.isFinite(fixed.monotonicMs)
    || fixed.monotonicMs < 0 || fixed.monotonicMs > Number.MAX_SAFE_INTEGER || !fixed.domain || typeof fixed.domain !== "object") return invalid();
  return Object.freeze(fixed);
}
class ReceiveBudget {
  readonly #wait: FrameWait;
  readonly #domain: object;
  readonly #deadline: number;
  #previous: number;
  #terminal?: "HANDOFF_INVALID" | "HANDOFF_EXPIRED";
  constructor(wait: FrameWait, first: FramePoint) {
    this.#wait = wait; this.#domain = first.domain; this.#previous = first.monotonicMs;
    const ms = Math.min(wait.maximumWaitMs, Math.max(0, wait.absoluteDeadline - first.rawUtcMs));
    this.#deadline = first.monotonicMs + ms;
    if (this.#deadline > Number.MAX_SAFE_INTEGER) invalid();
  }
  remaining(sample: FramePoint): number {
    if (this.#terminal) throw new FrameV2Error(this.#terminal);
    try {
      const current = point(sample);
      if (current.domain !== this.#domain || current.monotonicMs < this.#previous) return invalid();
      this.#previous = current.monotonicMs;
      const ms = Math.floor(Math.min(this.#deadline - current.monotonicMs, this.#wait.absoluteDeadline - current.rawUtcMs));
      if (ms < 1) return expired();
      return ms;
    } catch (error) { this.#terminal = error instanceof FrameV2Error ? error.code : "HANDOFF_INVALID"; throw new FrameV2Error(this.#terminal); }
  }
}

export class LocalFrameV2 {
  readonly tag: FrameTag;
  readonly wait: FrameWait | null;
  readonly #body: Uint8Array;
  readonly #value: unknown;
  readonly #budget?: ReceiveBudget;
  constructor(tag: FrameTag, body: Uint8Array, wait: FrameWait | null, lane: FrameDirection, budget?: ReceiveBudget) {
    direction(tag, lane);
    if (!(body instanceof Uint8Array) || body.byteLength < 1 || body.byteLength > 4096) invalid();
    this.tag = tag; this.#body = new Uint8Array(body); this.wait = headerWait(tag, wait); this.#budget = budget;
    try { this.#value = parseBody(tag, this.#body); } catch { return invalid(); }
    if (tag === 16) {
      const request = this.#value as LocalRequest;
      if ((request.kind === "cancel_watch") !== (this.wait!.purpose === "cleanup")) invalid();
      if (request.kind !== "cancel_watch" && this.wait!.absoluteDeadline > request.deadline) invalid();
    }
    Object.freeze(this);
  }
  bodySnapshot(): Uint8Array { return new Uint8Array(this.#body); }
  valueSnapshot(): unknown { return structuredClone(this.#value); }
  remaining(sample: FramePoint): number | null { return this.#budget?.remaining(sample) ?? null; }
  encode(): Uint8Array {
    const bytes = new Uint8Array(21 + this.#body.byteLength), view = new DataView(bytes.buffer);
    bytes.set([82, 87, 2, this.tag]); view.setUint32(4, this.#body.byteLength, true);
    if (this.wait) {
      view.setBigUint64(8, BigInt(this.wait.absoluteDeadline), true); view.setUint32(16, this.wait.maximumWaitMs, true);
      bytes[20] = this.wait.purpose === "cleanup" ? 2 : 1;
    }
    bytes.set(this.#body, 21); return bytes;
  }
}

export class FrameV2Decoder {
  readonly #lane: FrameDirection;
  readonly #header = new Uint8Array(21);
  #headerCount = 0; #bodyCount = 0; #body?: Uint8Array;
  #first?: FramePoint; #maximumRaw = 0; #domain?: object; #previous = -1;
  #wait: FrameWait | null = null; #budget?: ReceiveBudget;
  #sealed = false;
  constructor(lane: FrameDirection) { if (!["client_to_host", "host_to_client"].includes(lane)) invalid(); this.#lane = lane; }
  get sealed() { return this.#sealed; }
  seal(): void { this.#sealed = true; this.#body = undefined; this.#headerCount = this.#bodyCount = 0; this.#wait = null; this.#budget = undefined; }
  #parseHeader(current: FramePoint): void {
    const h = this.#header, view = new DataView(h.buffer);
    if (h[0] !== 82 || h[1] !== 87 || h[2] !== 2) invalid();
    const tag = h[3]!; direction(tag, this.#lane);
    const length = view.getUint32(4, true), absolute = view.getBigUint64(8, true), cap = view.getUint32(16, true), purpose = h[20]!;
    if (length < 1 || length > 4096 || absolute > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    if (tag === 16) {
      if (purpose !== 1 && purpose !== 2) invalid();
      this.#wait = headerWait(tag, { purpose: purpose === 1 ? "request" : "cleanup", absoluteDeadline: Number(absolute), maximumWaitMs: cap });
      if (this.#maximumRaw >= this.#wait!.absoluteDeadline) expired();
      this.#budget = new ReceiveBudget(this.#wait!, this.#first!);
      this.#budget.remaining(current);
    } else {
      if (absolute !== 0n || cap !== 0 || purpose !== 0) invalid();
      this.#wait = null;
    }
    // Size/Wait/first-byte budget are validated before allocating even one body.
    this.#body = new Uint8Array(length);
  }
  feed(input: Uint8Array, observation: FramePoint): LocalFrameV2[] {
    if (this.#sealed) return invalid();
    try {
      if (!(input instanceof Uint8Array)) invalid();
      const current = point(observation);
      if ((this.#domain && current.domain !== this.#domain) || current.monotonicMs < this.#previous) invalid();
      this.#domain = current.domain; this.#previous = current.monotonicMs;
      if (this.#headerCount > 0) this.#maximumRaw = Math.max(this.#maximumRaw, current.rawUtcMs);
      this.#budget?.remaining(current);
      const output: LocalFrameV2[] = [];
      let cursor = 0;
      while (cursor < input.byteLength) {
        if (this.#headerCount === 0) { this.#first = current; this.#maximumRaw = current.rawUtcMs; }
        if (this.#headerCount < 21) {
          const count = Math.min(21 - this.#headerCount, input.byteLength - cursor);
          this.#header.set(input.subarray(cursor, cursor + count), this.#headerCount); this.#headerCount += count; cursor += count;
          if (this.#headerCount < 21) continue;
          this.#parseHeader(current); this.#budget?.remaining(current);
        }
        const count = Math.min(this.#body!.byteLength - this.#bodyCount, input.byteLength - cursor);
        this.#body!.set(input.subarray(cursor, cursor + count), this.#bodyCount); this.#bodyCount += count; cursor += count;
        if (this.#bodyCount !== this.#body!.byteLength) continue;
        this.#budget?.remaining(current);
        output.push(new LocalFrameV2(this.#header[3]! as FrameTag, this.#body!, this.#wait, this.#lane, this.#budget));
        this.#headerCount = this.#bodyCount = 0; this.#body = undefined; this.#budget = undefined; this.#wait = null;
      }
      return output;
    } catch (error) { this.seal(); throw error instanceof FrameV2Error ? error : new FrameV2Error(); }
  }
  endOfInput(): void { const partial = this.#headerCount !== 0; this.seal(); if (partial) invalid(); }
}
