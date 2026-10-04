import assert from "node:assert/strict";
import test from "node:test";
import type { CdpClient } from "../src/cdp.js";
import { evaluateByValue } from "../src/runtime-evaluate.js";

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

test("Other CDP exceptions keep RUNTIME_DRIFT and never expose private exception content", async () => {
  for (const description of ["Error: private fixture", "Error: AUTH_REQUIRED:native_runtime_logged_out_suffix", "Error: another AUTH_REQUIRED:native_runtime_logged_out"]) {
    await assert.rejects(evaluateByValue(client(description), "fixture"), (error: unknown) => {
      assert.equal((error as { code: string }).code, "RUNTIME_DRIFT");
      assert.doesNotMatch(String(error), /private fixture|native_runtime_logged_out/u);
      return true;
    });
  }
});
