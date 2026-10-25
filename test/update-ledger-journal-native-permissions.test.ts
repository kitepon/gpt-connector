import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeJournalFixture } from "./fixtures/ledger-native-state.js";
import { fileLedgerJournal } from "../src/update-ledger-journal.js";

async function fixture(work: (directory: string) => Promise<void>) {
  const root = resolve("../../artifacts/2026-10-25-update-ledger-native/fixtures");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "private-journal-"));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("real Linux journal refuses a pre-existing exposed directory without rewriting permissions or entering the callback", { skip: process.platform !== "linux" }, async () => {
  await fixture(async directory => {
    await chmod(directory, 0o777); let calls = 0;
    await assert.rejects(fileLedgerJournal(directory).exclusive(async () => { calls++; }), /ledger_journal_permissions/u);
    assert.equal(calls, 0); assert.equal((await stat(directory)).mode & 0o777, 0o777);
  });
});

test("real Linux journal refuses a group-writable existing file and preserves its bytes", { skip: process.platform !== "linux" }, async () => {
  await fixture(async directory => {
    const path = join(directory, "journal.jsonl"); await writeFile(path, "", { mode: 0o600 }); await chmod(path, 0o660); let calls = 0;
    await assert.rejects(fileLedgerJournal(directory).exclusive(async () => { calls++; }), /ledger_journal_permissions/u);
    assert.equal(calls, 0); assert.equal((await stat(path)).mode & 0o777, 0o660); assert.equal(await readFile(path, "utf8"), "");
  });
});


test("real private journal syncs immutable prepared/issued records and reopens the exact pending body", { skip: process.platform !== "linux" }, async () => {
  await fixture(async directory => {
    const f = nativeJournalFixture();
    await fileLedgerJournal(directory).exclusive(async session => {
      await session.append(f.prepared); await session.append(f.issued);
      assert.equal(session.current()!.phase, "issued");
    });
    const path = join(directory, "journal.jsonl"), bytes = await readFile(path, "utf8");
    assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(path)).mode & 0o777, 0o600);
    await fileLedgerJournal(directory).exclusive(async session => {
      assert.equal(session.current()!.phase, "issued"); assert.equal(session.current()!.body, f.issued.body); assert.equal(session.current()!.body_sha256, f.issued.body_sha256);
    });
    assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(stat(join(directory, "operation.lock")), { code: "ENOENT" });
  });
});
