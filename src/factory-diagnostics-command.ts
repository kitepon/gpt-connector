import { factoryDiagnostics } from "./factory-diagnostics.js";
import type { FactoryDiagnosticsOptions } from "./factory-diagnostics.js";

type Values = ReadonlyMap<string, readonly string[] | true>;
export interface FactoryDiagnosticCommandOptions { readonly includeObservationContext: boolean }
const invalid = (): never => { throw new Error("usage: gpt-connector factory-diagnostics --json [--include-observation-context]"); };

/** Explicit flag on this command only; no environment lookup and no observation. */
export function readFactoryDiagnosticCommandOptions(command: string | undefined, values: Values): FactoryDiagnosticCommandOptions | undefined {
  if (command !== "factory-diagnostics") {
    if (values.has("include-observation-context")) invalid();
    return undefined;
  }
  if (values.get("json") !== true || [...values.keys()].some(key => !["json", "include-observation-context"].includes(key))) invalid();
  const flag = values.get("include-observation-context");
  if (flag !== undefined && flag !== true) invalid();
  return Object.freeze({ includeObservationContext: flag === true });
}

/** The existing exported diagnostic is invoked exactly once; output/status are not rewritten. */
export async function runFactoryDiagnosticCommand(command: FactoryDiagnosticCommandOptions,
  runtime: Pick<FactoryDiagnosticsOptions, "endpoint" | "stateDirectory">,
  diagnose: typeof factoryDiagnostics = factoryDiagnostics): Promise<Awaited<ReturnType<typeof factoryDiagnostics>>> {
  return await diagnose({ ...runtime, includeObservationContext: command.includeObservationContext });
}
