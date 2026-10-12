import assert from "node:assert/strict";
import test from "node:test";
import type { CdpClient } from "../src/cdp.js";
import { evaluateByValue } from "../src/runtime-evaluate.js";
import { ConnectorError } from "../src/errors.js";

function client(description: string) {
  return { call: async () => ({ exceptionDetails: { exception: { description } } }) } as unknown as CdpClient;
}

test("Our native logged-out tag becomes AUTH_REQUIRED without copying the CDP stack", async () => {
  await assert.rejects(evaluateByValue(client("Error: AUTH_REQUIRED:native_runtime_logged_out\nprivate stack"), "fixture"), (error: unknown) => {
    assert.equal((error as { code: string }).code, "AUTH_REQUIRED");
    assert.doesNotMatch(String(error), /private stack/u);
    return true;
  });
});

test("Runtime tags retain only a fixed role and call-site stage, never counts, stack, or fake suffixes", async () => {
  for (const [stage, description, tag] of [
    ["runtime_discovery", "Error: RUNTIME_DRIFT:rspack_runtime:0\nsecret stack", "rspack_runtime"],
    ["runtime_discovery", "Error: RUNTIME_DRIFT:native_auth:2", "native_auth"],
    ["bridge_bootstrap", "Error: RUNTIME_DRIFT:sender:0\nsecret token", "sender"],
    ["evaluation", "Error: RUNTIME_DRIFT:upload_metadata\nsecret token", "upload_metadata"],
    ["evaluation", "Error: RUNTIME_DRIFT:sender_result", "sender_result"],
    ["evaluation", "Error: RUNTIME_DRIFT:sender:0", "unknown"],
    ["runtime_discovery", "Error: RUNTIME_DRIFT:sender:0", "unknown"],
    ["bridge_bootstrap", "Error: RUNTIME_DRIFT:sender_suffix:0", "unknown"],
    ["bridge_bootstrap", "Error: wrapper RUNTIME_DRIFT:sender:0", "unknown"],
    ["bridge_bootstrap", "Error: RUNTIME_DRIFT:sender:0 secret token", "unknown"],
    ["bridge_bootstrap", "Error: RUNTIME_DRIFT:private_user_content", "unknown"],
  ] as const) {
    await assert.rejects(evaluateByValue(client(description), "fixture", true, stage), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "RUNTIME_DRIFT");
      assert.deepEqual(error.details, { runtimeStage: stage, runtimeTag: tag });
      assert.doesNotMatch(JSON.stringify(error), /secret|private_user_content|sender_suffix|stack/u);
      return true;
    });
  }
});

test("Other CDP exceptions keep RUNTIME_DRIFT and never expose private exception content", async () => {
  for (const description of ["Error: private fixture", "Error: AUTH_REQUIRED:native_runtime_logged_out_suffix", "Error: another AUTH_REQUIRED:native_runtime_logged_out"]) {
    await assert.rejects(evaluateByValue(client(description), "fixture"), (error: unknown) => {
      assert.equal((error as { code: string }).code, "RUNTIME_DRIFT");
      assert.doesNotMatch(String(error), /private fixture|native_runtime_logged_out/u);
      return true;
    });
  }
});
