import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { canonical, sha256, type LedgerPlan } from "../src/update-ledger-contract.js";
import { factoryCanonical, runSetupWithFactoryReceipt, type FactoryBridgePorts, type SourceView } from "../src/update-ledger-factory-bridge.js";
import { createFactoryBundleReader } from "../src/update-ledger-factory-sources.js";
import type { OriginalPacket, ProviderScope, ReadLease } from "../src/update-ledger-provider-ports.js";

const writerPath = process.env.GPT_LEDGER_BUNDLE_WRITER_SOURCE;
type BridgeResult = Awaited<ReturnType<typeof runSetupWithFactoryReceipt>>;
interface WriterResult { status: string; generation: string; receipt: { payload: Record<string, unknown>; issuer_id: string; evidence_ref: string; proof: unknown }; }
const writer: { writeDeployment(...args: unknown[]): Promise<WriterResult>; readDeployment(...args: unknown[]): Promise<{ status: string; normal_result?: BridgeResult }> } | null = writerPath
  ? (assert.equal(sha256(await readFile(writerPath)), "7b4677a5c29ae65462077c50587c06684bb9072f5adebc64b19e74954f3d571a"), await import(pathToFileURL(writerPath).href)) : null;
const generation = "33333333-3333-4333-8333-333333333333", runId = "11111111-1111-4111-8111-111111111111", at = "2026-10-25T06:00:00.100Z";
function fixture(kind: "tree" | "artifact" = "tree") {
  const plan: LedgerPlan = { identity: { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner: { system: "bellteam", id: "bot-7696018a" }, execution_prefix: "/synthetic/npm/lib/node_modules/gpt-connector" },
    source_wire_agreement_ref: "synthetic-wire", health_agreement_ref: "synthetic-health", required_clients: ["claude"], targets: [{ component: "connector", target: { kind: "npm", name: "gpt-connector", series: "0.16" }, adoption_ref: "synthetic-adoption" }] };
  const scope: ProviderScope = { execution_package_root: plan.identity.execution_prefix, mutation_resources: ["/synthetic/npm"], expectedGeneration: generation, coverage_ref: "synthetic-all-writer-coverage", deadline: Date.parse(at) + 1000 };
  const identity = { product_id: plan.identity.product_id, host_id: plan.identity.host_id, owner: plan.identity.owner };
  const manifest = Buffer.from('{"name":"gpt-connector","version":"0.16.3"}\n'), manifestHash = sha256(manifest), treeHash = "b".repeat(64), artifactHash = kind === "tree" ? null : "d".repeat(64);
  const treeOriginal = { payload: { tree_sha256: treeHash, manifest_sha256: manifestHash }, provenance: { original_ref: "synthetic-tree-original" }, extra_proof: { untouched: true } };
  const sourceOriginal = { payload: { revision: "synthetic-actual-source", tree_sha256: treeHash, artifact_sha256: artifactHash, manifest_sha256: manifestHash }, provenance: { original_ref: "synthetic-source-original" }, extra_proof: { untouched: true } };
  const sourceHash = sha256(factoryCanonical(sourceOriginal.payload));
  const adoption = { evidence_ref: "synthetic-adoption-verified", targets: plan.targets, extra: { Z: 1, a: 2 } };
  const input = { identity, execution_package_root: scope.execution_package_root, mutation_resources: scope.mutation_resources, deadline: scope.deadline,
    provenance: { original_ref: "synthetic-provenance-input" }, target_adoption: { original_ref: "synthetic-adoption-input" } };
  const events: string[] = [], abort = new AbortController(); let held: "EX" | "SH" | null = null, publicCalls = 0, shCalls = 0, state: unknown = null, retained: unknown = null;
  let issuer: string | null = "synthetic-existing-resolver";
  let coverage: SourceView | null = { original: { payload: { resources: scope.mutation_resources, agreement: scope.coverage_ref }, provenance: { original_ref: "synthetic-coverage-original" } },
    view: { mutation_resources: scope.mutation_resources, coverage_ref: scope.coverage_ref, all_writers: true }, issuer: "synthetic-coverage-issuer" };
  const lease: ReadLease = { mode: "SH", resources: scope.mutation_resources!, generation, signal: abort.signal, assertCurrent: async () => { assert.ok(held); } };
  const load = async () => structuredClone(state);
  const readSourceEvidence = async (ref: string) => { assert.ok(held); assert.equal(ref, "synthetic-retained-bundle"); events.push(`${held}-read-exact-bundle`); return structuredClone(retained); };
  const writerPorts = {
    clock: () => Date.parse(at), uuid: () => generation,
    withWriteLease: async (_r: unknown, _d: unknown, fn: (lease: ReadLease) => Promise<unknown>) => { assert.equal(held, null); held = "EX"; events.push("EX-acquired"); try { return await fn(lease); } finally { held = null; events.push("EX-released"); } },
    withReadLease: async (_r: unknown, _g: unknown, _d: unknown, fn: (lease: ReadLease) => Promise<unknown>) => { assert.equal(held, null); held = "SH"; shCalls++; events.push("SH-acquired"); try { return await fn(lease); } finally { held = null; events.push("SH-released"); } },
    store: { load, replace: async (record: unknown) => { assert.equal(held, "EX"); state = structuredClone(record); events.push(`state-${(record as { phase: string }).phase}`); } },
    assertResources: async () => { assert.equal(held, "EX"); },
    capture: async () => ({ execution_package_root: scope.execution_package_root, manifest_bytes: manifest, artifact_or_tree_kind: kind,
      artifact_or_tree_sha256: kind === "tree" ? treeHash : artifactHash, tree_sha256: treeHash, tree_original: treeOriginal, artifact_sha256: artifactHash }),
    verifyProvenance: async (_raw: unknown, measured: Record<string, unknown>) => ({ ...measured, deployment_revision: "synthetic-actual-source", evidence_ref: "synthetic-provenance-verified",
      artifact_source_original: sourceOriginal, artifact_source_sha256: sourceHash, extra_verifier_field: { retained: true } }),
    verifyAdoption: async () => structuredClone(adoption),
    issueReceipt: async (payload: string, context: { source_evidence: unknown }) => { assert.equal(held, "EX"); retained = structuredClone(context.source_evidence); events.push("issue-and-retain");
      return { payload_canonical: payload, issuer_id: "synthetic-normal-writer", evidence_ref: "synthetic-retained-bundle", proof: { attestation: "synthetic-existing-trust" } }; },
    readSourceEvidence,
    verifyCurrent: async () => { assert.equal(held, "SH"); },
  };
  const readSources = createFactoryBundleReader({ readSourceEvidence, issuerForSource: async () => { assert.equal(held, "SH"); return issuer; }, readCoverage: async () => structuredClone(coverage) });
  const bridge: FactoryBridgePorts = {
    readState: load,
    verifyReceipt: async raw => ({ status: "verified", subject_sha256: sha256(factoryCanonical((raw as WriterResult["receipt"]).payload)), issuer: "synthetic-normal-writer", trust_ref: "synthetic-existing-writer-trust" }),
    readSources,
    verifySource: async (which, source) => {
      assert.equal(held, "SH");
      if (which !== "coverage") {
        const lineage = source.lineage as { source_evidence: unknown; source_evidence_sha256: string; factory_evidence_ref: string };
        assert.equal(lineage.factory_evidence_ref, "synthetic-retained-bundle"); assert.equal(factoryCanonical(lineage.source_evidence), factoryCanonical(retained));
        assert.equal(lineage.source_evidence_sha256, sha256(factoryCanonical(retained)));
        if (which === "provenance") assert.deepEqual(source.original, sourceOriginal);
        else { assert.deepEqual(source.original.payload, adoption); assert.deepEqual((source.original.provenance as { input: unknown }).input, input.target_adoption); }
      }
      return { status: "verified", subject_sha256: sha256(factoryCanonical(source.original.payload)), view_sha256: sha256(canonical(source.view)), issuer: source.issuer, trust_ref: "synthetic-existing-source-trust" };
    },
    provider: { now: () => Date.parse(at), clock: () => at, uuid: () => runId,
      inspectInstalled: async () => { assert.equal(held, "SH"); return { identity: plan.identity, execution_package_root: scope.execution_package_root, mutation_resources: scope.mutation_resources,
        generation, manifest_sha256: manifestHash, tree_sha256: treeHash, artifact_source_sha256: sourceHash, target_adoption_sha256: sha256(factoryCanonical(adoption)), target_projection_sha256: sha256(canonical(plan.targets)), node_runtime: null }; },
      readAcceptance: async (context, result) => ({ payload: { schema: "gpt-connector.normal-acceptance.v1", identity: plan.identity, generation, deployment_revision: "synthetic-actual-source", run_id: context.run_id,
        mode: context.mode, observed_at: at, result_sha256: sha256(canonical(result)), required_clients: plan.required_clients, raw_health: true, normal_path: true, passed: true, issuer: "synthetic-normal-acceptor", evidence_ref: "synthetic-same-run-original" }, provenance: { original_ref: "synthetic-acceptance" } }),
      verifyAcceptance: async packet => ({ status: "verified", subject_sha256: sha256(canonical(packet.payload)), issuer: "synthetic-normal-acceptor", trust_ref: "synthetic-existing-acceptance-trust" }),
      publicSetup: async options => { publicCalls++; assert.equal(held, "SH"); events.push("normal-setup"); const mode = options.check ? "check" : "setup", start = options.updateLedger!.begin(mode);
        const normal = { schema: "gpt-connector.setup.v1", version: "0.16.3", overall: "ready", registrations: [{ client: "claude", stateRead: "ready", mcp: { status: "ready" }, live: { status: "ready" } }] };
        const updateLedger = await options.updateLedger!.complete(start, mode, normal); assert.equal(held, "SH"); events.push("hook-settled"); return { ...normal, updateLedger }; },
      sampleInstalled: async (adopted, run, deployment, health) => { assert.equal(held, "SH"); events.push("collector"); return { identity: adopted.identity, run_id: run, observed_at: at,
        source: { kind: "installed-package", name: "gpt-connector", installed: "0.16.3", manifest_sha256: deployment.manifest_sha256, deployment_revision: deployment.deployment_revision, deployment_evidence_ref: deployment.evidence_ref },
        bindings: [{ component: "connector", target: adopted.targets[0]!.target, installed: "0.16.3", status: "active" }], health }; },
    },
  };
  const write = () => writer!.writeDeployment(input, writerPorts, { retire: async () => ({ ok: true }), install: async () => ({ ok: true }) });
  const read = (written: WriterResult) => writer!.readDeployment(input, written, writerPorts, (borrowed: ReadLease, receipt: unknown) => runSetupWithFactoryReceipt(plan, scope, borrowed, receipt, bridge));
  return { write, read, events, bridge, sourceHash, sourceOriginal, adoption, lease, abort, scope, calls: () => ({ shCalls, publicCalls }),
    retained: () => structuredClone(retained) as Record<string, unknown>, change: (fn: (value: Record<string, unknown>) => void) => { const value = structuredClone(retained) as Record<string, unknown>; fn(value); retained = value; },
    unknownIssuer: () => { issuer = null; }, unknownCoverage: () => { coverage = null; } };
}

test("fixed436a writer retains exact source bundle before commit; reader maps originals on the single borrowed SH through collector", { skip: !writer }, async () => {
  const f = fixture(), written = await f.write(); assert.equal(written.status, "committed");
  assert.ok(f.events.indexOf("EX-read-exact-bundle") < f.events.indexOf("state-committed"));
  const result = (await f.read(written)).normal_result!;
  assert.equal(result.provider.status, "verified-source", JSON.stringify(result)); assert.equal(result.bridge.status, "verified-view");
  assert.equal(result.bridge.proof!.source_subjects.provenance.original_sha256, f.sourceHash);
  assert.equal(result.bridge.proof!.source_subjects.adoption.original_sha256, sha256(factoryCanonical(f.adoption)));
  assert.deepEqual(f.calls(), { shCalls: 1, publicCalls: 1 }); assert.ok(f.events.indexOf("EX-released") < f.events.indexOf("SH-acquired"));
  assert.ok(f.events.indexOf("collector") < f.events.indexOf("hook-settled")); assert.equal(f.events.at(-1), "SH-released");
  assert.equal((written.receipt.payload as { source_evidence?: unknown }).source_evidence, undefined);
});

test("artifact kind uses separate bytes digest, while tree kind keeps uncollected bytes null", { skip: !writer }, async () => {
  for (const kind of ["tree", "artifact"] as const) {
    const f = fixture(kind), written = await f.write(), bundle = f.retained(), capture = bundle.capture as Record<string, unknown>;
    assert.equal(capture.artifact_or_tree_kind, kind); assert.equal(capture.artifact_sha256, kind === "tree" ? null : "d".repeat(64));
    assert.notEqual(f.sourceHash, capture.artifact_or_tree_sha256);
    assert.equal((await f.read(written)).normal_result!.provider.status, "verified-source");
  }
});

test("changed manifest bytes, exact adoption subject, tree original or payload generation binding cannot reach normal setup", { skip: !writer }, async () => {
  for (const kind of ["manifest-bytes", "adoption-subject", "tree-original", "payload-subject"] as const) {
    const f = fixture(), written = await f.write();
    f.change(bundle => {
      if (kind === "manifest-bytes") (bundle.capture as Record<string, unknown>).manifest_bytes_base64 = Buffer.from("changed").toString("base64");
      if (kind === "payload-subject") bundle.factory_payload_sha256 = "0".repeat(64);
      if (kind === "adoption-subject") ((bundle.adoption as Record<string, unknown>).subject as Record<string, unknown>).extra = "changed";
      if (kind === "tree-original") ((bundle.capture as Record<string, unknown>).tree_original as OriginalPacket).payload = { tree_sha256: "0".repeat(64) };
    });
    const result = (await f.read(written)).normal_result!;
    assert.equal(result.provider.status, "blocked"); assert.equal(f.calls().publicCalls, 0); assert.equal(f.events.at(-1), "SH-released");
  }
});

test("retained bundle does not manufacture existing issuer or all-writer coverage when either is unknown", { skip: !writer }, async () => {
  for (const kind of ["issuer", "coverage"] as const) {
    const f = fixture(), written = await f.write(); if (kind === "issuer") f.unknownIssuer(); else f.unknownCoverage();
    const result = (await f.read(written)).normal_result!;
    assert.equal(result.provider.status, "blocked"); assert.equal(result.bridge.reason, "factory_source_unknown"); assert.equal(f.calls().publicCalls, 0);
  }
});
