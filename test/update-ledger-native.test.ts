import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setup } from "../src/setup.js";
import { canonical, productAfterSnapshot, sha256, type CurrentProduct, type Snapshot } from "../src/update-ledger-contract.js";
import { nativeLedgerJournal } from "../src/update-ledger-native-journal.js";
import { runSetupWithBorrowedLedgerLease, type ProviderResult } from "../src/update-ledger-provider.js";
import type { DeploymentPayload, ProviderPorts, ProviderScope, ReadLease } from "../src/update-ledger-provider-ports.js";
import { reconcileLedger } from "../src/update-ledger-sender.js";
import { fixedNativePath, fixture, generation, identity, journalNative, observedReadLease, type RemoteWitness } from "./fixtures/shared-native-fixture.js";

const observations: Record<string, unknown>[] = [];
after(async () => { if (fixedNativePath) await writeFile(resolve("../../artifacts/2026-10-25-update-ledger-native/native-observations.json"), JSON.stringify({ scope: "private Linux real helper/process/fs, synthetic client/trust/transport only", observations }, null, 2) + "\n", { mode: 0o600 }); });
async function seed(f: Awaited<ReturnType<typeof fixture>>, receipt: unknown) {
  const state = { schema: "factory.deployment-state.v1", identity, execution_package_root: f.packageRoot, mutation_resources: [f.prefix], generation, phase: "mutating", receipt: null as unknown };
  await f.adapter.withWriteLease([f.prefix], Date.now() + 10000, async () => {
    await f.adapter.store.replace(state, { expectedGeneration: null });
    await f.adapter.store.replace({ ...state, phase: "committed", receipt }, { expectedGeneration: generation });
  });
}
function deploymentPayload(f: Awaited<ReturnType<typeof fixture>>, scope: ProviderScope): DeploymentPayload {
  return { schema: "gpt-connector.deployment-receipt.v1", identity: f.data.plan.identity, execution_package_root: f.packageRoot, mutation_resources: [f.prefix], generation,
    state: "committed", manifest_sha256: f.manifestHash, tree_sha256: f.treeHash, artifact_source_sha256: f.sourceHash,
    target_adoption_sha256: sha256("synthetic-adoption-original"), target_projection_sha256: sha256(canonical(f.data.plan.targets)), node_runtime: null,
    deployment_revision: "synthetic-native-fixture", issuer: "synthetic-fixture-issuer", evidence_ref: "synthetic-native-receipt", coverage_ref: scope.coverage_ref! };
}
function provider(f: Awaited<ReturnType<typeof fixture>>, parent: ReadLease, scope: ProviderScope, events: string[]) {
  let remote: CurrentProduct = structuredClone(f.data.before), gets = 0, posts = 0;
  const payload = deploymentPayload(f, scope);
  const ports: Omit<ProviderPorts, "withReadLease"> = {
    now: Date.now, clock: () => "2026-10-25T08:00:00.000Z", uuid: () => f.data.completion.run.run_id,
    readDeploymentReceipt: async () => { const s = await f.adapter.store.load(identity) as { receipt: unknown }; return structuredClone(s.receipt) as { payload: unknown; provenance: unknown }; },
    verifyDeployment: async packet => ({ status: "verified", subject_sha256: sha256(canonical(packet.payload)), issuer: payload.issuer, trust_ref: "synthetic-existing-fixture-trust" }),
    inspectInstalled: async () => ({ identity: payload.identity, execution_package_root: payload.execution_package_root, mutation_resources: payload.mutation_resources, generation,
      manifest_sha256: sha256(await readFile(join(f.packageRoot, "package.json"))), tree_sha256: sha256(await readFile(join(f.packageRoot, "entry.js"))), artifact_source_sha256: f.sourceHash,
      target_adoption_sha256: payload.target_adoption_sha256, target_projection_sha256: payload.target_projection_sha256, node_runtime: null }),
    readAcceptance: async (run, result) => ({ payload: { schema: "gpt-connector.normal-acceptance.v1", identity: payload.identity, generation, deployment_revision: payload.deployment_revision,
      run_id: run.run_id, mode: run.mode, observed_at: "2026-10-25T08:00:00.000Z", result_sha256: sha256(canonical(result)), required_clients: f.data.plan.required_clients,
      raw_health: true, normal_path: true, passed: true, issuer: "synthetic-fixture-acceptor", evidence_ref: "synthetic-normal-result" }, provenance: { fixture: true } }),
    verifyAcceptance: async packet => ({ status: "verified", subject_sha256: sha256(canonical(packet.payload)), issuer: "synthetic-fixture-acceptor", trust_ref: "synthetic-fixture-acceptance-trust" }),
    publicSetup: async options => {
      events.push("public-core-setup"); await parent.assertCurrent();
      const record = async (client: string) => ({ client, status: "registered", server: { command: "synthetic-mcp", args: [], env: {} } });
      const result = await setup({ ...options, clients: ["claude"] }, { platform: "linux", register: record, read: record, state: async () => "ready", verify: async () => ({ status: "ready" }),
        browser: async () => ({ status: "ready", reason: "ready" }), steer: async () => { throw new Error("not used"); }, cursorHooks: () => { throw new Error("not used"); } } as unknown as Parameters<typeof setup>[1]);
      events.push("core-hook-settled"); return result;
    },
    senderForLease: (_context, held) => ({ journal: nativeLedgerJournal(f.journal, journalNative(f.adapter, observations), held, scope.deadline), transport: {
      identity: payload.identity, get: async () => { gets++; await parent.assertCurrent(); events.push("GET"); return { product: structuredClone(remote) }; },
      post: async (_path, body) => { posts++; await parent.assertCurrent(); events.push("POST"); remote = productAfterSnapshot(remote, JSON.parse(body) as Snapshot, new Date().toISOString()); return { product: structuredClone(remote), replayed: false }; },
    } }),
  };
  return { payload, ports, counts: () => ({ gets, posts }) };
}

test("real committed SH is borrowed once through core setup, actual collector, native journal EX and settled fake send", { skip: process.platform !== "linux" || !fixedNativePath }, async () => {
  const f = await fixture("reader-core-journal"), events: string[] = [], scope: ProviderScope = { execution_package_root: f.packageRoot, mutation_resources: [f.prefix], expectedGeneration: generation,
    coverage_ref: "synthetic-fixture-writers-only", deadline: Date.now() + 20000 };
  // Seed an exact fixture receipt with actual file hashes; issuer/health remain synthetic, never production proof.
  await seed(f, { payload: deploymentPayload(f, scope), provenance: { fixture: true } }); let count = 0;
  await f.adapter.withReadLease([f.prefix], generation, scope.deadline, async raw => {
    count++; const parent = observedReadLease(raw); observations.push({ name: "reader-core-journal", root: f.root, prepared: f.prepared, helperPid: raw.helperPid, mode: raw.mode,
      generation: raw.generation, filesystem: raw.filesystem, locks: raw.lockInodes });
    const p = provider(f, parent, scope, events), result = await runSetupWithBorrowedLedgerLease(f.data.plan, scope, parent, p.ports);
    assert.equal(result.provider.status, "verified-source", JSON.stringify(result)); assert.equal(result.result!.overall, "ready"); assert.deepEqual(p.counts(), { gets: 3, posts: 1 });
    assert.ok(events.indexOf("POST") < events.indexOf("core-hook-settled")); await parent.assertCurrent();
    observations.push({ name: "reader-core-result", events, parent_held_after_hook: true, result: result.provider.status });
  });
  assert.equal(count, 1); const lines = (await readFile(join(f.journal, "journal.jsonl"), "utf8")).trim().split("\n").map(value => JSON.parse(value));
  assert.equal(lines.at(-1).phase, "confirmed"); assert.equal(new Set(lines.map(x => x.body)).size, 1); assert.equal((await stat(join(f.journal, "journal.jsonl"))).mode & 0o777, 0o600);
});

test("real parent helper death blocks reporting while preserving the normal core result and settles before release", { skip: process.platform !== "linux" || !fixedNativePath }, async () => {
  const f = await fixture("parent-helper-loss"), events: string[] = [], scope: ProviderScope = { execution_package_root: f.packageRoot, mutation_resources: [f.prefix], expectedGeneration: generation,
    coverage_ref: "synthetic-fixture-writers-only", deadline: Date.now() + 15000 };
  await seed(f, { payload: deploymentPayload(f, scope), provenance: { fixture: true } });
  let result: ProviderResult | null = null;
  await assert.rejects(f.adapter.withReadLease([f.prefix], generation, scope.deadline, async raw => {
    const parent = observedReadLease(raw), p = provider(f, parent, scope, events), read = p.ports.readAcceptance;
    p.ports.readAcceptance = async (...args) => { const value = await read(...args); process.kill(raw.helperPid, "SIGKILL"); if (!raw.signal.aborted) await new Promise<void>(resolve => raw.signal.addEventListener("abort", () => resolve(), { once: true })); return value; };
    result = await runSetupWithBorrowedLedgerLease(f.data.plan, scope, parent, p.ports); assert.equal(p.counts().posts, 0); observations.push({ name: "parent-helper-loss", root: f.root, helperPid: raw.helperPid, result });
  }), /native_(lease_inactive|helper_lost)/u);
  assert.ok(result); assert.equal((result as ProviderResult).result!.overall, "ready"); assert.equal((result as ProviderResult).provider.status, "blocked");
});

test("real producer SIGKILL after durable intent and fake POST resumes same UUID/body with one GET and no second POST", { skip: process.platform !== "linux" || !fixedNativePath }, async () => {
  const f = await fixture("producer-kill-get-only"); await seed(f, { fixture: true });
  const childPath = fileURLToPath(new URL("./fixtures/native-journal-crash-child.ts", import.meta.url));
  const child = fork(childPath, [f.root], { execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let message: unknown;
  try {
    message = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("owned fixture child did not reach durable POST boundary")), 12000);
      child.once("message", value => { clearTimeout(timeout); resolve(value); }); child.once("exit", code => { clearTimeout(timeout); reject(new Error(`fixture child exited ${code}`)); }); });
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await delay(100); } }
  const witness = JSON.parse(await readFile(join(f.root, "fake-remote-witness.json"), "utf8")) as RemoteWitness;
  const before = (await readFile(join(f.journal, "journal.jsonl"), "utf8")).trim().split("\n").map(value => JSON.parse(value));
  assert.equal(before.at(-1).phase, "issued"); assert.equal(before.at(-1).body, witness.body);
  let gets = 0, posts = 0;
  await f.adapter.withReadLease([f.prefix], generation, Date.now() + 10000, async raw => {
    const parent = observedReadLease(raw), journal = nativeLedgerJournal(f.journal, journalNative(f.adapter, observations), parent, Date.now() + 8000);
    const recovered = await reconcileLedger(f.data.plan, { journal, transport: { identity: f.data.plan.identity, get: async () => { gets++; return { product: witness.product }; },
      post: async () => { posts++; throw new Error("second POST forbidden"); } } });
    assert.equal(recovered!.status, "observed"); assert.equal(recovered!.request_id, JSON.parse(witness.body).request_id);
    observations.push({ name: "producer-kill-get-only", root: f.root, childPid: child.pid, child_boundary: message, result: recovered, gets, posts, body_sha256: sha256(witness.body), filesystem: raw.filesystem });
  });
  assert.equal(gets, 1); assert.equal(posts, 0);
  const after = (await readFile(join(f.journal, "journal.jsonl"), "utf8")).trim().split("\n").map(value => JSON.parse(value));
  assert.equal(after.at(-1).phase, "observed"); assert.equal(new Set(after.map(x => x.body)).size, 1);
  await assert.rejects(stat(join(f.journal, "operation.lock")), { code: "ENOENT" });
});
