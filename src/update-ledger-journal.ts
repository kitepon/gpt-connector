import { constants } from "node:fs";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { canonical, collectedEvidenceSchema, currentProductSchema, ownerSchema, productAfterSnapshot, productSchema, sha256, snapshotSchema } from "./update-ledger-contract.js";

export const journalStateSchema = z.object({ product_id: productSchema, owner: ownerSchema, run_id: z.uuid(),
  phase: z.enum(["prepared", "issued", "unknown", "observed", "confirmed"]),
  body: z.string().max(1024 * 1024), body_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence: collectedEvidenceSchema, before: currentProductSchema, post_receipt: currentProductSchema.nullable(), readback: currentProductSchema.nullable() }).strict();
export type JournalState = z.infer<typeof journalStateSchema>;
export interface JournalSession { current(): JournalState | null; append(state: JournalState): Promise<void>; }
export interface LedgerJournal { exclusive<T>(work: (session: JournalSession) => Promise<T>): Promise<T>; }

function checkState(value: unknown): JournalState {
  const state = journalStateSchema.parse(value), body = snapshotSchema.parse(JSON.parse(state.body));
  if (sha256(state.body) !== state.body_sha256 || canonical(body) !== state.body || state.product_id !== state.before.product_id ||
      canonical(state.owner) !== canonical(state.before.owner) || state.run_id !== state.evidence.run.run_id || state.run_id !== state.evidence.measurement.run_id ||
      state.product_id !== state.evidence.measurement.identity.product_id || body.observed_at !== state.evidence.measurement.observed_at ||
      body.deployment_revision !== state.evidence.measurement.source.deployment_revision || canonical(body.bindings) !== canonical(state.evidence.measurement.bindings) ||
      body.expected_version !== state.before.inventory_version || body.healthy !== state.evidence.measurement.health.raw ||
      body.healthy !== state.evidence.measurement.health.acceptance?.passed) throw new Error("ledger_journal_corrupt");
  if (["prepared", "issued"].includes(state.phase) && (state.post_receipt || state.readback)) throw new Error("ledger_journal_transition");
  if (state.post_receipt && canonical(productAfterSnapshot(state.before, body, state.post_receipt.updated_at)) !== canonical(state.post_receipt)) throw new Error("ledger_journal_receipt_invalid");
  if (state.phase === "confirmed" && (!state.post_receipt || !state.readback || canonical(state.readback) !== canonical(state.post_receipt))) throw new Error("ledger_journal_confirmation_invalid");
  return state;
}
function checkTransition(previous: JournalState | null, next: JournalState) {
  if (!previous) { if (next.phase !== "prepared") throw new Error("ledger_journal_transition"); return; }
  if (previous.product_id !== next.product_id || canonical(previous.owner) !== canonical(next.owner)) throw new Error("ledger_journal_identity");
  if (previous.phase === "confirmed" && previous.run_id !== next.run_id && next.phase === "prepared") {
    if (JSON.parse(previous.body).request_id === JSON.parse(next.body).request_id) throw new Error("ledger_request_id_reused");
    return;
  }
  if (previous.run_id !== next.run_id || previous.body !== next.body || canonical(previous.before) !== canonical(next.before) || canonical(previous.evidence) !== canonical(next.evidence)) throw new Error("ledger_journal_immutable");
  const allowed = previous.phase === "prepared" ? ["issued", "unknown", "observed"] : previous.phase === "confirmed" ? [] : ["unknown", "observed", "confirmed"];
  if (!allowed.includes(next.phase)) throw new Error("ledger_journal_transition");
  if (previous.post_receipt && canonical(previous.post_receipt) !== canonical(next.post_receipt)) throw new Error("ledger_journal_receipt_changed");
}

/** A failed/truncated write or an orphan lock stops work. There is no automatic repair/reset/retry. */
export function fileLedgerJournal(directory: string): LedgerJournal {
  return { async exclusive<T>(work: (session: JournalSession) => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== resolve(directory)) throw new Error("ledger_journal_symlink");
    const directoryHandle = await open(directory, "r");
    const lockPath = join(directory, "operation.lock");
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); } catch { await directoryHandle.close(); throw new Error("ledger_journal_locked"); }
    try {
      await lock.sync(); await directoryHandle.sync();
      const file = await open(join(directory, "journal.jsonl"), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await file.sync(); await directoryHandle.sync();
        if ((await file.stat()).size > 2 * 1024 * 1024) throw new Error("ledger_journal_capacity");
        const content = await file.readFile("utf8");
        if (content && !content.endsWith("\n")) throw new Error("ledger_journal_truncated");
        let current: JournalState | null = null;
        for (const line of content.split("\n").filter(Boolean)) { const state = checkState(JSON.parse(line)); checkTransition(current, state); current = state; }
        return await work({ current: () => current === null ? null : structuredClone(current), async append(input) {
          const state = checkState(input); checkTransition(current, state);
          await file.writeFile(`${JSON.stringify(state)}\n`); await file.sync(); await directoryHandle.sync();
          current = structuredClone(state);
        } });
      } finally { await file.close(); }
    } finally { await lock.close(); await unlink(lockPath); await directoryHandle.sync(); await directoryHandle.close(); }
  } };
}
