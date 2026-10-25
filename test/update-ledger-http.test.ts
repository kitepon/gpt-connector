import assert from "node:assert/strict";
import test from "node:test";
import { canonical, productAfterSnapshot, type CurrentProduct, type LedgerPlan, type RuntimeMeasurement, type SetupCompletion, type Snapshot } from "../src/update-ledger-contract.js";
import { ledgerOrigin, productPaths, reconcileLedger, sendSetupSnapshot } from "../src/update-ledger-sender.js";
import type { JournalState, LedgerJournal } from "../src/update-ledger-journal.js";
import type { LedgerHttpOptions } from "../src/update-ledger-http.js";
import { createLedgerCompletionHook } from "../src/update-ledger-hook.js";
import { setup } from "../src/setup.js";

const identity: LedgerPlan["identity"] = { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner: { system: "bellteam", id: "bot-7696018a" }, execution_prefix: "/synthetic/install" };
const paths = productPaths(identity.product_id), token = "SYNTHETIC_CREDENTIAL_NOT_A_REAL_SECRET";
const runId = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222";
const started = "2026-10-25T05:00:00.000Z", at = "2026-10-25T05:00:00.100Z", completed = "2026-10-25T05:00:00.200Z";
const snapshot: Snapshot = { request_id: requestId, expected_version: 7, observed_at: at, deployment_revision: "synthetic-deployed", healthy: true,
  bindings: [{ component: "connector", target: { kind: "npm", name: "gpt-connector", series: "0.16" }, installed: "0.16.3", status: "active" }] };
const plan: LedgerPlan = { identity, source_wire_agreement_ref: "synthetic-agreement", health_agreement_ref: "synthetic-health-agreement", required_clients: ["claude"],
  targets: [{ component: "connector", target: snapshot.bindings[0]!.target, adoption_ref: "synthetic-adoption" }] };
const before: CurrentProduct = { product_id: identity.product_id, app: "GPT", owner: identity.owner, version: 1, inventory_version: 7, inventory_max_age_hours: 168,
  bindings: [], created_at: started, updated_at: started };
const result: SetupCompletion["result"] = { schema: "gpt-connector.setup.v1", version: "0.16.3", overall: "ready",
  registrations: [{ client: "claude", stateRead: "ready", mcp: { status: "ready" }, live: { status: "ready" } }] };
const measurement: RuntimeMeasurement = { identity, run_id: runId, observed_at: at,
  source: { kind: "installed-package", name: "gpt-connector", installed: "0.16.3", deployment_revision: "synthetic-deployed", manifest_sha256: "a".repeat(64), deployment_evidence_ref: "synthetic-receipt" },
  bindings: snapshot.bindings,
  health: { run_id: runId, observed_at: at, raw: true, acceptance: { run_id: runId, observed_at: at, source_revision: "synthetic-deployed",
    execution_prefix: identity.execution_prefix, normal_path: true, passed: true, evidence_ref: "synthetic-acceptance" } } };
function response(path: string, body: unknown, status = 200) {
  const reply = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  Object.defineProperty(reply, "url", { value: ledgerOrigin + path }); return reply;
}
function options(fetch: typeof globalThis.fetch): LedgerHttpOptions {
  return { timeout_ms: 100, assertActive: async () => {}, credential: async scope => ({ product_id: scope.product_id, owner: scope.owner, bearer: token }), fetch };
}
const signal = () => new AbortController().signal;

test("HTTP module import and transport construction perform no credential/network/journal operations", async () => {
  let network = 0, secrets = 0, guards = 0; const previous = globalThis.fetch;
  globalThis.fetch = async () => { network++; throw new Error("unexpected real fetch"); };
  try {
    const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js");
    const transport = createLedgerHttpTransport(identity, { timeout_ms: 100, assertActive: async () => { guards++; },
      credential: async () => { secrets++; throw new Error("unexpected secret"); } });
    assert.equal(transport.identity.product_id, identity.product_id); assert.deepEqual([network, secrets, guards], [0, 0, 0]);
  } finally { globalThis.fetch = previous; }
});

test("HTTP execution uses fixed origin/product path, guarded lazy scoped credentials, explicit deadline and redirect:error", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js"); const events: string[] = [];
  const transport = createLedgerHttpTransport(identity, { ...options(async (url, init) => {
    events.push("fetch"); assert.equal(url, ledgerOrigin + paths.get); assert.equal(init!.redirect, "error");
    assert.equal(init!.credentials, "omit"); assert.equal(init!.cache, "no-store"); assert.equal(init!.method, "GET");
    assert.equal(new Headers(init!.headers).get("authorization"), `Bearer ${token}`); assert.ok(init!.signal);
    return response(paths.get, { product: before });
  }), assertActive: async scope => { events.push("guard"); assert.deepEqual(scope, identity); },
  credential: async scope => { events.push("credential"); return { product_id: scope.product_id, owner: scope.owner, bearer: token }; } });
  assert.deepEqual(await transport.get(paths.get, signal()), { product: before });
  assert.deepEqual(events, ["guard", "credential", "guard", "fetch"]);
});

test("wrong product path, credential owner and noncanonical POST body stop before network; exact body is not reserialized", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js"); let network = 0, secrets = 0;
  const config = options(async (_url, init) => { network++; assert.equal(init!.body, canonical(snapshot)); return response(paths.post, { product: before, replayed: false }); });
  config.credential = async scope => { secrets++; return { product_id: scope.product_id, owner: scope.owner, bearer: token }; };
  const transport = createLedgerHttpTransport(identity, config);
  await assert.rejects(transport.get("http://elsewhere.invalid/redirect", signal()), /ledger_http_input/);
  await assert.rejects(transport.get(productPaths("gpt-connector-main-server").get, signal()), /ledger_http_input/);
  await assert.rejects(transport.post(paths.post, JSON.stringify(snapshot, null, 2), signal()), /ledger_http_input/);
  assert.deepEqual([network, secrets], [0, 0]);
  await transport.post(paths.post, canonical(snapshot), signal()); assert.deepEqual([network, secrets], [1, 1]);
  const wrong = createLedgerHttpTransport(identity, { ...config, credential: async () => ({ product_id: identity.product_id, owner: { system: "bellteam", id: "wrong" } as unknown as typeof identity.owner, bearer: token }) });
  await assert.rejects(wrong.get(paths.get, signal()), /ledger_http_scope/); assert.equal(network, 1);
});

test("redirect statuses, followed redirects and changed response URL are rejected without a follow-up request", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js");
  for (const mode of ["status", "followed", "url"]) {
    let requests = 0;
    const transport = createLedgerHttpTransport(identity, options(async () => {
      requests++; const reply = response(paths.get, {}, mode === "status" ? 302 : 200);
      if (mode === "followed") Object.defineProperty(reply, "redirected", { value: true });
      if (mode === "url") { const other = response(paths.post, {}); return other; }
      return reply;
    }));
    await assert.rejects(transport.get(paths.get, signal()), /ledger_http_redirect/); assert.equal(requests, 1);
  }
});

test("deadline covers a stalled credential provider; later resolution cannot start network, and pre-abort never reads secrets", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js"); let network = 0, secrets = 0;
  let release!: (value: { product_id: string; owner: typeof identity.owner; bearer: string }) => void;
  const transport = createLedgerHttpTransport(identity, { ...options(async () => { network++; return response(paths.get, {}); }), timeout_ms: 10,
    credential: async () => { secrets++; return new Promise(resolve => { release = resolve; }); } });
  await assert.rejects(transport.get(paths.get, signal()), /ledger_http_timeout/);
  release({ product_id: identity.product_id, owner: identity.owner, bearer: token });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual([network, secrets], [0, 1]);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(transport.get(paths.get, aborted.signal), /ledger_http_aborted/); assert.equal(secrets, 1);
  let cancelled = 0;
  const stalledBody = createLedgerHttpTransport(identity, { ...options(async () => {
    const reply = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "application/json" } });
    Object.defineProperty(reply, "url", { value: ledgerOrigin + paths.get }); return reply;
  }), timeout_ms: 10 });
  await assert.rejects(stalledBody.get(paths.get, signal()), /ledger_http_timeout/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1);
});

test("failed active guard and raw transport/status errors never disclose credentials or response bodies", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js"); let secrets = 0, requests = 0;
  const guarded = createLedgerHttpTransport(identity, { ...options(async () => { requests++; throw new Error(token); }),
    assertActive: async () => { throw new Error(token); }, credential: async () => { secrets++; throw new Error(token); } });
  await assert.rejects(guarded.get(paths.get, signal()), /ledger_http_guard/); assert.deepEqual([secrets, requests], [0, 0]);
  let guards = 0;
  const revoked = createLedgerHttpTransport(identity, { ...options(async () => { requests++; throw new Error("unexpected request"); }),
    assertActive: async () => { if (++guards === 2) throw new Error("synthetic generation revoked"); } });
  await assert.rejects(revoked.get(paths.get, signal()), /ledger_http_guard/); assert.equal(requests, 0);
  for (const mode of ["throw", "status"]) {
    const transport = createLedgerHttpTransport(identity, options(async () => { if (mode === "throw") throw new Error(token); return response(paths.get, { echoed: token }, 500); }));
    await assert.rejects(transport.get(paths.get, signal()), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, mode === "throw" ? "ledger_http_transport" : "ledger_http_status");
      assert.equal(String(error.stack).includes(token), false); assert.equal(error.cause, undefined); return true;
    });
  }
});

test("bounded JSON response rejects wrong content type, oversized content and invalid JSON without retry", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js");
  for (const mode of ["type", "size", "json"]) {
    let requests = 0;
    const transport = createLedgerHttpTransport(identity, options(async () => {
      requests++; const body = mode === "size" ? '"' + "x".repeat(1024 * 1024) + '"' : "invalid-json";
      const reply = new Response(body, { headers: { "content-type": mode === "type" ? "text/html" : "application/json" } });
      Object.defineProperty(reply, "url", { value: ledgerOrigin + paths.get }); return reply;
    }));
    await assert.rejects(transport.get(paths.get, signal()), /ledger_http_(response|transport)/); assert.equal(requests, 1);
  }
});

test("HTTP POST response loss composes with existing sender as GET-only, with one POST and no new UUID", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js"); let product = structuredClone(before), posts = 0, gets = 0, uuids = 0;
  const transport = createLedgerHttpTransport(identity, options(async (_url, init) => {
    if (init!.method === "GET") { gets++; return response(paths.get, { product }); }
    posts++; assert.equal(init!.body, canonical(snapshot)); product = productAfterSnapshot(before, snapshot, completed);
    throw new Error("synthetic POST response lost");
  }));
  let state: JournalState | null = null;
  const journal: LedgerJournal = { exclusive: async work => work({ current: () => state, append: async next => { state = structuredClone(next); } }) };
  const ports = { transport, journal, clock: () => Date.parse(completed), uuid: () => { uuids++; return requestId; } };
  const completion = { run: { run_id: runId, started_at: started, completed_at: completed, mode: "setup" as const }, result };
  assert.equal((await sendSetupSnapshot(plan, completion, measurement, ports)).status, "observed");
  assert.equal((await reconcileLedger(plan, ports))!.status, "observed"); assert.deepEqual([posts, gets, uuids], [1, 4, 1]);
});

test("normal --check with HTTP sender injected performs no credential, network or journal writes", async () => {
  const { createLedgerHttpTransport } = await import("../src/update-ledger-http.js"); let secrets = 0, network = 0, journalWrites = 0, ticks = 0;
  const transport = createLedgerHttpTransport(identity, { ...options(async () => { network++; throw new Error("unexpected network"); }),
    credential: async () => { secrets++; throw new Error("unexpected secret"); } });
  const journal: LedgerJournal = { exclusive: async () => { journalWrites++; throw new Error("unexpected journal"); } };
  const hook = createLedgerCompletionHook(plan, { clock: () => ++ticks === 1 ? started : completed, uuid: () => runId,
    measure: async () => measurement, sender: { transport, journal } });
  const record = async (client: string) => ({ client, status: "registered", server: { command: "synthetic-mcp", args: [], env: {} } });
  const ports = { platform: "linux", register: record, read: record, state: async () => "ready", verify: async () => ({ status: "ready" }),
    browser: async () => ({ status: "ready", reason: "ready" }), steer: async () => { throw new Error("unexpected codex"); }, cursorHooks: () => { throw new Error("unexpected cursor"); } };
  const checked = await setup({ clients: ["claude"], check: true, updateLedger: hook }, ports as unknown as Parameters<typeof setup>[1]);
  assert.ok("updateLedger" in checked); assert.equal((checked.updateLedger as { status: string }).status, "collected");
  assert.deepEqual([secrets, network, journalWrites], [0, 0, 0]);
});
