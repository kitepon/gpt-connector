import assert from "node:assert/strict";
import test from "node:test";

import { factoryDiagnostics, factoryDiagnosticsSchema } from "../src/factory-diagnostics.js";
import { ConnectorError } from "../src/errors.js";

test("factory diagnosticsはChrome未起動（CDP接続不能）をidleとしてunverifiedにし、故障扱いしない", async () => {
  // 専用Chromeはon-demand起動の設計。起動していないのは平常状態（idle）であり、
  // not_ready（故障）へ丸めない（オーナー裁定 2026-08-10: 問題ない状態をfailに見せない）。
  const result = await factoryDiagnostics({ endpoint: "http://127.0.0.1:1", platform: "darwin" });
  assert.equal(result.schema, factoryDiagnosticsSchema);
  assert.equal(result.overall, "unverified");
  assert.deepEqual(result.checks.map((check) => check.id), ["version", "state_schema", "job_schema", "migration", "cdp", "official_origin", "auth", "runtime_bridge", "mcp_contract"]);
  assert.deepEqual(result.checks.find((check) => check.id === "cdp"), { id: "cdp", status: "unverified", reason: "chrome_idle" });
  assert.equal(result.checks.find((check) => check.id === "runtime_bridge")?.status, "unverified");
});

test("factory diagnosticsはChrome起動中のCDP異常（HTTP error）をnot_readyのまま返す", async () => {
  // 接続はできるがtarget一覧が壊れている＝本物の異常。idleと混同しない。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("broken", { status: 500 })) as typeof fetch;
  try {
    const result = await factoryDiagnostics({ endpoint: "http://127.0.0.1:1", platform: "darwin" });
    assert.equal(result.overall, "not_ready");
    assert.deepEqual(result.checks.find((check) => check.id === "cdp"), { id: "cdp", status: "not_ready", reason: "cdp_unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("factory diagnosticsはlive browser非対応hostをCDP不備でなくunsupportedにする", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const result = await factoryDiagnostics({ endpoint: "https://example.com", platform });
    assert.equal(result.overall, "unsupported");
    assert.deepEqual(result.checks.map((check) => check.id), ["version", "state_schema", "job_schema", "migration", "cdp", "official_origin", "auth", "runtime_bridge", "mcp_contract"]);
    assert.equal(result.checks.find((check) => check.id === "cdp")?.status, "unsupported");
    assert.equal(result.checks.find((check) => check.id === "runtime_bridge")?.reason, "live_connector_host_unsupported");
  }
});

test("factory diagnosticsは不正なuser endpointを通常入力拒否しbugへ分類しない", async () => {
  await assert.rejects(
    factoryDiagnostics({ endpoint: "https://example.com", platform: "darwin" }),
    (error) => error instanceof ConnectorError && error.code === "INVALID_INPUT",
  );
});
