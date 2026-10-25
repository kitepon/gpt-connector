import { canonical, collectSnapshot, sha256, type CurrentProduct, type LedgerPlan, type RuntimeMeasurement, type SetupCompletion } from "../../src/update-ledger-contract.js";
import type { JournalState } from "../../src/update-ledger-journal.js";

export function nativeJournalFixture() {
  const at = "2026-10-25T08:00:00.000Z", runId = "11111111-1111-4111-8111-111111111111";
  const owner = { system: "bellteam", id: "bot-7696018a" } as const;
  const plan: LedgerPlan = { identity: { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner, execution_prefix: "/synthetic/native-fixture" },
    source_wire_agreement_ref: "synthetic-source-only", health_agreement_ref: "synthetic-source-only", required_clients: ["claude"],
    targets: [{ component: "connector", target: { kind: "npm", name: "gpt-connector", series: "0.16" }, adoption_ref: "synthetic-adoption" }] };
  const completion: SetupCompletion = { run: { run_id: runId, mode: "setup", started_at: at, completed_at: at }, result: { schema: "gpt-connector.setup.v1", version: "0.16.3", overall: "ready",
    registrations: [{ client: "claude", stateRead: "ready", mcp: { status: "ready" }, live: { status: "ready" } }] } };
  const measured: RuntimeMeasurement = { identity: plan.identity, run_id: runId, observed_at: at, source: { kind: "installed-package", name: "gpt-connector", installed: "0.16.3",
    deployment_revision: "synthetic-native-fixture", manifest_sha256: "a".repeat(64), deployment_evidence_ref: "synthetic-source-only" },
    bindings: [{ component: "connector", target: plan.targets[0]!.target, installed: "0.16.3", status: "active" }],
    health: { run_id: runId, observed_at: at, raw: true, acceptance: { run_id: runId, observed_at: at, source_revision: "synthetic-native-fixture", execution_prefix: plan.identity.execution_prefix,
      normal_path: true, passed: true, evidence_ref: "synthetic-not-real-health" } } };
  const collected = collectSnapshot(plan, completion, measured);
  const before: CurrentProduct = { product_id: plan.identity.product_id, app: "GPT", owner, version: 1, inventory_version: 0, inventory_max_age_hours: 168,
    created_at: at, updated_at: at, bindings: [] };
  const body = canonical({ request_id: "22222222-2222-4222-8222-222222222222", expected_version: 0, ...collected.observation });
  const prepared: JournalState = { product_id: plan.identity.product_id, owner, run_id: runId, phase: "prepared", body, body_sha256: sha256(body), evidence: collected.evidence,
    before, post_receipt: null, readback: null };
  return { plan, completion, measured, before, prepared, issued: { ...structuredClone(prepared), phase: "issued" as const } };
}
