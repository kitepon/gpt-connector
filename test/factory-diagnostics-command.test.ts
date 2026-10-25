import assert from "node:assert/strict";
import test from "node:test";
import { readFactoryDiagnosticCommandOptions, runFactoryDiagnosticCommand } from "../src/factory-diagnostics-command.js";
import { factoryDiagnosticsSchema } from "../src/factory-diagnostics.js";
import { projectFactoryRuntimeObservation } from "../src/factory-observation-context.js";
import type { FactoryDiagnosticsOptions } from "../src/factory-diagnostics.js";

type Values = ReadonlyMap<string, readonly string[] | true>;
const values = (entries: [string, readonly string[] | true][]): Values => new Map(entries);
const usage = /^Error: usage: gpt-connector factory-diagnostics --json \[--include-observation-context\]$/u;

test("old argv and explicit boolean flag each use the existing export once and preserve its original result", async () => {
  for (const include of [false, true]) {
    const args = values(include ? [["json", true], ["include-observation-context", true]] : [["json", true]]);
    const command = readFactoryDiagnosticCommandOptions("factory-diagnostics", args)!;
    assert.equal(command.includeObservationContext, include); assert.equal(Object.isFrozen(command), true);
    let calls = 0, seen: FactoryDiagnosticsOptions | undefined;
    const checks = Object.values(projectFactoryRuntimeObservation({ officialOrigin: true, authenticated: false, bridgeReady: false,
      observation: { sessionHttpStatus: 401, bridgePresent: false } }, include));
    const original = { schema: factoryDiagnosticsSchema, package_version: "0.16.4", overall: "not_ready" as const,
      diagnostic_schema: "gpt-connector.diagnostics.v1", state: { schema: "1.0", migration: "current" },
      job: { schema: "1.0", migration: "current" }, checks };
    const result = await runFactoryDiagnosticCommand(command, { endpoint: "fixture:never-connect", stateDirectory: "/fixture/not-created" }, async options => {
      calls++; seen = options; return original;
    });
    assert.equal(calls, 1); assert.strictEqual(result, original); assert.equal(result.overall, "not_ready");
    assert.deepEqual(seen, { endpoint: "fixture:never-connect", stateDirectory: "/fixture/not-created", includeObservationContext: include });
    assert.equal("safe_context" in result.checks[2]!, include);
    assert.equal(result.checks[2]!.reason, "auth_required");
  }
});

test("flag accepts no value, requires json, and cannot be used on another command", () => {
  const invalid = [values([]), values([["include-observation-context", true]]), values([["json", ["true"]]]),
    values([["json", true], ["include-observation-context", ["true"]]]),
    values([["json", true], ["include-observation-context", ["false"]]]),
    values([["json", true], ["include-observation-context", ["private-sentinel"]]]),
    values([["json", true], ["unknown-private-key", true]])];
  for (const input of invalid) assert.throws(() => readFactoryDiagnosticCommandOptions("factory-diagnostics", input), usage);
  for (const command of ["models", "doctor", "--version", undefined]) {
    assert.throws(() => readFactoryDiagnosticCommandOptions(command, values([["include-observation-context", true]])), usage);
    assert.equal(readFactoryDiagnosticCommandOptions(command, values([])), undefined);
  }
});

test("the explicit invocation forwards a failed diagnostic once with no fallback or retry", async () => {
  let calls = 0; const original = new Error("fixture-diagnostic-failed");
  await assert.rejects(runFactoryDiagnosticCommand({ includeObservationContext: true }, {}, async () => { calls++; throw original; }), error => error === original);
  assert.equal(calls, 1);
});
