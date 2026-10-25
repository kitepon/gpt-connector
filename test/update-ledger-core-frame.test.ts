import assert from "node:assert/strict";
import test from "node:test";
import { createPublicJsonFrame, serializePublicJson } from "../src/public-json.js";
import { setupNext, loginNext } from "../src/setup-public-text.js";
import { setupTools } from "../src/setup-registration.js";
import { admitCoreFrame } from "../src/update-ledger-core-frame.js";
import { createProductCoreObserver, createCoreWriteObserver, prepareCoreCompletion } from "../src/update-ledger-core-observer.js";
import type { ProductCoreRun } from "../src/update-ledger-core-observer-ports.js";
import { sha256 } from "../src/update-ledger-contract.js";

function result() {
  return { schema: "gpt-connector.setup.v1", version: "0.16.4", overall: "partial", package: "ready",
    registrations: [{ client: "claude", path: "/fixture/.claude.json", backup: null, status: "existing", stateRead: "ready",
      clientActivation: "new_client_session_required", enabledTools: [...setupTools], mcp: { status: "ready", tools: [...setupTools], diagnostics: "responded" },
      live: { status: "action_required", reason: "auth_required", next: loginNext } }], live: { supported: true }, next: setupNext };
}
const ref = (name: string) => ({ ref: name, sha256: sha256(name), bytes: 10 });
const flags = { normal_job_binding: "unknown_until_dispatcher_source_correlation", reporting_allowed: false, resource_read_authorized: false } as const;
function fixture() {
  const self = { pid: 30, ppid: 20, uid: 1000, gid: 1000, cwd: "/fixture", exec_path: "/fixture/node", process_version: "v24.22.1", entry_path: "/fixture/core.mjs" };
  let now = 1000, results = 0, body: Uint8Array | null = null;
  let onResult: (() => void) | undefined;
  let resultResponse: unknown | undefined;
  const observer = createProductCoreObserver({ async exchange(phase, control, frame) {
    if (phase === "core_begin") return { status: "recorded_raw", kind: "fixture_core", original: ref("core_begin.json"),
      kernel_identity: { boot_id: "123e4567-e89b-42d3-a456-426614174000", pid: self.pid, start_ticks: "99", effective_uid: self.uid,
        effective_gid: self.gid, cwd: self.cwd, executable_realpath: self.exec_path }, launcher_identity: "fixture:launcher",
      public_setup_before: ref("public_setup_before.json"), ...flags };
    results++; body = frame; onResult?.();
    assert.equal("result_original" in control.completion!, false); // Exact helper DTO, not an unissued result ref.
    return resultResponse ?? { status: "recorded_raw", kind: "fixture_core", original: ref("core_result.json"),
      result_original: { ref: "core_result.frame", sha256: control.completion!.serialized_result_sha256, bytes: control.completion!.serialized_result_bytes }, ...flags };
  } }, { ownRuntime: () => ({ ...self }), now: () => now, uuid: () => "123e4567-e89b-42d3-a456-426614174001" });
  const begin = async () => { const run = await observer.beginOwnCore("setup", self); assert.ok("token" in run); return run as ProductCoreRun; };
  return { self, observer, begin, setTime: () => { now = 1001; }, get results() { return results; }, get body() { return body; },
    onResult: (fn: () => void) => { onResult = fn; }, respond: (value: unknown) => { resultResponse = value; } };
}

test("one original serialize/parse snapshot survives aliases and nested gate does not parse again", () => {
  const value = result(); let serialized = 0, parsed = 0;
  const originalParse = JSON.parse;
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => { parsed++; return originalParse(...args); };
  try {
    const frame = createPublicJsonFrame({ toJSON() { serialized++; return value; } });
    value.registrations[0]!.path = "/fixture/changed-after-serialization";
    const admission = admitCoreFrame(frame); admitCoreFrame(frame);
    assert.equal(serialized, 1); assert.equal(parsed, 1); assert.equal(admission.decision, "full_frame");
    assert.equal(admission.frame_sha256, sha256(frame.text)); assert.equal(admission.frame_bytes, Buffer.byteLength(frame.text));
    assert.ok(!frame.text.includes("changed-after-serialization")); assert.equal(frame.text.endsWith("\n"), true);
    assert.throws(() => admitCoreFrame({ ...frame }), /core_frame_unowned/u);
  } finally { JSON.parse = originalParse; }
  assert.equal(serializePublicJson({ label: "月", value: 2 }), '{\n  "label": "月",\n  "value": 2\n}\n');
});

test("strict nested fields reject env/message/unknown payload without retaining body in admission", () => {
  const edits = [
    (v: ReturnType<typeof result>) => Object.assign(v, { updateLedger: { secret: "sentinel-secret" } }),
    (v: ReturnType<typeof result>) => Object.assign(v.registrations[0]!, { env: { KEY: "sentinel-secret" } }),
    (v: ReturnType<typeof result>) => Object.assign(v.registrations[0]!.mcp, { raw: "sentinel-secret" }),
    (v: ReturnType<typeof result>) => Object.assign(v.registrations[0]!.live, { cookie: "sentinel-secret" }),
    (v: ReturnType<typeof result>) => Object.assign(v.registrations[0]!, { failure: { stage: "mcp", code: "SETUP_MCP_FAILED", message: "sentinel-secret" } }),
    (v: ReturnType<typeof result>) => Object.assign(v.registrations[0]!, { codexSteer: { status: "ready", unknown: "sentinel-secret" } }),
    (v: ReturnType<typeof result>) => Object.assign(v.registrations[0]!, { cursorHooks: { status: "ready", path: "/fixture/hook", changed: false, raw: "sentinel-secret" } }),
  ];
  for (const edit of edits) {
    const value = result(); edit(value);
    const admission = admitCoreFrame(createPublicJsonFrame(value));
    assert.equal(admission.decision, "metadata_only"); assert.equal(admission.reason, "unsupported_fields");
    assert.ok(!JSON.stringify(admission).includes("sentinel-secret"));
  }
});

test("private path bytes, size, tools and duplicate clients are bounded without truncating originals", () => {
  for (const edit of [
    (v: ReturnType<typeof result>) => { v.registrations[0]!.path = "/" + "月".repeat(1366); },
    (v: ReturnType<typeof result>) => { v.registrations[0]!.path = "https://fixture.invalid/path"; },
    (v: ReturnType<typeof result>) => { v.registrations[0]!.mcp.tools.push("unapproved-tool"); },
    (v: ReturnType<typeof result>) => { v.registrations.push(structuredClone(v.registrations[0]!)); },
  ]) { const value = result(); edit(value); assert.equal(admitCoreFrame(createPublicJsonFrame(value)).decision, "metadata_only"); }
  const frame = createPublicJsonFrame({ padding: "x".repeat(65536) });
  const oversized = admitCoreFrame(frame);
  assert.equal(oversized.reason, "frame_too_large"); assert.equal(oversized.frame_bytes, Buffer.byteLength(frame.text));
});

test("adopted private paths and finite optional statuses retain normal disabled/restart/failure fields", () => {
  const value = result(); value.overall = "action_required";
  const codex = { ...structuredClone(value.registrations[0]!), client: "codex", path: "/" + "x".repeat(4095),
    codexSteer: { status: "restart_required", reason_code: "codex_restart_required" },
    failure: { stage: "mcp", code: "SETUP_MCP_FAILED" } };
  const cursor = { ...structuredClone(value.registrations[0]!), client: "cursor",
    cursorHooks: { status: "ready", path: "/fixture/.cursor/hooks.json", changed: false } };
  value.registrations.push(codex, cursor);
  assert.equal(admitCoreFrame(createPublicJsonFrame(value)).decision, "full_frame");
});

test("product run keeps partial/code2 and full original bytes, fixture kind and disabled reporting", async () => {
  const f = fixture(), run = await f.begin(), frame = createPublicJsonFrame(result()); f.setTime();
  const completion = prepareCoreCompletion(frame, { completed_at_utc_ms: 1001, exit_code: 2, stdout_write: "callback_completed" });
  const outcome = await f.observer.completeOwnCore(run, completion);
  assert.equal(outcome.status, "recorded_raw");
  if (outcome.status === "recorded_raw") { assert.equal(outcome.kind, "fixture_core"); assert.equal(outcome.reporting_allowed, false); }
  assert.equal(new TextDecoder().decode(f.body!), frame.text); assert.equal(completion.exit_code, 2); assert.equal(run.evidence_kind, "fixture_core");
});

test("missing original/copy token/forged admission or changed runtime cannot reach full store", async () => {
  const f = fixture(), run = await f.begin(); f.setTime();
  const completion = prepareCoreCompletion(createPublicJsonFrame(result()), { completed_at_utc_ms: 1001, exit_code: 2, stdout_write: "callback_completed" });
  assert.equal((await f.observer.completeOwnCore({ ...run }, completion)).status, "unknown");
  assert.equal((await f.observer.completeOwnCore(run, { ...completion })).status, "unknown");
  assert.equal(f.results, 0);
  f.self.cwd = "/fixture/other";
  assert.equal((await f.observer.completeOwnCore(run, completion)).status, "unknown"); assert.equal(f.results, 0);
});

test("one core activation cannot issue another run from the same observer", async () => {
  const f = fixture(); await f.begin();
  assert.deepEqual(await f.observer.beginOwnCore("setup", f.self), { status: "unknown", reason: "run_mismatch" });
});

test("unknown frame or incomplete write sends no original body and cannot become recorded", async () => {
  for (const mode of ["unknown_frame", "write_failed"] as const) {
    const f = fixture(), run = await f.begin(); f.setTime();
    const completion = prepareCoreCompletion(createPublicJsonFrame(mode === "unknown_frame" ? { ...result(), env: "sentinel" } : result()),
      { completed_at_utc_ms: 1001, exit_code: 2, stdout_write: mode === "write_failed" ? "failed" : "callback_completed" });
    assert.equal((await f.observer.completeOwnCore(run, completion)).status, "unknown"); assert.equal(f.body, null);
  }
});

test("reentrant result uses one reserved helper request and keeps safe private helper reason", async () => {
  const f = fixture(), run = await f.begin(); f.setTime();
  const completion = prepareCoreCompletion(createPublicJsonFrame(result()), { completed_at_utc_ms: 1001, exit_code: 2, stdout_write: "callback_completed" });
  let nested: Promise<unknown> | undefined;
  f.onResult(() => { nested = f.observer.completeOwnCore(run, completion); });
  f.respond({ status: "unknown", reason: "expected_pins_provenance_missing", result_original: null, ...flags });
  const outer = f.observer.completeOwnCore(run, completion); assert.strictEqual(outer, nested);
  assert.equal((await outer).status, "unknown"); assert.equal(f.results, 1); assert.equal(f.observer.privateHelperReason, "expected_pins_provenance_missing");
});

test("helper frame readback mismatch and stale result kind stay unknown", async () => {
  for (const failure of ["hash", "kind"] as const) {
    const f = fixture(), run = await f.begin(); f.setTime();
    const completion = prepareCoreCompletion(createPublicJsonFrame(result()), { completed_at_utc_ms: 1001, exit_code: 2, stdout_write: "callback_completed" });
    f.respond({ status: "recorded_raw", kind: failure === "kind" ? "observed_core" : "fixture_core", original: ref("core_result.json"),
      result_original: { ref: "core_result.frame", sha256: failure === "hash" ? "0".repeat(64) : completion.serialized_result_sha256, bytes: completion.serialized_result_bytes }, ...flags });
    assert.equal((await f.observer.completeOwnCore(run, completion)).status, "unknown");
  }
});

test("the original write callback binds the same frame/code exactly once without another serialize", async () => {
  for (const failed of [false, true]) {
    let calls = 0;
    const frame = createPublicJsonFrame({ toJSON() { calls++; return result(); } });
    const observed = createCoreWriteObserver(frame, 2, () => 1001);
    let writeCount = 0;
    const ordinaryWrite = (text: string, callback: (error?: Error | null) => void) => {
      writeCount++; assert.equal(text, frame.text); callback(failed ? new Error("private stream failure") : null);
    };
    ordinaryWrite(frame.text, observed.callback); observed.callback(new Error("late duplicate"));
    const completion = await observed.completed;
    assert.equal(calls, 1); assert.equal(writeCount, 1); assert.equal(completion.exit_code, 2);
    assert.equal(completion.stdout_write, failed ? "failed" : "callback_completed"); assert.equal(completion.serialized_result_sha256, sha256(frame.text));
  }
});
