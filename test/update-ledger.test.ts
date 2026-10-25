import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectSnapshot, canonical, sha256, type CurrentProduct, type LedgerPlan, type RuntimeMeasurement, type SetupCompletion, type Snapshot } from "../src/update-ledger-contract.js";
import { readInstalledMeasurement } from "../src/update-ledger-collector.js";
import { fileLedgerJournal, type LedgerJournal, type JournalState } from "../src/update-ledger-journal.js";
import { productPaths, reconcileLedger, sendSetupSnapshot, type ProductTransport } from "../src/update-ledger-sender.js";
import { createInstalledLedgerCompletionHook, createLedgerCompletionHook } from "../src/update-ledger-hook.js";
import { setup } from "../src/setup.js";

const runId = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-25T05:00:00.100Z", started = "2026-10-25T05:00:00.000Z", completed = "2026-10-25T05:00:00.200Z";
const owner = { system: "bellteam", id: "bot-7696018a" } as const;
function fixture() {
  const plan: LedgerPlan = { identity: { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner, execution_prefix: "/synthetic/install" },
    source_wire_agreement_ref: "synthetic-source-agreement", health_agreement_ref: "synthetic-health-agreement", required_clients: ["claude"],
    targets: [{ component: "connector", target: { kind: "npm", name: "gpt-connector", series: "0.16" }, adoption_ref: "synthetic-adopt-0.16" }] };
  const completion: SetupCompletion = { run: { run_id: runId, started_at: started, completed_at: completed, mode: "setup" },
    result: { schema: "gpt-connector.setup.v1", version: "0.16.3", overall: "ready", registrations: [{ client: "claude", stateRead: "ready", mcp: { status: "ready" }, live: { status: "ready" } }] } };
  const measured: RuntimeMeasurement = { identity: structuredClone(plan.identity), run_id: runId, observed_at: at,
    source: { kind: "installed-package", name: "gpt-connector", installed: "0.16.3", deployment_revision: "synthetic-deployed-revision", manifest_sha256: "a".repeat(64), deployment_evidence_ref: "synthetic-receipt" },
    bindings: [{ component: "connector", target: structuredClone(plan.targets[0]!.target), installed: "0.16.3", status: "active" }],
    health: { run_id: runId, observed_at: at, raw: true, acceptance: { run_id: runId, observed_at: at,
      source_revision: "synthetic-deployed-revision", execution_prefix: plan.identity.execution_prefix, normal_path: true, passed: true, evidence_ref: "synthetic-normal-acceptance" } } };
  const before: CurrentProduct = { product_id: plan.identity.product_id, owner, app: "GPT", version: 1, inventory_version: 7, inventory_max_age_hours: 168,
    created_at: "2026-10-24T01:00:00.000Z", updated_at: "2026-10-24T01:00:00.000Z", bindings: [] };
  return { plan, completion, measured, before };
}
async function temporary(work: (directory: string) => Promise<void>) {
  const root = resolve(".gpt-connector-tmp"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "update-ledger-"));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function fakeTransport(plan: LedgerPlan, initial: CurrentProduct) {
  let product = structuredClone(initial), posts = 0, gets = 0;
  const bodies: string[] = [];
  const transport: ProductTransport = { identity: structuredClone(plan.identity),
    async get(path) { assert.equal(path, productPaths(plan.identity.product_id).get); gets++; return { product: structuredClone(product) }; },
    async post(path, text) {
      assert.equal(path, productPaths(plan.identity.product_id).post); posts++; bodies.push(text);
      const body = JSON.parse(text) as Snapshot; assert.equal(body.expected_version, product.inventory_version);
      const keys = new Set(body.bindings.map(row => canonical([row.component, row.target])));
      product = { ...product, inventory_version: product.inventory_version + 1, observed_at: body.observed_at, deployment_revision: body.deployment_revision,
        healthy: body.healthy, updated_at: completed, bindings: [...body.bindings.map(row => ({ ...row, observed_at: body.observed_at, reported: true })),
          ...product.bindings.filter(row => !keys.has(canonical([row.component, row.target]))).map(row => ({ ...row, reported: false }))] };
      return { product: structuredClone(product), replayed: false };
    } };
  return { transport, posts: () => posts, gets: () => gets, bodies, product: () => product, change: (next: CurrentProduct) => { product = next; } };
}
const clock = () => Date.parse(completed);

test("collector preserves measured UTCms/version and explicitly adopted series, across all four registered identities", () => {
  for (const host of ["mac-kite", "main-server", "rabbit", "windows-workstation"] as const) {
    const f = fixture(); f.plan.identity.host_id = host; f.plan.identity.product_id = `gpt-connector-${host}`;
    f.measured.identity = structuredClone(f.plan.identity);
    const c = collectSnapshot(f.plan, f.completion, f.measured);
    assert.equal(c.observation.observed_at, at); assert.equal(c.observation.bindings[0]!.installed, "0.16.3");
    assert.equal(c.evidence.target_adoptions[0]!.adoption_ref, "synthetic-adopt-0.16");
  }
});

test("collector rejects wrong product/owner, missing series/health/installed and mismatched run/source/prefix", () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.measured.identity.product_id = "gpt-connector-main-server"; },
    f => { (f.measured.identity.owner as { id: string }).id = "wrong-owner"; },
    f => { f.plan.targets[0]!.adoption_ref = ""; },
    f => { f.measured.health.raw = null; },
    f => { f.measured.health.acceptance = null; },
    f => { f.measured.bindings[0]!.installed = null; },
    f => { f.measured.run_id = requestId; },
    f => { f.measured.health.acceptance!.run_id = requestId; },
    f => { f.measured.health.acceptance!.source_revision = "other-revision"; },
    f => { f.measured.health.acceptance!.execution_prefix = "/other-prefix"; },
    f => { f.measured.observed_at = "2026-10-24T05:00:00.100Z"; },
    f => { f.completion.result.version = "0.16.2"; },
    f => { f.measured.bindings[0]!.target.series = "0.17"; },
    f => { f.completion.result.registrations = []; },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => collectSnapshot(f.plan, f.completion, f.measured)); }
});

test("raw health false needs explicit failed acceptance; unknown and ready/failed contradictions never become healthy", () => {
  const f = fixture(); f.measured.health.raw = false; f.measured.health.acceptance!.passed = false;
  assert.throws(() => collectSnapshot(f.plan, f.completion, f.measured), /health_contradiction/);
  f.completion.result.overall = "failed";
  assert.equal(collectSnapshot(f.plan, f.completion, f.measured).observation.healthy, false);
  f.measured.health.raw = null;
  assert.throws(() => collectSnapshot(f.plan, f.completion, f.measured), /health_unknown/);
});

test("runtime reader uses the bound synthetic installation and actual dependency manifest, never engines/range/lock", async () => temporary(async directory => {
  const f = fixture(); f.plan.identity.execution_prefix = directory;
  f.plan.targets.push({ component: "runtime", target: { kind: "node", series: "24" }, adoption_ref: "synthetic-node-adoption" },
    { component: "dependency", target: { kind: "npm", name: "synthetic-dep", series: "2" }, adoption_ref: "synthetic-dep-adoption" });
  const bytes = JSON.stringify({ name: "gpt-connector", version: "0.16.3", engines: { node: ">=22" }, dependencies: { "synthetic-dep": "^2.0.0" } });
  await writeFile(join(directory, "package.json"), bytes); await mkdir(join(directory, "node_modules/synthetic-dep"), { recursive: true });
  await writeFile(join(directory, "node_modules/synthetic-dep/package.json"), JSON.stringify({ name: "synthetic-dep", version: "2.4.7", main: "index.js" }));
  await writeFile(join(directory, "node_modules/synthetic-dep/index.js"), "");
  const receipt = { execution_prefix: directory, manifest_sha256: sha256(bytes), deployment_revision: "synthetic-deployed", evidence_ref: "synthetic-deployment" };
  const measured = await readInstalledMeasurement(f.plan, runId, receipt, f.measured.health, { clock: () => at, nodeVersion: () => "24.22.0" });
  assert.deepEqual(measured.bindings.map(row => row.installed), ["0.16.3", "24.22.0", "2.4.7"]);
  assert.equal(measured.observed_at, at);
  await assert.rejects(readInstalledMeasurement(f.plan, runId, { ...receipt, manifest_sha256: "0".repeat(64) }, f.measured.health), /receipt_mismatch/);
  await assert.rejects(readInstalledMeasurement(f.plan, runId, { ...receipt, execution_prefix: "/another" }, f.measured.health), /prefix_mismatch/);
}));

test("sender persists UUID/body/CAS/intent before a single POST and requires independent full-field GET", async () => temporary(async directory => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before); const post = fake.transport.post;
  fake.transport.post = async (path, body, signal) => {
    const lines = (await readFile(join(directory, "journal.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as JournalState);
    assert.equal(lines.at(-1)!.phase, "issued"); assert.equal(lines.at(-1)!.body, body);
    assert.equal(lines.at(-1)!.evidence.measurement.source.deployment_revision, "synthetic-deployed-revision");
    return post(path, body, signal);
  };
  const ports = { transport: fake.transport, journal: fileLedgerJournal(directory), clock, uuid: () => requestId };
  assert.deepEqual(await sendSetupSnapshot(f.plan, f.completion, f.measured, ports), { status: "confirmed", request_id: requestId, operation_run_id: runId });
  assert.equal(fake.posts(), 1); assert.equal(fake.gets(), 3); assert.equal(JSON.parse(fake.bodies[0]!).expected_version, 7);
  assert.equal(JSON.parse(fake.bodies[0]!).observed_at, at);
  await sendSetupSnapshot(f.plan, f.completion, f.measured, { ...ports, journal: fileLedgerJournal(directory) });
  assert.equal(fake.posts(), 1); assert.equal(fake.gets(), 3);
  f.measured.source.deployment_evidence_ref = "changed-evidence-for-same-run";
  await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, ports), /run_reused/);
}));

test("wrong transport or remote product/owner rejects before POST", async () => temporary(async directory => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before);
  fake.transport.identity.product_id = "gpt-connector-main-server";
  await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, { transport: fake.transport, journal: fileLedgerJournal(directory), clock }), /transport_identity/);
  assert.equal(fake.gets(), 0);
  fake.transport.identity = structuredClone(f.plan.identity);
  fake.transport.get = async () => ({ product: { ...f.before, owner: { system: "bellteam", id: "other" } } });
  await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, { transport: fake.transport, journal: fileLedgerJournal(directory), clock }));
  assert.equal(fake.posts(), 0);
}));

test("durable write failure and changed fresh CAS prevent POST; prepared recovery remains GET-only", async () => temporary(async directory => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before);
  const failed: LedgerJournal = { exclusive: async work => work({ current: () => null, append: async () => { throw new Error("synthetic fsync failure"); } }) };
  await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, { transport: fake.transport, journal: failed, clock }), /fsync/);
  assert.equal(fake.posts(), 0);
  let gets = 0;
  fake.transport.get = async () => ({ product: { ...f.before, inventory_version: ++gets === 1 ? 7 : 8 } });
  const ports = { transport: fake.transport, journal: fileLedgerJournal(directory), clock, uuid: () => requestId };
  await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, ports), /cas_changed/);
  assert.equal(fake.posts(), 0);
  assert.equal((await reconcileLedger(f.plan, { ...ports, journal: fileLedgerJournal(directory) }))!.status, "unknown");
  assert.equal(fake.posts(), 0);
}));

test("POST response loss after apply stays unacknowledged and GET-only after restart/new run; no new UUID", async () => temporary(async directory => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before), original = fake.transport.post;
  fake.transport.post = async (path, body, signal) => { await original(path, body, signal); throw new Error("synthetic response loss"); };
  let uuids = 0;
  const ports = { transport: fake.transport, journal: fileLedgerJournal(directory), clock, uuid: () => { uuids++; return requestId; } };
  assert.equal((await sendSetupSnapshot(f.plan, f.completion, f.measured, ports)).status, "observed");
  f.completion.run.run_id = "33333333-3333-4333-8333-333333333333";
  f.measured.run_id = f.measured.health.run_id = f.measured.health.acceptance!.run_id = f.completion.run.run_id;
  const recovered = await sendSetupSnapshot(f.plan, f.completion, f.measured, { ...ports, journal: fileLedgerJournal(directory) });
  assert.equal(recovered.status, "observed"); assert.equal(recovered.operation_run_id, runId);
  assert.equal(fake.posts(), 1); assert.equal(uuids, 1); assert.equal(fake.gets(), 4);
}));

test("crash after durable issued intent but before POST resumes with GET only", async () => temporary(async directory => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before), disk = fileLedgerJournal(directory);
  const crash: LedgerJournal = { exclusive: async work => disk.exclusive(session => work({ current: session.current, async append(state) {
    await session.append(state); if (state.phase === "issued") throw new Error("synthetic crash after durable intent");
  } })) };
  await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, { transport: fake.transport, journal: crash, clock, uuid: () => requestId }), /synthetic crash/);
  assert.equal(fake.posts(), 0);
  assert.equal((await reconcileLedger(f.plan, { transport: fake.transport, journal: fileLedgerJournal(directory), clock }))!.status, "unknown");
  assert.equal(fake.posts(), 0);
}));

test("old/future observations and missing evidence stop before any POST", async () => temporary(async directory => {
  for (const state of ["older", "future", "missing-health"] as const) {
    const f = fixture(), fake = fakeTransport(f.plan, f.before);
    if (state === "older") fake.change({ ...f.before, observed_at: at });
    if (state === "missing-health") f.measured.health.raw = null;
    await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, { transport: fake.transport, journal: fileLedgerJournal(join(directory, state)),
      clock: state === "future" ? () => Date.parse(started) - 300001 : clock }));
    assert.equal(fake.posts(), 0);
  }
}));

test("POST timeout is bounded and subsequent invocations never POST again", async () => temporary(async directory => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before); let posts = 0;
  fake.transport.post = async () => { posts++; return new Promise(() => {}); };
  const ports = { transport: fake.transport, journal: fileLedgerJournal(directory), clock, timeout_ms: 10, uuid: () => requestId };
  assert.equal((await sendSetupSnapshot(f.plan, f.completion, f.measured, ports)).status, "unknown");
  assert.equal((await reconcileLedger(f.plan, ports))!.status, "unknown"); assert.equal(posts, 1);
}));

test("different GET metadata blocks receipt confirmation; omitted prior targets stay reported=false", async () => temporary(async directory => {
  const f = fixture(); f.before.bindings.push({ component: "old", target: { kind: "node", series: "22" }, installed: "22.1.0", status: "active", reported: true, observed_at: started });
  const fake = fakeTransport(f.plan, f.before), post = fake.transport.post;
  fake.transport.post = async (path, body, signal) => { const reply = await post(path, body, signal); fake.change({ ...fake.product(), version: 2 }); return reply; };
  const ports = { transport: fake.transport, journal: fileLedgerJournal(directory), clock, uuid: () => requestId };
  assert.equal((await sendSetupSnapshot(f.plan, f.completion, f.measured, ports)).status, "unknown");
  const old = fake.product().bindings.find(row => row.component === "old")!;
  assert.equal(old.reported, false); assert.equal(old.status, "active"); assert.equal(fake.posts(), 1);
}));

test("orphan lock, truncated journal and changed durable body cannot cause another POST", async () => temporary(async directory => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before), journal = fileLedgerJournal(directory);
  await writeFile(join(directory, "operation.lock"), "");
  await assert.rejects(sendSetupSnapshot(f.plan, f.completion, f.measured, { transport: fake.transport, journal, clock }), /locked/);
  await rm(join(directory, "operation.lock")); await writeFile(join(directory, "journal.jsonl"), '{"truncated":');
  await assert.rejects(reconcileLedger(f.plan, { transport: fake.transport, journal, clock }), /truncated/);
  await writeFile(join(directory, "journal.jsonl"), "");
  await sendSetupSnapshot(f.plan, f.completion, f.measured, { transport: fake.transport, journal, clock, uuid: () => requestId });
  const text = await readFile(join(directory, "journal.jsonl"), "utf8");
  const events = text.trim().split("\n").map(line => JSON.parse(line) as JournalState); events[0]!.body = events[0]!.body.replace("0.16.3", "9.99.9");
  await writeFile(join(directory, "journal.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  await assert.rejects(reconcileLedger(f.plan, { transport: fake.transport, journal, clock }), /corrupt/); assert.equal(fake.posts(), 1);
}));

function setupPorts() {
  const record = async (client: string) => ({ client, status: "registered", server: { command: "synthetic-mcp", args: [], env: {} } });
  return { platform: "linux", register: record, read: record, state: async () => "ready", verify: async () => ({ status: "ready" }),
    browser: async () => ({ status: "ready", reason: "ready" }), steer: async () => { throw new Error("unexpected codex"); },
    cursorHooks: () => { throw new Error("unexpected cursor"); } };
}
test("normal setup/check completion hook binds its own run; check collects only even with a sender", async () => temporary(async directory => {
  for (const check of [false, true]) {
    const f = fixture(), fake = fakeTransport(f.plan, f.before); let ticks = 0;
    const hook = createLedgerCompletionHook(f.plan, { clock: () => ++ticks === 1 ? started : completed, uuid: () => runId,
      measure: async start => { assert.equal(start.run_id, runId); return f.measured; },
      sender: { transport: fake.transport, journal: fileLedgerJournal(join(directory, String(check))), clock, uuid: () => requestId } });
    const result = await setup({ clients: ["claude"], check, updateLedger: hook }, setupPorts() as unknown as Parameters<typeof setup>[1]);
    assert.ok("updateLedger" in result);
    assert.equal(result.overall, "ready"); assert.equal((result.updateLedger as { status: string }).status, check ? "collected" : "confirmed");
    assert.equal(fake.posts(), check ? 0 : 1); assert.equal(fake.gets(), check ? 0 : 3);
  }
}));

test("normal completion with rawhealth null returns a visible blocked result with unknown retained, and no transport call", async () => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before); f.measured.health.raw = null; let ticks = 0;
  const hook = createLedgerCompletionHook(f.plan, { clock: () => ++ticks === 1 ? started : completed, uuid: () => runId, measure: async () => f.measured,
    sender: { transport: fake.transport, journal: { exclusive: async () => { throw new Error("unexpected journal"); } } } });
  const result = await setup({ clients: ["claude"], updateLedger: hook }, setupPorts() as unknown as Parameters<typeof setup>[1]);
  assert.ok("updateLedger" in result);
  const outcome = result.updateLedger as { status: string; reason: string; measurement: RuntimeMeasurement };
  assert.equal(result.overall, "ready"); assert.equal(outcome.status, "blocked"); assert.equal(outcome.reason, "ledger_health_unknown");
  assert.equal(outcome.measurement.health.raw, null); assert.equal(fake.gets(), 0); assert.equal(fake.posts(), 0);
});

test("installed completion composition binds the normal result to a synthetic installed manifest/receipt", async () => temporary(async directory => {
  const f = fixture(); f.plan.identity.execution_prefix = directory; f.measured.health.acceptance!.execution_prefix = directory;
  const bytes = JSON.stringify({ name: "gpt-connector", version: "0.16.3" }); await writeFile(join(directory, "package.json"), bytes);
  let ticks = 0;
  const hook = createInstalledLedgerCompletionHook(f.plan, { uuid: () => runId, clock: () => [started, at, completed][ticks++]!,
    deployment: async () => ({ execution_prefix: directory, manifest_sha256: sha256(bytes), deployment_revision: f.measured.source.deployment_revision, evidence_ref: "synthetic-deployment" }),
    health: async (start, result) => { assert.equal(start.run_id, runId); assert.equal(result.overall, "ready"); return f.measured.health; } });
  const result = await setup({ clients: ["claude"], updateLedger: hook }, setupPorts() as unknown as Parameters<typeof setup>[1]);
  assert.ok("updateLedger" in result);
  const collected = result.updateLedger as { status: string; observation: { observed_at: string; deployment_revision: string } };
  assert.equal(collected.status, "collected"); assert.equal(collected.observation.observed_at, at);
  assert.equal(collected.observation.deployment_revision, f.measured.source.deployment_revision);
}));

test("check run cannot be relabelled setup, and a completion provider cannot mutate the normal setup outcome", async () => {
  const f = fixture(), fake = fakeTransport(f.plan, f.before);
  const hook = createLedgerCompletionHook(f.plan, { clock: () => started, uuid: () => runId, measure: async () => { throw new Error("unexpected measurement"); },
    sender: { transport: fake.transport, journal: { exclusive: async () => { throw new Error("unexpected journal"); } } } });
  const start = hook.begin("check");
  assert.equal((await hook.complete(start, "setup", f.completion.result) as { reason: string }).reason, "ledger_unbound_run");
  assert.equal(fake.gets(), 0); assert.equal(fake.posts(), 0);
  const malicious = { begin: () => ({ run_id: runId, started_at: started }), complete: async (_start: unknown, _mode: unknown, result: { overall: string }) => {
    result.overall = "ready"; return { status: "blocked" };
  } };
  const result = await setup({ clients: ["claude"], updateLedger: malicious }, { ...setupPorts(), browser: async () => ({ status: "failed", reason: "runtime_drift" }) } as unknown as Parameters<typeof setup>[1]);
  assert.equal(result.overall, "failed");
});
