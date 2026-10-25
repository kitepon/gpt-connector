// Independent source candidate; not imported by the CLI or a real channel.
import { performance } from "node:perf_hooks";
import type { LocalClientClock, LocalWaitBudget } from "./window-handoff-session-port.js";

export interface LocalClockSources {
  utcNow(): number;
  monotonicNow(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}
export class LocalClockError extends Error {
  constructor(readonly code: "HANDOFF_CLOCK_INVALID" | "HANDOFF_EXPIRED" = "HANDOFF_CLOCK_INVALID") { super(code); this.name = "LocalClockError"; }
}
interface Budget { readonly utcDeadline: number; readonly monotonicDeadline: number; expired: boolean }
interface Registration {
  readonly budget: Budget;
  active: boolean;
  callback?: () => void;
  ticket?: object;
  timer?: { handle: unknown };
}
const maximumTimerDelay = 2_147_483_647;

/** Raw UTC + private per-operation monotonic budget. No corrected epoch crosses the channel. */
export function createLocalClientClock(sources: LocalClockSources): LocalClientClock {
  const utcNow = sources.utcNow.bind(sources), monotonicNow = sources.monotonicNow.bind(sources);
  const setTimer = sources.setTimer.bind(sources), clearTimer = sources.clearTimer.bind(sources);
  const active = new Set<Registration>();
  let previousMonotonic = -1;
  const budgets = new WeakMap<LocalWaitBudget, Budget>();
  const liveBudgets = new Set<Budget>();
  const sample = () => {
    // Sample monotonic first, so time spent acquiring UTC cannot lengthen this wait.
    const mono = monotonicNow(), utc = utcNow();
    if (!Number.isFinite(mono) || mono < 0 || mono < previousMonotonic || !Number.isSafeInteger(utc) || utc <= 0) throw new LocalClockError();
    previousMonotonic = mono;
    for (const budget of liveBudgets) duration(budget, { mono, utc });
    return { mono, utc };
  };
  const cancel = (entry: Registration) => {
    if (!entry.active) return;
    entry.active = false; active.delete(entry);
    const timer = entry.timer;
    entry.timer = undefined; entry.ticket = undefined; entry.callback = undefined;
    if (timer) clearTimer(timer.handle);
  };
  const duration = (budget: Budget, point: { mono: number; utc: number }) => {
    if (budget.expired) return 0;
    const remaining = Math.floor(Math.min(budget.monotonicDeadline - point.mono, budget.utcDeadline - point.utc));
    if (remaining < 1) { budget.expired = true; liveBudgets.delete(budget); }
    return remaining;
  };
  const due = (entry: Registration, point: ReturnType<typeof sample>) => duration(entry.budget, point) < 1;
  const get = (token: LocalWaitBudget) => {
    const budget = budgets.get(token);
    if (!budget) throw new LocalClockError();
    return budget;
  };
  const create = (utcDeadline: number, limit: number, point: ReturnType<typeof sample>) => {
    const ms = utcDeadline - point.utc;
    if (!Number.isSafeInteger(utcDeadline) || !Number.isSafeInteger(ms) || ms > limit) throw new LocalClockError();
    if (ms < 1) throw new LocalClockError("HANDOFF_EXPIRED");
    const monotonicDeadline = point.mono + ms;
    if (!Number.isFinite(monotonicDeadline) || monotonicDeadline > Number.MAX_SAFE_INTEGER) throw new LocalClockError();
    const token = Object.freeze({}) as LocalWaitBudget;
    const budget: Budget = { utcDeadline, monotonicDeadline, expired: false };
    budgets.set(token, budget); liveBudgets.add(budget);
    return token;
  };
  const fire = (entry: Registration) => {
    if (!entry.active) return;
    const callback = entry.callback;
    cancel(entry); // Remove timer, callback and ticket before invoking foreign/reentrant code.
    callback?.();
  };
  const arm = (entry: Registration, point: ReturnType<typeof sample>) => {
    const ticket = {}; entry.ticket = ticket;
    const remaining = duration(entry.budget, point);
    if (remaining < 1) { fire(entry); return; }
    const delay = Math.min(maximumTimerDelay, remaining);
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
      return point.utc;
    },
    startRequest(absoluteDeadline) { return create(absoluteDeadline, 120_000, sample()); },
    startCleanup(maximumWaitMs) {
      if (!Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 1 || maximumWaitMs > 30_000) throw new LocalClockError();
      const point = sample();
      return create(point.utc + maximumWaitMs, 30_000, point);
    },
    remaining(token) {
      const budget = get(token), ms = duration(budget, sample());
      if (ms < 1) throw new LocalClockError("HANDOFF_EXPIRED");
      return Object.freeze({ absoluteDeadline: budget.utcDeadline, maximumWaitMs: ms });
    },
    atBudget(token, callback) {
      if (typeof callback !== "function") throw new LocalClockError();
      const budget = get(token), point = sample();
      const entry: Registration = { budget, callback, active: true };
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
