import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorDiagnostics } from "../src/contract.js";
import { doctorWithAuthRecovery } from "../src/doctor.js";
import { packageVersion } from "../src/version.js";

function diagnostics(reasonCode: ConnectorDiagnostics["reasonCode"]): ConnectorDiagnostics {
  return {
    schema: "gpt-connector.diagnostics.v1",
    packageVersion,
    overall: reasonCode === "ready" ? "ready" : "not_ready",
    reasonCode,
    cdpConnected: reasonCode !== "cdp_unavailable",
    officialOrigin: reasonCode === "ready" ? true : null,
    authenticated: reasonCode === "ready" ? true : reasonCode === "auth_required" ? false : null,
    bridgeBuildId: "test",
    sessionCount: null,
    operationCount: null,
    uploadCount: null,
    bufferedUploadBytes: null,
    downloadCount: null,
    bufferedDownloadBytes: null,
    jobCount: null,
    activeJobCount: null,
    terminalJobCount: null,
  };
}

test("doctorはauth_requiredを返す前に専用Chromeを表示する", async () => {
  const events: string[] = [];
  const expected = diagnostics("auth_required");
  const result = await doctorWithAuthRecovery({}, {
    diagnose: async () => { events.push("diagnose"); return expected; },
    show: async () => {
      events.push("show");
      return { ok: true, status: "shown", endpoint: "http://127.0.0.1:9223" };
    },
  });
  assert.equal(result, expected);
  assert.deepEqual(events, ["diagnose", "show"]);
});

test("doctorはreadyなら専用Chromeの表示状態を変えない", async () => {
  let showCount = 0;
  const expected = diagnostics("ready");
  const result = await doctorWithAuthRecovery({}, {
    diagnose: async () => expected,
    show: async () => {
      showCount += 1;
      return { ok: true, status: "shown", endpoint: "http://127.0.0.1:9223" };
    },
  });
  assert.equal(result, expected);
  assert.equal(showCount, 0);
});
