import { open } from "node:fs/promises";
import { join } from "node:path";
import { productAfterSnapshot, type Snapshot } from "../../src/update-ledger-contract.js";
import { nativeLedgerJournal } from "../../src/update-ledger-native-journal.js";
import { sendSetupSnapshot } from "../../src/update-ledger-sender.js";
import { existingFixture, generation, journalNative, observedReadLease } from "./shared-native-fixture.js";

const f = await existingFixture(process.argv[2]!);
await f.adapter.withReadLease([f.prefix], generation, Date.now() + 30000, async raw => {
  const parent = observedReadLease(raw), observations: Record<string, unknown>[] = [];
  const journal = nativeLedgerJournal(f.journal, journalNative(f.adapter, observations), parent, Date.now() + 25000);
  await sendSetupSnapshot(f.data.plan, f.data.completion, f.data.measured, { journal, uuid: () => "22222222-2222-4222-8222-222222222222", timeout_ms: 15000,
    transport: { identity: f.data.plan.identity, get: async () => ({ product: f.data.before }), post: async (_path, body) => {
      const product = productAfterSnapshot(f.data.before, JSON.parse(body) as Snapshot, new Date().toISOString());
      const handle = await open(join(f.root, "fake-remote-witness.json"), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ body, product }) + "\n"); await handle.sync(); } finally { await handle.close(); }
      const root = await open(f.root, "r"); try { await root.sync(); } finally { await root.close(); }
      process.send?.({ event: "post-visible", parentHelperPid: parent.helperPid, observations });
      return new Promise<never>(() => {}); // Parent kills only this owned Node producer before a POST reply.
    } } });
});
