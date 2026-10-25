import { fileLedgerJournal, type JournalLease, type LedgerJournal } from "./update-ledger-journal.js";
import type { ReadLease } from "./update-ledger-provider-ports.js";

export type NativeJournalParentLease = Pick<ReadLease, "mode" | "resources" | "signal" | "assertCurrent">;

export interface CommonJournalNative {
  /** Dorothy's one-owner helper. No local OS lock implementation or automatic loader. */
  withLease<T>(resources: readonly string[], mode: "EX", deadlineEpochMs: number, work: (lease: JournalLease) => Promise<T>,
    options: { signal?: AbortSignal; purpose: "journal"; parentLease: NativeJournalParentLease }): Promise<T>;
}

/** Deployment SH -> journal EX only; both remain owned by the same fixed native helper until callbacks settle. */
export function nativeLedgerJournal(directory: string, native: CommonJournalNative, parentLease: NativeJournalParentLease, deadlineEpochMs: number): LedgerJournal {
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0) throw new Error("ledger_journal_deadline");
  return fileLedgerJournal(directory, { withExclusiveLease: async (resource, work) => {
    const guard = async () => {
      if (parentLease.mode !== "SH" || parentLease.signal.aborted || Date.now() >= deadlineEpochMs) throw new Error("ledger_journal_parent_lease_invalid");
      await parentLease.assertCurrent();
      if (parentLease.signal.aborted || Date.now() >= deadlineEpochMs) throw new Error("ledger_journal_parent_lease_invalid");
    };
    await guard();
    return native.withLease([resource], "EX", deadlineEpochMs, async lease => {
      await guard();
      const checked: JournalLease = { mode: lease.mode, resources: lease.resources, signal: lease.signal,
        assertCurrent: async () => { await guard(); await lease.assertCurrent(); await guard(); } };
      const result = await work(checked);
      await checked.assertCurrent();
      return result;
    }, { signal: parentLease.signal, purpose: "journal", parentLease });
  } });
}
