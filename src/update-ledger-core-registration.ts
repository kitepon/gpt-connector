// Product-owned process registration. A port is not proof of trust or installation.
import { createPublicJsonFrame } from "./public-json.js";
import { createCoreProcessBridge } from "./update-ledger-core-process-bridge.js";
import type { FixedCoreHelperBootstrap } from "./update-ledger-core-process-bridge.js";
import { createProductCoreObserver, createCoreWriteObserver, readOwnCoreRuntime } from "./update-ledger-core-observer.js";
import type { ProductCoreObserverPorts, ProductCoreRun } from "./update-ledger-core-observer-ports.js";

let state: "open" | "registering" | "registered" | "consumed" = "open";
let observer: ProductCoreObserverPorts | undefined;

/** Only the adopted factory preload supplies this object. No default, lookup,
 * environment option or authority is created by registering it. */
export function registerCoreHelperBootstrap(bootstrap: FixedCoreHelperBootstrap): void {
  if (state !== "open") throw new Error("core_registration_unavailable");
  state = "registering"; // Reserve before a foreign start getter can reenter.
  observer = createProductCoreObserver(createCoreProcessBridge(bootstrap));
  state = "registered";
}

interface CoreSetupOutput {
  write(text: string, callback: (error?: Error | null) => void): unknown;
  setExitCode(code: number): void;
}

/** Called once by the installed CLI setup/check branch. The factory must have
 * verified its EX-completed installed receipt before registering under SH.
 * No installation, re-exec, fd loader or trust selector lives in this module. */
export async function runRegisteredCoreSetup<T extends { overall: string }>(
  mode: "setup" | "check", execute: () => Promise<T>, output: CoreSetupOutput,
): Promise<boolean> {
  if (state === "consumed") throw new Error("core_registration_consumed");
  const current = state === "registered" ? observer : undefined;
  state = "consumed"; // Also prohibit late registration after the normal branch chose its path.
  observer = undefined;
  if (!current) return false;
  let run: ProductCoreRun | undefined;
  try {
    const started = await current.beginOwnCore(mode, readOwnCoreRuntime());
    if ("token" in started) run = started;
  } catch { /* Observation unavailable; preserve the original setup invocation. */ }
  const result = await execute(); // An original setup exception is not replaced or retried.
  const exitCode = result.overall === "ready" ? 0 : result.overall === "partial" ? 2 : 1;
  const frame = createPublicJsonFrame(result);
  const write = createCoreWriteObserver(frame, exitCode);
  // A synchronous ordinary write failure still propagates to the original CLI handler.
  try { output.write(frame.text, write.callback); }
  catch (error) {
    write.callback(error instanceof Error ? error : new Error("core_output_failed"));
    throw error;
  }
  output.setExitCode(exitCode);
  const completion = await write.completed;
  if (run) {
    try { await current.completeOwnCore(run, completion); }
    catch { /* Private observation failure cannot replace ordinary body or exit. */ }
  }
  return true;
}
