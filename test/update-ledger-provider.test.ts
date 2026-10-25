import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "../src/setup.js";
import { canonical, sha256, type LedgerPlan } from "../src/update-ledger-contract.js";
import { runSetupWithVerifiedLedger } from "../src/update-ledger-provider.js";
import { type AcceptancePayload, type DeploymentPayload, type OriginalPacket, type ProviderPorts, type ProviderScope, type ReadLease } from "../src/update-ledger-provider-ports.js";

const generation = "33333333-3333-4333-8333-333333333333", runId = "11111111-1111-4111-8111-111111111111";
const started = "2026-10-25T06:00:00.000Z", at = "2026-10-25T06:00:00.100Z", completed = "2026-10-25T06:00:00.200Z";
function fixture() {
  const plan: LedgerPlan = { identity: { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner: { system: "bellteam", id: "bot-7696018a" },
    execution_prefix: "/synthetic/npm-global/lib/node_modules/gpt-connector" }, source_wire_agreement_ref: "synthetic-source", health_agreement_ref: "synthetic-health",
    required_clients: ["claude"], targets: [{ component: "connector", target: { kind: "npm", name: "gpt-connector", series: "0.16" }, adoption_ref: "synthetic-explicit-adoption" }] };
  const scope: ProviderScope = { execution_package_root: plan.identity.execution_prefix, mutation_resources: ["/synthetic/npm-global"],
    expectedGeneration: generation, coverage_ref: "synthetic-all-writer-agreement", deadline: Date.parse(completed) + 1000 };
  const receipt: DeploymentPayload = { schema: "gpt-connector.deployment-receipt.v1", identity: plan.identity, state: "committed", generation,
    execution_package_root: scope.execution_package_root, mutation_resources: scope.mutation_resources!, coverage_ref: scope.coverage_ref!,
    manifest_sha256: "a".repeat(64), tree_sha256: "b".repeat(64), artifact_source_sha256: "c".repeat(64),
    target_adoption_sha256: "d".repeat(64), target_projection_sha256: sha256(canonical(plan.targets)), deployment_revision: "synthetic-verified-artifact-source",
    issuer: "synthetic-normal-writer", evidence_ref: "synthetic-deployment-original", node_runtime: null };
  const original: OriginalPacket = { payload: receipt, provenance: { reference: "synthetic-existing-release-verification" } };
  const abort = new AbortController(), events: string[] = [];
  let held = false, publicCalls = 0, samples = 0, ticks = 0;
  const lease: ReadLease = { mode: "SH", resources: scope.mutation_resources!, generation, signal: abort.signal,
    assertCurrent: async () => { assert.ok(held); events.push("lease-current"); } };
  const record = async (client: string) => ({ client, status: "registered", server: { command: "synthetic-mcp", args: [], env: {} } });
  const normalPorts = { platform: "linux", register: record, read: record, state: async () => "ready", verify: async () => ({ status: "ready" }),
    browser: async () => ({ status: "ready", reason: "ready" }), steer: async () => { throw new Error("unexpected codex"); }, cursorHooks: () => { throw new Error("unexpected cursor"); } };
  const ports: ProviderPorts = {
    async withReadLease(resources, expected, deadline, fn) {
      assert.deepEqual(resources, ["/synthetic/npm-global"]); assert.equal(expected, generation); assert.equal(deadline, scope.deadline);
      events.push("SH-acquired-after-writer-release"); held = true;
      try { return await fn(lease); } finally { held = false; events.push("SH-released-after-callback"); }
    },
    readDeploymentReceipt: async () => { assert.ok(held); events.push("read-receipt"); return structuredClone(original); },
    verifyDeployment: async packet => ({ status: "verified", subject_sha256: sha256(canonical(packet.payload)), issuer: receipt.issuer, trust_ref: "synthetic-existing-trust" }),
    inspectInstalled: async () => {
      assert.ok(held); events.push("inspect-tree");
      return { identity: receipt.identity, execution_package_root: receipt.execution_package_root, mutation_resources: receipt.mutation_resources, generation: receipt.generation,
        manifest_sha256: receipt.manifest_sha256, tree_sha256: receipt.tree_sha256, artifact_source_sha256: receipt.artifact_source_sha256,
        target_adoption_sha256: receipt.target_adoption_sha256, target_projection_sha256: receipt.target_projection_sha256, node_runtime: receipt.node_runtime };
    },
    readAcceptance: async (run, result) => {
      assert.ok(held); events.push("read-same-run-acceptance");
      const payload: AcceptancePayload = { schema: "gpt-connector.normal-acceptance.v1", identity: plan.identity, generation, deployment_revision: receipt.deployment_revision,
        run_id: run.run_id, mode: run.mode, observed_at: at, result_sha256: sha256(canonical(result)), required_clients: plan.required_clients,
        raw_health: true, normal_path: true, passed: true, issuer: "synthetic-normal-acceptor", evidence_ref: "synthetic-normal-acceptance-original" };
      return { payload, provenance: { reference: "synthetic-normal-acceptance-trust" } };
    },
    verifyAcceptance: async packet => ({ status: "verified", subject_sha256: sha256(canonical(packet.payload)), issuer: "synthetic-normal-acceptor", trust_ref: "synthetic-existing-acceptance-trust" }),
    publicSetup: async options => { assert.ok(held); publicCalls++; events.push("public-setup-once"); return setup({ ...options, clients: ["claude"] }, normalPorts as unknown as Parameters<typeof setup>[1]); },
    sampleInstalled: async (adopted, run, deployed, health) => {
      assert.ok(held); samples++; events.push("collector-projection"); assert.equal(deployed.deployment_revision, receipt.deployment_revision);
      return { identity: adopted.identity, run_id: run, observed_at: health.observed_at > at ? health.observed_at : at, source: { kind: "installed-package", name: "gpt-connector", installed: "0.16.3",
        deployment_revision: deployed.deployment_revision, manifest_sha256: deployed.manifest_sha256, deployment_evidence_ref: deployed.evidence_ref },
      bindings: [{ component: "connector", target: adopted.targets[0]!.target, installed: "0.16.3", status: "active" }], health };
    },
    clock: () => ++ticks === 1 ? started : completed, now: () => Date.parse(completed), uuid: () => runId,
  };
  return { plan, scope, receipt, original, ports, lease, abort, events, calls: () => ({ public: publicCalls, samples }), normalPorts };
}

test("provider holds the common global-resource SH lease through public setup, trust/real-tree checks and collector projection", async () => {
  const f = fixture(), result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports);
  assert.equal(result.result!.overall, "ready"); assert.equal(result.provider.status, "verified-source");
  assert.deepEqual(f.calls(), { public: 1, samples: 1 });
  assert.equal(f.events[0], "SH-acquired-after-writer-release"); assert.equal(f.events.at(-1), "SH-released-after-callback");
  assert.ok(f.events.indexOf("inspect-tree") < f.events.indexOf("public-setup-once"));
  assert.ok(f.events.indexOf("read-same-run-acceptance") < f.events.indexOf("collector-projection"));
  if (result.provider.status === "verified-source") {
    assert.equal(result.provider.proof.deployment_sha256, sha256(canonical(f.receipt)));
    assert.equal(result.provider.proof.deployment_trust_ref, "synthetic-existing-trust");
    assert.equal(result.provider.proof.raw_health.raw, true);
  }
});

test("unknown resources/generation/coverage and wrong resource coverage stop before acquiring a lease or calling public setup", async () => {
  for (const change of ["resources", "generation", "coverage", "wrong-root", "order"] as const) {
    const f = fixture();
    if (change === "resources") f.scope.mutation_resources = null;
    if (change === "generation") f.scope.expectedGeneration = null;
    if (change === "coverage") f.scope.coverage_ref = null;
    if (change === "wrong-root") f.scope.mutation_resources = ["/synthetic/other"];
    if (change === "order") f.scope.mutation_resources = ["/synthetic/z", "/synthetic/npm-global"];
    const result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports);
    assert.equal(result.provider.status, "blocked"); assert.equal(result.result, null); assert.deepEqual(f.events, []); assert.equal(f.calls().public, 0);
  }
});

test("writer intervention between release and SH acquisition or wrong lease resource set prevents public setup", async () => {
  for (const kind of ["generation", "resources", "EX"] as const) {
    const f = fixture();
    if (kind === "generation") f.lease.generation = "44444444-4444-4444-8444-444444444444";
    if (kind === "resources") f.lease.resources = [f.scope.execution_package_root];
    if (kind === "EX") (f.lease as { mode: string }).mode = "EX";
    const result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports);
    assert.equal(result.provider.status, "blocked"); assert.equal(f.calls().public, 0); assert.equal(f.events.at(-1), "SH-released-after-callback");
  }
});

test("untrusted receipt, wrong provenance subject, incomplete writer state, wrong adoption or unguarded Node cannot be projected", async () => {
  for (const kind of ["unknown-trust", "wrong-subject", "incomplete", "adoption", "node"] as const) {
    const f = fixture();
    if (kind === "unknown-trust") f.ports.verifyDeployment = async () => ({ status: "unknown", subject_sha256: "", issuer: f.receipt.issuer, trust_ref: null });
    if (kind === "wrong-subject") f.ports.verifyDeployment = async () => ({ status: "verified", subject_sha256: "0".repeat(64), issuer: f.receipt.issuer, trust_ref: "synthetic" });
    if (kind === "incomplete") f.receipt.state = "incomplete";
    if (kind === "adoption") f.receipt.target_projection_sha256 = "0".repeat(64);
    if (kind === "node") { f.plan.targets.push({ component: "runtime", target: { kind: "node", series: "24" }, adoption_ref: "synthetic-node-adoption" }); f.receipt.target_projection_sha256 = sha256(canonical(f.plan.targets)); }
    const result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports);
    assert.equal(result.provider.status, "blocked"); assert.deepEqual(f.calls(), { public: 0, samples: 0 });
  }
});

test("same-manifest tree/dependency-generation mismatch is detected after normal setup without rewriting its ready result", async () => {
  for (const changed of ["tree_sha256", "artifact_source_sha256", "generation", "projection"] as const) {
    const f = fixture(), inspect = f.ports.inspectInstalled; let reads = 0;
    f.ports.inspectInstalled = async (context, signal) => {
      const actual = await inspect(context, signal) as Record<string, unknown>;
      if (++reads > 1 && changed !== "projection") actual[changed] = changed === "generation" ? "44444444-4444-4444-8444-444444444444" : "f".repeat(64);
      return actual;
    };
    if (changed === "projection") {
      const sample = f.ports.sampleInstalled!;
      f.ports.sampleInstalled = async (...args) => { const measured = await sample(...args); measured.source.manifest_sha256 = "e".repeat(64); return measured; };
    }
    const result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports);
    assert.equal(result.result!.overall, "ready"); assert.equal(result.provider.status, "blocked"); assert.equal(f.calls().samples, changed === "projection" ? 1 : 0);
  }
});

test("acceptance must match run/generation/result hash/required clients and trusted original; absence remains raw unknown", async () => {
  for (const kind of ["run", "generation", "result", "clients", "trust", "absent"] as const) {
    const f = fixture(), read = f.ports.readAcceptance;
    f.ports.readAcceptance = async (context, result, signal) => {
      if (kind === "absent") return null;
      const packet = (await read(context, result, signal))!; const payload = packet.payload as AcceptancePayload;
      if (kind === "run") payload.run_id = "44444444-4444-4444-8444-444444444444";
      if (kind === "generation") payload.generation = "44444444-4444-4444-8444-444444444444";
      if (kind === "result") payload.result_sha256 = "0".repeat(64);
      if (kind === "clients") payload.required_clients = ["codex"];
      return packet;
    };
    if (kind === "trust") f.ports.verifyAcceptance = async () => ({ status: "unknown", subject_sha256: "", issuer: "synthetic-normal-acceptor", trust_ref: null });
    const result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports);
    assert.equal(result.result!.overall, "ready"); assert.equal(result.provider.status, "blocked");
    if (kind === "absent" && result.provider.status === "blocked") {
      assert.equal(result.provider.proof!.raw_health.raw, null);
      assert.equal((result.result!.updateLedger as { reason: string }).reason, "ledger_health_unknown");
    }
  }
});

test("check never constructs a sender or invents current-run acceptance; native failure and reporting block stay separate", async () => {
  const f = fixture(); let senderCalls = 0;
  f.ports.senderForLease = () => { senderCalls++; throw new Error("unexpected sender"); };
  f.ports.readAcceptance = async context => { assert.equal(context.mode, "check"); return null; };
  f.ports.publicSetup = async options => setup({ ...options, clients: ["claude"] }, { ...f.normalPorts,
    browser: async () => ({ status: "failed", reason: "runtime_drift" }) } as unknown as Parameters<typeof setup>[1]);
  const result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports, { check: true });
  assert.equal(result.result!.overall, "failed"); assert.equal(result.provider.status, "blocked"); assert.equal(senderCalls, 0);
  if (result.provider.status === "blocked") assert.equal(result.provider.proof!.raw_health.raw, null);
});

test("deadline/lease loss after public setup aborts reporting and release follows the settled callback", async () => {
  const f = fixture(), read = f.ports.readAcceptance;
  f.ports.readAcceptance = async (context, result, signal) => { const packet = await read(context, result, signal); f.abort.abort(); return packet; };
  const result = await runSetupWithVerifiedLedger(f.plan, f.scope, f.ports);
  assert.equal(result.result!.overall, "ready"); assert.equal(result.provider.status, "blocked"); assert.equal(f.calls().samples, 0);
  assert.equal(f.events.at(-1), "SH-released-after-callback");
  const expired = fixture(); expired.ports.now = () => expired.scope.deadline;
  assert.equal((await runSetupWithVerifiedLedger(expired.plan, expired.scope, expired.ports)).provider.status, "blocked");
  assert.equal(expired.calls().public, 0); assert.deepEqual(expired.events, []);
});
