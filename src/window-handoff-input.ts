// Source-only local sequencing. No CLI/IPC/HTTP/OS adapter is installed by this module.
import { z } from "zod";
import { isOwnedChromeProcess } from "./platform/windows-browser.js";
import type { ListenerProcess } from "./platform/browser.js";

const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({
  pid: z.number().int().positive(), createdAt: z.iso.datetime(),
  ownerSid: z.string().regex(/^S-\d+(?:-\d+)+$/u), sessionId: z.number().int().positive(),
  hwnd: z.string().regex(/^[1-9]\d{0,19}$/u).refine(value => BigInt(value) <= 18_446_744_073_709_551_615n),
}).strict();
export type LocalWindowIdentity = z.infer<typeof identitySchema>;
export interface ArmedWindowWatch {
  readonly watchId: string;
  readonly hostRegistrationId: string;
  readonly expiresAt: number;
  readonly identity: LocalWindowIdentity;
  readonly signal: AbortSignal;
}
export interface FreshWindowCapture {
  readonly identity: LocalWindowIdentity;
  readonly listener: ListenerProcess;
  readonly observedAt: number;
  readonly candidateWindowCount: number;
  readonly providerPageCount: number;
  readonly windowClass: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly targetId: string;
  readonly browserWindowId: number;
}
export interface LocalWindowBinding {
  readonly identity: LocalWindowIdentity;
  readonly observedAt: number;
  readonly targetId: string;
  readonly browserWindowId: number;
}
export interface WindowHandoffInputPorts {
  // Production ports must authenticate the local principal and enforce deadline/signal.
  // An HWND hint is never proof. Only the Host can issue/validate this watch.
  beginWatch(hint: string, deadline: number, signal?: AbortSignal): Promise<ArmedWindowWatch>;
  assertCurrent(watch: ArmedWindowWatch, deadline: number, signal?: AbortSignal): Promise<void>;
  capture(watch: ArmedWindowWatch, deadline: number, signal?: AbortSignal): Promise<FreshWindowCapture>;
  bindTarget(watch: ArmedWindowWatch, binding: LocalWindowBinding, deadline: number, signal?: AbortSignal): Promise<void>;
  // Must acknowledge bounded cancellation of this exact watch only, even after admission expiry.
  cancelWatch(watch: ArmedWindowWatch): Promise<void>;
}
type Failure = "HANDOFF_INVALID" | "HANDOFF_EXPIRED" | "HANDOFF_BINDING_INVALID" | "HANDOFF_UNSUPPORTED" | "HANDOFF_LOCAL_CLEANUP_UNCONFIRMED";
export class WindowHandoffInputError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "WindowHandoffInputError"; }
}
const fail = (code: Failure): never => { throw new WindowHandoffInputError(code); };
const sameIdentity = (a: LocalWindowIdentity, b: LocalWindowIdentity) =>
  a.pid === b.pid && a.createdAt === b.createdAt && a.ownerSid === b.ownerSid && a.sessionId === b.sessionId && a.hwnd === b.hwnd;

/** Local-only bound input, not an offer, authorization, public locator, or ready viewer. */
export async function prepareOwnedWindowHandoff(input: {
  hint: string; profile: string; deadline: number; signal?: AbortSignal;
}, ports: WindowHandoffInputPorts, now = Date.now): Promise<{
  watch: ArmedWindowWatch; binding: LocalWindowBinding; deadline: number;
}> {
  // Copy values, not the caller's mutable alias. Keep the original AbortSignal object.
  const request = Object.freeze({ hint: input.hint, profile: input.profile, deadline: input.deadline, signal: input.signal });
  const started = now();
  if (!epoch.safeParse(request.deadline).success || !Number.isSafeInteger(started)
    || request.deadline > started + 120_000 || !/^[1-9]\d{0,19}$/u.test(request.hint)) fail("HANDOFF_INVALID");
  const deadline = request.deadline; // Never refresh after a poll, await, capture, or bind.
  const admission = () => {
    if (now() >= deadline) fail("HANDOFF_EXPIRED");
    if (request.signal?.aborted) fail("HANDOFF_UNSUPPORTED");
  };
  let watch: ArmedWindowWatch | undefined;
  try {
    admission();
    watch = await ports.beginWatch(request.hint, deadline, request.signal);
    const armedAt = now(); admission();
    const identity = identitySchema.safeParse(watch.identity);
    if (!identity.success) throw new WindowHandoffInputError("HANDOFF_UNSUPPORTED");
    if (watch.identity.hwnd !== request.hint || !(watch.signal instanceof AbortSignal)
      || watch.signal.aborted || typeof watch.watchId !== "string" || !watch.watchId || watch.watchId.length > 128
      || !/^[a-f0-9]{32}$/u.test(watch.hostRegistrationId) || !epoch.safeParse(watch.expiresAt).success
      || watch.expiresAt > deadline || now() >= watch.expiresAt) fail("HANDOFF_UNSUPPORTED");
    const fixed = { watchId: watch.watchId, hostRegistrationId: watch.hostRegistrationId,
      expiresAt: watch.expiresAt, identity: Object.freeze(identity.data), signal: watch.signal };
    const check = () => {
      admission();
      if (watch!.signal !== fixed.signal || watch!.signal.aborted || now() >= fixed.expiresAt
        || watch!.watchId !== fixed.watchId || watch!.hostRegistrationId !== fixed.hostRegistrationId
        || watch!.expiresAt !== fixed.expiresAt || !sameIdentity(watch!.identity, fixed.identity)) fail("HANDOFF_BINDING_INVALID");
    };
    const guard = async () => {
      check();
      await ports.assertCurrent(watch!, deadline, request.signal);
      check();
    };
    await guard();
    const capture = await ports.capture(watch, deadline, request.signal);
    check();
    const actual = identitySchema.safeParse(capture.identity);
    if (!actual.success || !sameIdentity(actual.data, fixed.identity) || capture.listener.pid !== String(fixed.identity.pid)
      || !isOwnedChromeProcess(capture.listener, request.profile) || capture.candidateWindowCount !== 1 || capture.providerPageCount !== 1
      || capture.windowClass !== "Chrome_WidgetWin_1" || capture.visible !== true || capture.minimized !== false
      || !epoch.safeParse(capture.observedAt).success || capture.observedAt < armedAt || capture.observedAt > now()
      || Date.parse(actual.data.createdAt) > capture.observedAt
      || typeof capture.targetId !== "string" || !capture.targetId || capture.targetId.length > 128
      || !Number.isSafeInteger(capture.browserWindowId) || capture.browserWindowId <= 0) fail("HANDOFF_BINDING_INVALID");
    const binding = Object.freeze({ identity: fixed.identity, observedAt: capture.observedAt,
      targetId: capture.targetId, browserWindowId: capture.browserWindowId });
    await guard();
    await ports.bindTarget(watch, binding, deadline, request.signal);
    await guard(); // A late bind receipt or lost anchor never becomes a successful result.
    return { watch, binding, deadline };
  } catch (error) {
    if (watch) {
      try { await ports.cancelWatch(watch); } catch { fail("HANDOFF_LOCAL_CLEANUP_UNCONFIRMED"); }
    }
    throw error instanceof WindowHandoffInputError ? error : new WindowHandoffInputError("HANDOFF_UNSUPPORTED");
  }
}
