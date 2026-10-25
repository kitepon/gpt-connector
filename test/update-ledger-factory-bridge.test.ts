import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { canonical, sha256, type LedgerPlan } from "../src/update-ledger-contract.js";
import { factoryCanonical, runSetupWithFactoryReceipt, type FactoryBridgePorts, type FactorySources } from "../src/update-ledger-factory-bridge.js";
import type { ProviderScope, ReadLease } from "../src/update-ledger-provider-ports.js";

const writerPath = process.env.GPT_LEDGER_WRITER_SOURCE;
const fixedWriter = "42c11b7d1626ceee330766262b242e8ab0b9db8d5a2b52d27907d3085303120f";
const writer: { canonicalDeployment(value: unknown): string; readDeployment(...args: unknown[]): Promise<{ status: string; normal_result?: Awaited<ReturnType<typeof runSetupWithFactoryReceipt>> }> } | null = writerPath
  ? (assert.equal(sha256(await readFile(writerPath)), fixedWriter), await import(pathToFileURL(writerPath).href)) : null;
const generation = "33333333-3333-4333-8333-333333333333", run = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-25T06:00:00.100Z";
function fixture(digestKind: "tree" | "artifact" = "tree") {
  const plan: LedgerPlan = { identity: { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner: { system: "bellteam", id: "bot-7696018a" }, execution_prefix: "/synthetic/npm/lib/node_modules/gpt-connector" },
    source_wire_agreement_ref: "synthetic-source", health_agreement_ref: "synthetic-health", required_clients: ["claude"],
    targets: [{ component: "connector", target: { kind: "npm", name: "gpt-connector", series: "0.16" }, adoption_ref: "synthetic-adoption" }] };
  const scope: ProviderScope = { execution_package_root: plan.identity.execution_prefix, mutation_resources: ["/synthetic/npm"], expectedGeneration: generation,
    coverage_ref: "synthetic-all-writers-original", deadline: Date.parse(at) + 1000 };
  const identity = { product_id: plan.identity.product_id, host_id: plan.identity.host_id, owner: plan.identity.owner };
  const adoption = { evidence_ref: "synthetic-adoption-original", targets: plan.targets, Z: "case-sensitive-byte-order", a: "not-locale-order" };
  const raw = { payload: { schema: "factory.deployment-receipt.v1", identity, execution_package_root: scope.execution_package_root, mutation_resources: scope.mutation_resources!,
    deployment_generation: generation, manifest_sha256: "a".repeat(64), artifact_or_tree_sha256: (digestKind === "tree" ? "b" : "d").repeat(64), deployment_revision: "synthetic-actual-artifact",
    provenance_evidence_ref: "synthetic-provenance-original", adopted_targets_sha256: sha256(factoryCanonical(adoption)), issued_at: at },
    issuer_id: "synthetic-existing-issuer", evidence_ref: "synthetic-issued-receipt", proof: { attestation: "synthetic-no-new-key" } };
  const state = { schema: "factory.deployment-state.v1", identity, execution_package_root: scope.execution_package_root, mutation_resources: scope.mutation_resources!, generation, phase: "committed", receipt: raw };
  const provenanceOriginal = { factory_payload_sha256: sha256(factoryCanonical(raw.payload)), provenance_evidence_ref: raw.payload.provenance_evidence_ref,
    artifact_or_tree_kind: digestKind, tree_sha256: "b".repeat(64), artifact_sha256: "d".repeat(64), node_runtime: null };
  const provenance = { ...provenanceOriginal, artifact_source_sha256: sha256(factoryCanonical(provenanceOriginal)) };
  const coverage = { mutation_resources: scope.mutation_resources, coverage_ref: scope.coverage_ref, all_writers: true };
  const source = (payload: unknown, view: unknown) => ({ original: { payload, provenance: { existing: "synthetic-trust" } }, view, issuer: "synthetic-existing-resolver" });
  const sources: FactorySources = { provenance: source(provenanceOriginal, provenance), adoption: source(adoption, { targets: plan.targets }), coverage: source({ agreement: coverage }, coverage) };
  const events: string[] = [], abort = new AbortController(); let held = false, publicCalls = 0, acquisitions = 0;
  const lease: ReadLease = { mode: "SH", resources: scope.mutation_resources!, generation, signal: abort.signal, assertCurrent: async () => { assert.ok(held); } };
  const now = () => Date.parse(at);
  const bridge: FactoryBridgePorts = {
    readState: async () => { assert.ok(held); return structuredClone(state); },
    verifyReceipt: async packet => { assert.ok(held); assert.deepEqual(packet, raw); events.push("verify-original-subject");
      return { status: "verified", subject_sha256: sha256(factoryCanonical(raw.payload)), issuer: raw.issuer_id, trust_ref: "synthetic-factory-trust" }; },
    readSources: async () => { assert.ok(held); return structuredClone(sources); },
    verifySource: async (_kind, source) => ({ status: "verified", subject_sha256: sha256(factoryCanonical(source.original.payload)), view_sha256: sha256(canonical(source.view)), issuer: source.issuer, trust_ref: "synthetic-source-trust" }),
    provider: {
      now, clock: () => at, uuid: () => run,
      inspectInstalled: async () => { assert.ok(held); return { identity: plan.identity, execution_package_root: scope.execution_package_root, mutation_resources: scope.mutation_resources,
        generation, manifest_sha256: raw.payload.manifest_sha256, tree_sha256: provenance.tree_sha256, artifact_source_sha256: provenance.artifact_source_sha256,
        target_adoption_sha256: raw.payload.adopted_targets_sha256, target_projection_sha256: sha256(canonical(plan.targets)), node_runtime: null }; },
      readAcceptance: async (context, result) => ({ payload: { schema: "gpt-connector.normal-acceptance.v1", identity: plan.identity, generation, deployment_revision: raw.payload.deployment_revision,
        run_id: context.run_id, mode: context.mode, observed_at: at, result_sha256: sha256(canonical(result)), required_clients: plan.required_clients, raw_health: true, normal_path: true,
        passed: true, issuer: "synthetic-normal-acceptor", evidence_ref: "synthetic-same-run-original" }, provenance: null }),
      verifyAcceptance: async packet => ({ status: "verified", subject_sha256: sha256(canonical(packet.payload)), issuer: "synthetic-normal-acceptor", trust_ref: "synthetic-acceptance-trust" }),
      publicSetup: async options => {
        assert.ok(held); publicCalls++; events.push("public-setup");
        const mode = options.check ? "check" : "setup", start = options.updateLedger!.begin(mode);
        const normal = { schema: "gpt-connector.setup.v1", version: "0.16.3", overall: "ready", registrations: [{ client: "claude", stateRead: "ready", mcp: { status: "ready" }, live: { status: "ready" } }] };
        const updateLedger = await options.updateLedger!.complete(start, mode, normal);
        assert.ok(held); events.push("hook-complete"); return { ...normal, updateLedger };
      },
      sampleInstalled: async (adopted, runId, deployment, health) => {
        await Promise.resolve(); assert.ok(held); events.push("collector");
        return { identity: adopted.identity, run_id: runId, observed_at: at, source: { kind: "installed-package", name: "gpt-connector", installed: "0.16.3", manifest_sha256: deployment.manifest_sha256,
          deployment_revision: deployment.deployment_revision, deployment_evidence_ref: deployment.evidence_ref }, bindings: [{ component: "connector", target: adopted.targets[0]!.target, installed: "0.16.3", status: "active" }], health };
      },
    },
  };
  const writerPorts = { clock: now, withReadLease: async (_r: unknown, _g: unknown, _d: unknown, fn: (lease: ReadLease) => Promise<unknown>) => {
    acquisitions++; assert.equal(held, false); held = true; events.push("SH-acquired");
    try { return await fn(lease); } finally { events.push("SH-released"); held = false; }
  }, store: { load: async () => structuredClone(state) }, verifyCurrent: async () => { assert.ok(held); } };
  const input = { identity, execution_package_root: scope.execution_package_root, mutation_resources: scope.mutation_resources, deadline: scope.deadline };
  const execute = () => writer!.readDeployment(input, { status: "committed", generation, receipt: raw }, writerPorts,
    (borrowed: ReadLease, receipt: unknown) => runSetupWithFactoryReceipt(plan, scope, borrowed, receipt, bridge));
  return { plan, scope, raw, state, provenance, sources, bridge, lease, abort, events, execute, calls: () => ({ acquisitions, publicCalls }) };
}

test("fixed factory reader passes its sole held SH through normalized view, same-run collector and settled hook", { skip: !writer }, async () => {
  const f = fixture();
  assert.equal(factoryCanonical(f.sources.adoption!.original.payload), writer!.canonicalDeployment(f.sources.adoption!.original.payload));
  assert.notEqual(factoryCanonical(f.sources.adoption!.original.payload), canonical(f.sources.adoption!.original.payload));
  const result = await f.execute(), normal = result.normal_result!;
  assert.equal(result.status, "completed"); assert.equal(normal.provider.status, "verified-source", JSON.stringify(normal)); assert.equal(normal.bridge.status, "verified-view");
  assert.deepEqual(f.calls(), { acquisitions: 1, publicCalls: 1 }); assert.equal(f.events.at(-1), "SH-released");
  assert.ok(f.events.indexOf("hook-complete") > f.events.indexOf("collector"));
  const proof = normal.bridge.proof!;
  assert.equal(proof.factory_payload_sha256, sha256(writer!.canonicalDeployment(f.raw.payload)));
  assert.equal(proof.factory_receipt_sha256, sha256(writer!.canonicalDeployment(f.raw)));
  assert.notEqual(proof.view_sha256, proof.factory_payload_sha256);
  assert.equal(proof.source_subjects.adoption.original_sha256, f.raw.payload.adopted_targets_sha256);
});

test("missing originals, raw-subject mismatch and unverified source projection block before public setup", { skip: !writer }, async () => {
  for (const kind of ["missing", "raw-subject", "projection", "unknown-trust"] as const) {
    const f = fixture();
    if (kind === "missing") f.sources.provenance = null;
    if (kind === "raw-subject") f.bridge.verifyReceipt = async () => ({ status: "verified", subject_sha256: "0".repeat(64), issuer: f.raw.issuer_id, trust_ref: "synthetic" });
    if (kind === "projection" || kind === "unknown-trust") {
      const verify = f.bridge.verifySource;
      f.bridge.verifySource = async (...args) => ({ ...await verify(...args), ...(kind === "projection" ? { view_sha256: "0".repeat(64) } : { status: "unknown" as const, trust_ref: null }) });
    }
    const result = (await f.execute()).normal_result!;
    assert.equal(result.provider.status, "blocked"); assert.equal(result.bridge.status, "blocked"); assert.equal(f.calls().publicCalls, 0); assert.equal(f.events.at(-1), "SH-released");
  }
});

test("ambiguous artifact/tree kind, plan-derived adoption and unaccepted writer coverage cannot fill missing fields", { skip: !writer }, async () => {
  for (const kind of ["digest-kind", "source-subject", "adoption-whole", "adoption-projection", "coverage"] as const) {
    const f = fixture();
    if (kind === "digest-kind") (f.sources.provenance!.view as Record<string, unknown>).artifact_or_tree_kind = "unknown";
    if (kind === "source-subject") (f.sources.provenance!.view as Record<string, unknown>).artifact_source_sha256 = "e".repeat(64);
    if (kind === "adoption-whole") f.sources.adoption!.original.payload = { targets: f.plan.targets };
    if (kind === "adoption-projection") (f.sources.adoption!.view as Record<string, unknown>).targets = [];
    if (kind === "coverage") (f.sources.coverage!.view as Record<string, unknown>).all_writers = false;
    const result = (await f.execute()).normal_result!;
    assert.equal(result.provider.status, "blocked"); assert.equal(f.calls().publicCalls, 0); assert.equal(f.events.at(-1), "SH-released");
  }
});

test("minimal writer lease alone supplies no reader metadata; changed committed store is rejected without reacquisition", { skip: !writer }, async () => {
  for (const kind of ["lease-metadata", "state", "generation"] as const) {
    const f = fixture();
    if (kind === "lease-metadata") delete (f.lease as Partial<ReadLease>).mode;
    if (kind === "generation") f.lease.generation = "44444444-4444-4444-8444-444444444444";
    if (kind === "state") f.bridge.readState = async () => ({ ...structuredClone(f.state), phase: "mutating" });
    const result = (await f.execute()).normal_result!;
    assert.equal(result.provider.status, "blocked"); assert.deepEqual(f.calls(), { acquisitions: 1, publicCalls: 0 }); assert.equal(f.events.at(-1), "SH-released");
  }
});

test("lease loss inside same-run provider settles before writer releases and preserves normal ready result", { skip: !writer }, async () => {
  const f = fixture(), read = f.bridge.provider.readAcceptance;
  f.bridge.provider.readAcceptance = async (...args) => { const result = await read(...args); f.abort.abort(); return result; };
  const result = await f.execute(), normal = result.normal_result!;
  assert.equal(result.status, "blocked"); assert.equal(normal.result!.overall, "ready"); assert.equal(normal.provider.status, "blocked");
  assert.equal(f.calls().acquisitions, 1); assert.equal(f.events.at(-1), "SH-released"); assert.ok(!f.events.includes("collector"));
});


test("artifact bytes digest stays distinct from tree and artifact-source original subject", { skip: !writer }, async () => {
  const f = fixture("artifact"), result = (await f.execute()).normal_result!;
  assert.equal(result.provider.status, "verified-source"); assert.equal(result.bridge.status, "verified-view");
  assert.notEqual(f.provenance.artifact_source_sha256, f.raw.payload.artifact_or_tree_sha256);
  assert.notEqual(f.provenance.artifact_source_sha256, f.provenance.tree_sha256);
  assert.equal(result.bridge.proof!.source_subjects.provenance.original_sha256, f.provenance.artifact_source_sha256);
  assert.equal(f.raw.payload.artifact_or_tree_sha256, f.provenance.artifact_sha256);
});
