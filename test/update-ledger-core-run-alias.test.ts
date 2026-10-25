import assert from "node:assert/strict";
import test from "node:test";
import { createProductCoreObserver } from "../src/update-ledger-core-observer.js";
import type { CoreRuntimeSelf } from "../src/update-ledger-core-observer-ports.js";

for (const mutate of [true, false]) test(`begin bridge runtime alias is private: mutation=${mutate}`, async () => {
  const original: CoreRuntimeSelf = { pid: 30, ppid: 20, uid: 1000, gid: 1000, cwd: "/fixture", exec_path: "/fixture/node",
    process_version: "v24.22.1", entry_path: "/fixture/original.mjs" };
  let external: CoreRuntimeSelf | undefined;
  const ref = { ref: "fixture-original", sha256: "a".repeat(64), bytes: 10 };
  const observer = createProductCoreObserver({ async exchange(phase, control) {
    assert.equal(phase, "core_begin"); external = control.runtime_self;
    if (mutate) Object.assign(control.runtime_self, { entry_path: "/fixture/changed-by-bridge.mjs" });
    return { status: "recorded_raw", kind: "fixture_core", original: ref,
      kernel_identity: { boot_id: "123e4567-e89b-42d3-a456-426614174000", pid: original.pid, start_ticks: "99",
        effective_uid: original.uid, effective_gid: original.gid, cwd: original.cwd, executable_realpath: original.exec_path },
      launcher_identity: "fixture:launcher", public_setup_before: ref,
      normal_job_binding: "unknown_until_dispatcher_source_correlation", reporting_allowed: false, resource_read_authorized: false };
  } }, { ownRuntime: () => ({ ...original }), now: () => 1000, uuid: () => "123e4567-e89b-42d3-a456-426614174001" });
  const run = await observer.beginOwnCore("setup", original);
  assert.ok("token" in run);
  if (!("token" in run)) return;
  assert.equal(run.runtime_self.entry_path, "/fixture/original.mjs");
  if (mutate) {
    assert.notStrictEqual(run.runtime_self, external);
    Object.assign(external!, { entry_path: "/fixture/later-bridge-change.mjs" });
  }
  Object.assign(original, { entry_path: "/fixture/later-caller-change.mjs" });
  assert.equal(run.runtime_self.entry_path, "/fixture/original.mjs");
  assert.equal(Object.isFrozen(run.runtime_self), true);
});
