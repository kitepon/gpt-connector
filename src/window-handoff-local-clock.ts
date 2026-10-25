// Independent source candidate; not imported by the CLI or a real channel.
import { performance } from "node:perf_hooks";
import type { LocalClientClock } from "./window-handoff-session-port.js";

export interface LocalClockSources {
  utcNow(): number;
  monotonicNow(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}
export class LocalClockError extends Error {
  constructor() { super("HANDOFF_CLOCK_INVALID"); this.name = "LocalClockError"; }
}
interface Registration {
  readonly utcDeadline: number;
  readonly monotonicDeadline: number;
  active: boolean;
  callback?: () => void;
  ticket?: object;
  timer?: { handle: unknown };
}
const maximumTimerDelay = 2_147_483_647;

/** Each at() fixes one monotonic deadline. The returned function destroys only that registration. */
export function createLocalClientClock(sources: LocalClockSources): LocalClientClock {
  const utcNow = sources.utcNow.bind(sources), monotonicNow = sources.monotonicNow.bind(sources);
  const setTimer = sources.setTimer.bind(sources), clearTimer = sources.clearTimer.bind(sources);
  const active = new Set<Registration>();
  let previousMonotonic = -1;
  let epoch: { utc: number; mono: number } | undefined;
  const sample = () => {
    // Sample monotonic first, so time spent acquiring UTC cannot lengthen this wait.
    const mono = monotonicNow(), utc = utcNow();
    if (!Number.isFinite(mono) || mono < 0 || mono < previousMonotonic || !Number.isSafeInteger(utc) || utc <= 0) throw new LocalClockError();
    previousMonotonic = mono;
    const projected = epoch ? epoch.utc + (mono - epoch.mono) : utc;
    const effective = Math.max(utc, projected);
    if (!Number.isFinite(effective) || effective > Number.MAX_SAFE_INTEGER) throw new LocalClockError();
    if (!epoch || utc > projected) epoch = { utc, mono }; // Forward only, never rebase on rollback/read progress.
    return { mono, utc, effective };
  };
  const cancel = (entry: Registration) => {
    if (!entry.active) return;
    entry.active = false; active.delete(entry);
    const timer = entry.timer;
    entry.timer = undefined; entry.ticket = undefined; entry.callback = undefined;
    if (timer) clearTimer(timer.handle);
  };
  const due = (entry: Registration, point: ReturnType<typeof sample>) =>
    point.mono >= entry.monotonicDeadline || point.effective >= entry.utcDeadline;
  const fire = (entry: Registration) => {
    if (!entry.active) return;
    const callback = entry.callback;
    cancel(entry); // Remove timer, callback and ticket before invoking foreign/reentrant code.
    callback?.();
  };
  const arm = (entry: Registration, point: ReturnType<typeof sample>) => {
    const ticket = {}; entry.ticket = ticket;
    const remaining = Math.min(entry.monotonicDeadline - point.mono, entry.utcDeadline - point.effective);
    const delay = Math.max(1, Math.min(maximumTimerDelay, Math.ceil(remaining)));
    let handle: unknown;
    try {
      handle = setTimer(() => {
        if (!entry.active || entry.ticket !== ticket) return; // Ignore stale/duplicate timer delivery.
        const firedTimer = entry.timer;
        entry.timer = undefined; entry.ticket = undefined;
        if (firedTimer) clearTimer(firedTimer.handle);
        try {
          const current = sample();
          if (due(entry, current)) fire(entry); else arm(entry, current); // Original deadline only.
        } catch (error) { cancel(entry); throw error; }
      }, delay);
    } catch (error) { cancel(entry); throw error; }
    if (!entry.active || entry.ticket !== ticket) clearTimer(handle);
    else entry.timer = { handle };
  };
  return {
    now() {
      const point = sample();
      // A reply/admission read after a forward UTC jump expires registered waits first.
      for (const entry of [...active]) if (due(entry, point)) fire(entry);
      // Deadline epoch only, not an observation timestamp. Preserve elapsed time between RPCs too.
      return Math.floor(point.effective);
    },
    at(utcDeadline, callback) {
      if (!Number.isSafeInteger(utcDeadline) || utcDeadline <= 0 || typeof callback !== "function") throw new LocalClockError();
      const point = sample();
      const monotonicDeadline = point.mono + Math.max(0, utcDeadline - point.effective);
      if (!Number.isFinite(monotonicDeadline) || monotonicDeadline > Number.MAX_SAFE_INTEGER) throw new LocalClockError();
      const entry: Registration = { utcDeadline, monotonicDeadline, callback, active: true };
      active.add(entry);
      if (due(entry, point)) fire(entry); else arm(entry, point);
      return () => cancel(entry);
    },
  };
}

/** Acquire Node's actual UTC/performance/timer APIs only on explicit construction.
 * This function supplies an implementation candidate, not evidence of real-time OS acceptance. */
export function createSystemLocalClientClock(): LocalClientClock {
  const utcNow = Date.now.bind(Date), monotonicNow = performance.now.bind(performance);
  const schedule = setTimeout, unschedule = clearTimeout;
  return createLocalClientClock({ utcNow, monotonicNow,
    setTimer: (callback, delayMs) => schedule(callback, delayMs),
    clearTimer: handle => unschedule(handle as ReturnType<typeof setTimeout>),
  });
}
