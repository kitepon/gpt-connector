import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { showBrowser, startBrowser } from "../src/browser-launcher.js";
import { discoverProviderTarget } from "../src/cdp.js";
import { ConnectorError } from "../src/errors.js";
import { assessRuntimeFailure, runtimeFailureDecision } from "../src/runtime-error-assessment.js";

async function fixture(work: (base: Parameters<typeof startBrowser>[0]) => Promise<void>) {
  const root = resolve("../../artifacts/2026-10-25-windows-interactive-launch/reporting-fixtures"); await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, "case-")), profile = join(home, ".gpt-connector/browser-profile");
  const command = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --user-data-dir=${profile}`;
  try { await work({ platform: "darwin", home, endpointReady: async () => true, processInspector: async () => [{ pid: "42", command }],
    existingTargetAbsent: async () => false, windowPreparer: async () => "ready", windowShower: async () => "normal", processHider: async () => {},
    processRevealer: async () => {}, processActivator: async () => {}, windowVisibilityVerifier: async () => {} }); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test("browser show preserves the real targetMissing observation through the wrapper without reporting an unknown CDP defect", async () => {
  for (const provider of ["chatgpt", "grok"] as const) await fixture(async base => {
    let reveals = 0;
    await assert.rejects(showBrowser({ ...base, provider, windowShower: async () => {
      await discoverProviderTarget("http://127.0.0.1:9223", provider, async () => new Response(JSON.stringify([{ id: "background", type: "service_worker", url: "chrome-extension://synthetic", webSocketDebuggerUrl: "ws://127.0.0.1:9223/synthetic" }])));
      return "normal";
    }, processRevealer: async () => { reveals++; } }), error => {
      assert.ok(error instanceof ConnectorError); assert.equal(error.code, "CDP_UNAVAILABLE"); assert.equal(error.details?.targetMissing, true);
      assert.equal(error.message.includes(" --provider grok"), provider === "grok");
      assert.deepEqual(runtimeFailureDecision(assessRuntimeFailure(error)), { register: false, severity: "info" });
      return true;
    });
    assert.equal(reveals, 0); // Operation stays failed; no display or health success is invented.
  });
});

test("failure to restore an authentication window remains a browser failure, not an AUTH_REQUIRED success path", async () => {
  await fixture(async base => {
    await assert.rejects(startBrowser({ ...base, appReady: async () => { throw new ConnectorError("AUTH_REQUIRED", "login needed"); },
      processRevealer: async () => { throw new Error("synthetic-secret-that-must-not-leak"); } }), error => {
      assert.ok(error instanceof ConnectorError); assert.equal(error.code, "CDP_UNAVAILABLE"); assert.ok(!error.message.includes("synthetic-secret"));
      assert.deepEqual(runtimeFailureDecision(assessRuntimeFailure(error)), { register: true, severity: "high" }); return true;
    });
  });
});

test("when the owned authentication window really becomes visible the original AUTH_REQUIRED result is retained", async () => {
  await fixture(async base => {
    let visible = false;
    await assert.rejects(startBrowser({ ...base, appReady: async () => { throw new ConnectorError("AUTH_REQUIRED", "login needed"); },
      windowVisibilityVerifier: async (_pid, requested) => { if (requested) visible = true; } }), error => {
      assert.ok(error instanceof ConnectorError); assert.equal(error.code, "AUTH_REQUIRED"); assert.equal(visible, true);
      assert.deepEqual(runtimeFailureDecision(assessRuntimeFailure(error)), { register: false, severity: "info" }); return true;
    });
  });
});
