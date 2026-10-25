import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { runInInteractiveSession, type InteractiveSessionPorts } from "../src/platform/windows-interactive.js";
import { ConnectorError } from "../src/errors.js";

function fixture(acceptedAt: number) {
  let time = 0, calls = 0;
  const ports: InteractiveSessionPorts = { now: () => time, runPowerShell: async (_script, _timeout, receipt) => {
    calls++;
    // Empty poll at 990, sleep25, worker completes1001 and receipt appears1002; adoption sees1015.
    // A late worker can still return an old-format ok receipt; the common consumer must reject it.
    await writeFile(receipt.path, JSON.stringify({ nonce: receipt.nonce, session_id: 1, owner_matches: true, ok: true }));
    time = acceptedAt;
    return JSON.stringify({ ok: true, error_code: null, task_removed: true, target_session: 1 });
  } };
  return { ports, calls: () => calls };
}

test("a receipt observed after the original1000ms deadline is rejected even when worker/control claim ok and cleanup completed", async () => {
  const f = fixture(1015);
  await assert.rejects(runInInteractiveSession("'synthetic'", 1000, f.ports), error =>
    error instanceof ConnectorError && error.code === "CDP_UNAVAILABLE" && error.details?.reason === "interactive_task_deadline" && error.details?.cleanupUnconfirmed === false);
  assert.equal(f.calls(), 1);
});

test("the same receipt is accepted inside the original1000ms deadline", async () => {
  const f = fixture(990);
  await runInInteractiveSession("'synthetic'", 1000, f.ports);
  assert.equal(f.calls(), 1);
});
