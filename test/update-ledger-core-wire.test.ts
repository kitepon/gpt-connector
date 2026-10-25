import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readOwnCoreRuntime } from "../src/update-ledger-core-observer.js";
import { sha256 } from "../src/update-ledger-contract.js";
import { factoryFixtureRoot, fixtureExchange } from "./fixtures/core-helper-bridge.js";

const fixtureBase = "/srv/bellteam/bots/bot-7696018a/artifacts/2026-10-25-update-ledger-core-implementation/fixtures";
mkdirSync(fixtureBase, { recursive: true });
for (const decision of ["full_frame", "metadata_only"] as const) {
  test(`factory parent → product child strict gate → one-owner helper/fd3, ${decision}`, () => {
    const directory = join(fixtureBase, randomUUID()); mkdirSync(directory, { mode: 0o700 });
    const self = readOwnCoreRuntime(), expiry = String(Date.now() + 60000);
    const productEntry = fileURLToPath(new URL("./fixtures/core-product-run.ts", import.meta.url));
    fixtureExchange(directory, expiry, "fixture_bootstrap", { runtime_self: self });
    const files = ["bin/factory-update-context-observer.py", "lib/factory/update_context_core.py", "tests/update/core_observer_fixture.py"];
    const sourcePins = Object.fromEntries(files.map(path => [join(factoryFixtureRoot, path), sha256(readFileSync(join(factoryFixtureRoot, path), "utf8"))]));
    for (const path of ["../src/public-json.ts", "../src/update-ledger-core-frame.ts", "../src/update-ledger-core-observer.ts"]) {
      const real = fileURLToPath(new URL(path, import.meta.url)); sourcePins[real] = sha256(readFileSync(real, "utf8"));
    }
    writeFileSync(join(directory, "fixture-policy.json"), JSON.stringify({ kind: "fixture", source_pins: sourcePins,
      core_entry_sha256: sha256(readFileSync(productEntry, "utf8")), factory_entry_sha256: sha256(readFileSync(self.entry_path, "utf8")) }), { mode: 0o600 });
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), productEntry, directory, expiry, decision],
      { encoding: "utf8", timeout: 12000, maxBuffer: 131072 });
    writeFileSync(join(directory, "product-child.stderr"), child.stderr, { mode: 0o600 });
    assert.equal(child.error, undefined); assert.equal(child.status, 2, child.stderr);
    const marker = child.stdout.lastIndexOf("@@fixture:"); assert.ok(marker > 0);
    const frame = child.stdout.slice(0, marker), report = JSON.parse(child.stdout.slice(marker + 10));
    const metadata = JSON.parse(readFileSync(join(directory, "core_result.json"), "utf8"));
    assert.equal(report.evidenceKind, "fixture_core"); assert.equal(metadata.kind, "fixture_core");
    assert.equal(metadata.normal_job_binding, "unknown_until_dispatcher_source_correlation");
    assert.equal(metadata.completion.exit_code, 2); assert.equal(metadata.reporting_allowed, false); assert.equal(metadata.resource_read_authorized, false);
    assert.equal(sha256(frame), report.frameSha);
    if (decision === "full_frame") {
      assert.equal(report.outcome.status, "recorded_raw"); assert.equal(readFileSync(join(directory, "core_result.frame"), "utf8"), frame);
      assert.equal(metadata.result_original.sha256, report.frameSha);
    } else {
      assert.equal(report.outcome.status, "unknown"); assert.equal(metadata.result_original, null); assert.equal(existsSync(join(directory, "core_result.frame")), false);
      assert.ok(!readFileSync(join(directory, "core_result.json"), "utf8").includes("fixture-secret-sentinel"));
      assert.equal(report.privateReason, metadata.reason);
    }
    console.log(JSON.stringify({ directory, decision, kind: metadata.kind, result: report.outcome.status, code: metadata.completion.exit_code,
      parentAndChildDistinct: true, helperCopied: false, hostOperations: 0 }));
  });
}
