// Dedicated child core fixture; not the product CLI and not a live trust adapter.
import assert from "node:assert/strict";
import { createPublicJsonFrame } from "../../src/public-json.js";
import { setupNext } from "../../src/setup-public-text.js";
import { createProductCoreObserver, createCoreWriteObserver, readOwnCoreRuntime } from "../../src/update-ledger-core-observer.js";
import { fixtureExchange } from "./core-helper-bridge.js";
const [directory, expiry, decision] = process.argv.slice(2);
assert.ok(directory && expiry);
const observer = createProductCoreObserver({ async exchange(phase, control, frame) { return fixtureExchange(directory, expiry, phase, control, frame); } });
const run = await observer.beginOwnCore("setup", readOwnCoreRuntime());
assert.ok("token" in run, JSON.stringify({ run, privateReason: observer.privateHelperReason }));
if ("token" in run) {
  const frame = createPublicJsonFrame({ schema: "gpt-connector.setup.v1", version: "0.16.4", overall: "partial", package: "ready",
    registrations: [{ client: "grok", path: "/fixture/.grok/config.toml", backup: null, status: "existing", stateRead: "ready", clientActivation: "disabled_by_user", mcp: "not_checked" }],
    live: { supported: false }, next: setupNext, ...(decision === "metadata_only" ? { env: { TOKEN: "fixture-secret-sentinel" } } : {}) });
  const write = createCoreWriteObserver(frame, 2);
  process.stdout.write(frame.text, write.callback);
  const completion = await write.completed;
  assert.equal(completion.frame_admission.decision, decision);
  const outcome = await observer.completeOwnCore(run, completion);
  process.stdout.write(`@@fixture:${JSON.stringify({ outcome, privateReason: observer.privateHelperReason,
    frameSha: completion.serialized_result_sha256, frameBytes: completion.serialized_result_bytes, evidenceKind: run.evidence_kind })}\n`);
  process.exitCode = 2;
}
