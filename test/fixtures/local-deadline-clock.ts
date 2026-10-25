// Compatibility for existing synthetic test drivers only; never a product fallback.
import { createLocalClientClock } from "../../src/window-handoff-local-clock.js";
export function fixtureDeadlineClock(driver: { now(): number; at(deadline: number, callback: () => void): () => void }) {
  return createLocalClientClock({ utcNow: () => driver.now(), monotonicNow: () => driver.now(),
    setTimer: (callback, ms) => driver.at(driver.now() + ms, callback),
    clearTimer: handle => (handle as () => void)(),
  });
}
