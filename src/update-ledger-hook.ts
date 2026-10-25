import { randomUUID } from "node:crypto";
import { collectSnapshot, measurementSchema, planSchema, runSchema, type RuntimeMeasurement, type SetupCompletionHook, type SetupRunResult } from "./update-ledger-contract.js";
import { readInstalledMeasurement, type DeploymentReceipt } from "./update-ledger-collector.js";
import { sendSetupSnapshot, type SenderPorts } from "./update-ledger-sender.js";

export interface CompletionPorts {
  measure(start: { run_id: string; started_at: string }, result: SetupRunResult): Promise<unknown>;
  sender?: SenderPorts;
  clock?: () => string;
  uuid?: () => string;
}
const safeReasons = new Set(["ledger_unbound_run", "ledger_identity_mismatch", "ledger_run_mismatch", "ledger_source_mismatch", "ledger_health_unknown",
  "ledger_acceptance_mismatch", "ledger_targets_mismatch", "ledger_installed_unknown", "ledger_source_binding_missing", "ledger_health_contradiction",
  "ledger_transport_identity_mismatch", "ledger_remote_identity_mismatch", "ledger_cas_changed", "ledger_observation_not_fresh", "ledger_run_reused",
  "ledger_journal_locked", "ledger_journal_truncated", "ledger_journal_corrupt", "ledger_journal_capacity", "ledger_deployment_receipt_mismatch", "ledger_prefix_mismatch"]);

/** Explicit source-only composition seam. Default CLI has no plan, sampler, sender or credentials. */
export function createLedgerCompletionHook(planInput: unknown, ports: CompletionPorts): SetupCompletionHook {
  const plan = planSchema.parse(planInput), clock = ports.clock ?? (() => new Date().toISOString());
  const starts = new Map<string, { started_at: string; mode: "setup" | "check" }>();
  return {
    begin(mode) {
      const start = { run_id: (ports.uuid ?? randomUUID)(), started_at: clock() };
      runSchema.parse({ ...start, completed_at: start.started_at, mode: "setup" });
      if (starts.has(start.run_id)) throw new Error("ledger_duplicate_run");
      starts.set(start.run_id, { started_at: start.started_at, mode }); return start;
    },
    async complete(start, mode, result) {
      let measured: unknown;
      try {
        const bound = starts.get(start.run_id);
        if (bound?.started_at !== start.started_at || bound.mode !== mode) throw new Error("ledger_unbound_run");
        starts.delete(start.run_id);
        measured = await ports.measure(structuredClone(start), structuredClone(result));
        const completion = { run: runSchema.parse({ ...start, completed_at: clock(), mode }), result };
        const collected = collectSnapshot(plan, completion, measured);
        // --check stays read-only. It may collect this run but never performs ledger GET/POST or journal writes.
        if (mode === "check" || !ports.sender) return { status: "collected", ...collected };
        const sent = await sendSetupSnapshot(plan, completion, measured, ports.sender);
        if (sent.operation_run_id !== start.run_id) return { status: "previous_operation", previous: sent, current_run_evidence: collected.evidence };
        return { ...sent, evidence: collected.evidence };
      } catch (error) {
        const parsed = measurementSchema.safeParse(measured);
        const reason = error instanceof Error && safeReasons.has(error.message) ? error.message : "ledger_evidence_or_storage_invalid";
        return { status: "blocked", reason, run_id: start.run_id, ...(parsed.success ? { measurement: parsed.data } : {}) };
      }
    },
  };
}

/** Ordinary deployment/check providers supply provenance and health evidence; neither is inferred here. */
export function createInstalledLedgerCompletionHook(planInput: unknown, ports: Omit<CompletionPorts, "measure"> & {
  deployment(start: { run_id: string; started_at: string }): Promise<DeploymentReceipt>;
  health(start: { run_id: string; started_at: string }, result: SetupRunResult): Promise<RuntimeMeasurement["health"]>;
}): SetupCompletionHook {
  const plan = planSchema.parse(planInput);
  return createLedgerCompletionHook(plan, { ...ports, measure: async (start, result) => {
    const deployment = await ports.deployment(start), health = await ports.health(start, result);
    return readInstalledMeasurement(plan, start.run_id, deployment, health, { clock: ports.clock });
  } });
}
