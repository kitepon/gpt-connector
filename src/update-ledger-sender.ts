import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, collectSnapshot, currentProductSchema, planSchema, productAfterSnapshot, sameIdentity, sha256, snapshotSchema,
  productSchema, type CurrentProduct, type LedgerPlan, type SetupCompletion } from "./update-ledger-contract.js";
import type { JournalSession, JournalState, LedgerJournal } from "./update-ledger-journal.js";

export const ledgerOrigin = "http://192.168.1.2:39310";
export function productPaths(productId: string) {
  productSchema.parse(productId);
  return { get: `/api/updates/v1/products/${productId}`, post: `/api/updates/v1/products/${productId}/snapshots` };
}
/** Product-scoped boundary. Optional HTTP composition does not enable the default CLI. */
export interface ProductTransport {
  identity: LedgerPlan["identity"];
  get(path: string, signal: AbortSignal): Promise<unknown>;
  post(path: string, body: string, signal: AbortSignal): Promise<unknown>;
}
export interface SenderPorts { transport: ProductTransport; journal: LedgerJournal; clock?: () => number; uuid?: () => string; timeout_ms?: number; }
export interface SendResult { status: "confirmed" | "unknown" | "observed"; request_id: string; operation_run_id: string; }

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work(abort.signal), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new Error("ledger_transport_timeout")); }, milliseconds);
  })]); } finally { clearTimeout(timer); }
}
function checkPorts(plan: LedgerPlan, ports: SenderPorts) {
  if (!sameIdentity(plan.identity, ports.transport.identity)) throw new Error("ledger_transport_identity_mismatch");
  const timeout = ports.timeout_ms ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 15000) throw new Error("ledger_transport_deadline");
  return timeout;
}
function readProduct(input: unknown, plan: LedgerPlan): CurrentProduct {
  const product = z.object({ product: currentProductSchema }).strict().parse(input).product;
  if (product.product_id !== plan.identity.product_id || !sameIdentity(product.owner, plan.identity.owner)) throw new Error("ledger_remote_identity_mismatch");
  return product;
}
function matchesSnapshot(state: JournalState, product: CurrentProduct): boolean {
  const body = snapshotSchema.parse(JSON.parse(state.body));
  return canonical(productAfterSnapshot(state.before, body, product.updated_at)) === canonical(product);
}
async function getOnly(plan: LedgerPlan, state: JournalState, session: JournalSession, ports: SenderPorts, timeout: number): Promise<SendResult> {
  let readback: CurrentProduct;
  try { readback = readProduct(await bounded(signal => ports.transport.get(productPaths(plan.identity.product_id).get, signal), timeout), plan); }
  catch { return { status: "unknown", request_id: JSON.parse(state.body).request_id as string, operation_run_id: state.run_id }; }
  const matches = matchesSnapshot(state, readback);
  // GET exposes no request_id. Matching fields without a durable receipt are an observation, not an acknowledgement.
  const status = matches && state.post_receipt && canonical(state.post_receipt) === canonical(readback) ? "confirmed" : matches ? "observed" : "unknown";
  await session.append({ ...state, phase: status, readback });
  return { status, request_id: JSON.parse(state.body).request_id as string, operation_run_id: state.run_id };
}

/** All persisted states, including prepared after a crash, resume with GET only. No reset or resend API. */
export async function reconcileLedger(planInput: unknown, ports: SenderPorts): Promise<SendResult | null> {
  const plan = planSchema.parse(planInput), timeout = checkPorts(plan, ports);
  return ports.journal.exclusive(async session => {
    const state = session.current(); if (!state) return null;
    if (state.product_id !== plan.identity.product_id || !sameIdentity(state.owner, plan.identity.owner)) throw new Error("ledger_journal_identity_mismatch");
    if (state.phase === "confirmed") return { status: "confirmed", request_id: JSON.parse(state.body).request_id as string, operation_run_id: state.run_id };
    return getOnly(plan, state, session, ports, timeout);
  });
}

export async function sendSetupSnapshot(planInput: unknown, completion: SetupCompletion, measured: unknown, ports: SenderPorts): Promise<SendResult> {
  const plan = planSchema.parse(planInput), timeout = checkPorts(plan, ports);
  const collected = collectSnapshot(plan, completion, measured);
  return ports.journal.exclusive(async session => {
    const prior = session.current();
    if (prior) {
      if (prior.product_id !== plan.identity.product_id || !sameIdentity(prior.owner, plan.identity.owner)) throw new Error("ledger_journal_identity_mismatch");
      if (prior.phase !== "confirmed") return getOnly(plan, prior, session, ports, timeout);
      if (prior.run_id === completion.run.run_id) {
        if (canonical(prior.evidence) !== canonical(collected.evidence)) throw new Error("ledger_run_reused");
        return { status: "confirmed", request_id: JSON.parse(prior.body).request_id as string, operation_run_id: prior.run_id };
      }
    }
    const paths = productPaths(plan.identity.product_id);
    const before = readProduct(await bounded(signal => ports.transport.get(paths.get, signal), timeout), plan);
    const observed = Date.parse(collected.observation.observed_at), now = (ports.clock ?? Date.now)();
    if (observed > now + 300000 || now - observed > before.inventory_max_age_hours * 3600000 || (before.observed_at && observed <= Date.parse(before.observed_at))) throw new Error("ledger_observation_not_fresh");
    const snapshot = snapshotSchema.parse({ request_id: (ports.uuid ?? randomUUID)(), expected_version: before.inventory_version, ...collected.observation });
    const body = canonical(snapshot);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("ledger_body_too_large");
    const state: JournalState = { product_id: plan.identity.product_id, owner: plan.identity.owner, run_id: completion.run.run_id,
      phase: "prepared", body, body_sha256: sha256(body), evidence: collected.evidence, before, post_receipt: null, readback: null };
    await session.append(state); // UUID/CAS/immutable body are durable before any POST intent.
    const fresh = readProduct(await bounded(signal => ports.transport.get(paths.get, signal), timeout), plan);
    if (canonical(fresh) !== canonical(before)) throw new Error("ledger_cas_changed");
    await session.append({ ...state, phase: "issued" }); // Persist intent first; even a crash before POST is GET-only.
    let receipt: CurrentProduct | null = null;
    try {
      const response = z.object({ product: currentProductSchema, replayed: z.boolean() }).strict()
        .parse(await bounded(signal => ports.transport.post(paths.post, body, signal), timeout));
      if (matchesSnapshot(state, response.product)) receipt = response.product;
    } catch { /* Any error after durable intent is uncertain, including an HTTP failure. Never retry POST. */ }
    const pending: JournalState = { ...state, phase: "unknown", post_receipt: receipt };
    await session.append(pending);
    return getOnly(plan, pending, session, ports, timeout); // Always independent of the POST response.
  });
}
