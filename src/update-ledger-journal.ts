import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
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

export interface JournalLease {
  mode: "EX";
  resources: readonly string[];
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface FileJournalOptions {
  /** Same one-owner native helper as deployment; its fixed OS lock is never replaced/deleted here. */
  withExclusiveLease?<T>(resource: string, work: (lease: JournalLease) => Promise<T>): Promise<T>;
}
function privateStat(info: Stats, directory: boolean) {
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) throw new Error("ledger_journal_file_type");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid!())) throw new Error("ledger_journal_permissions");
}
function sameFile(left: Stats, right: Stats) { return left.dev === right.dev && left.ino === right.ino; }
async function removeOwnedLock(path: string, owned: Stats, directoryHandle: FileHandle) {
  if (!sameFile(owned, await lstat(path))) throw new Error("ledger_journal_file_changed");
  await unlink(path); await directoryHandle.sync();
}
async function assertDirectory(directory: string, handle: FileHandle) {
  const actual = await lstat(directory); privateStat(actual, true);
  if (actual.isSymbolicLink() || await realpath(directory) !== resolve(directory) || !sameFile(actual, await handle.stat())) throw new Error("ledger_journal_symlink");
}
async function guard(directory: string, handle: FileHandle, lease?: JournalLease) {
  await assertDirectory(directory, handle);
  if (lease) {
    if (lease.mode !== "EX" || canonical(lease.resources) !== canonical([resolve(directory)]) || lease.signal.aborted) throw new Error("ledger_journal_lease_invalid");
    await lease.assertCurrent();
    if (lease.signal.aborted) throw new Error("ledger_journal_lease_invalid");
  }
}
async function storage<T>(directory: string, directoryHandle: FileHandle, work: (session: JournalSession) => Promise<T>, lease?: JournalLease): Promise<T> {
  await guard(directory, directoryHandle, lease);
  const path = join(directory, "journal.jsonl");
  const file = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const actual = await file.stat(); privateStat(actual, false);
    if (!sameFile(actual, await lstat(path))) throw new Error("ledger_journal_file_changed");
    await file.sync(); await directoryHandle.sync();
    if (actual.size > 2 * 1024 * 1024) throw new Error("ledger_journal_capacity");
    const content = await file.readFile("utf8");
    if (content && !content.endsWith("\n")) throw new Error("ledger_journal_truncated");
    let current: JournalState | null = null;
    for (const line of content.split("\n").filter(Boolean)) { const state = checkState(JSON.parse(line)); checkTransition(current, state); current = state; }
    const result = await work({ current: () => {
      if (lease?.signal.aborted) throw new Error("ledger_journal_lease_invalid");
      return current === null ? null : structuredClone(current);
    }, async append(input) {
      await guard(directory, directoryHandle, lease);
      if (!sameFile(await file.stat(), await lstat(path))) throw new Error("ledger_journal_file_changed");
      privateStat(await file.stat(), false);
      const state = checkState(input); checkTransition(current, state);
      await file.writeFile(`${JSON.stringify(state)}\n`); await file.sync(); await directoryHandle.sync();
      await guard(directory, directoryHandle, lease);
      current = structuredClone(state);
    } });
    await guard(directory, directoryHandle, lease);
    return result;
  } finally { await file.close(); }
}

/** Native mode borrows the common helper. Legacy wx orphans/truncated writes remain explicit stops; never guessed away. */
export function fileLedgerJournal(directory: string, options: FileJournalOptions = {}): LedgerJournal {
  return { async exclusive<T>(work: (session: JournalSession) => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const before = await lstat(directory); privateStat(before, true);
    if (before.isSymbolicLink() || await realpath(directory) !== resolve(directory)) throw new Error("ledger_journal_symlink");
    const directoryHandle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const lockPath = join(directory, "operation.lock");
    try {
      await guard(directory, directoryHandle);
      if (!sameFile(before, await directoryHandle.stat())) throw new Error("ledger_journal_file_changed");
      if (options.withExclusiveLease) return await options.withExclusiveLease(resolve(directory), async lease => {
        await guard(directory, directoryHandle, lease);
        // An old wx lock requires explicit migration/recovery; OS ownership does not justify deleting it.
        try { await lstat(lockPath); throw new Error("ledger_journal_locked"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return storage(directory, directoryHandle, work, lease);
      });
      let lock;
      try { lock = await open(lockPath, "wx", 0o600); } catch { throw new Error("ledger_journal_locked"); }
      const owned = await lock.stat();
      try {
        privateStat(owned, false); await lock.sync(); await directoryHandle.sync();
        return await storage(directory, directoryHandle, work);
      } finally {
        await lock.close();
        await removeOwnedLock(lockPath, owned, directoryHandle);
      }
    } finally { await directoryHandle.close(); }
  } };
}
