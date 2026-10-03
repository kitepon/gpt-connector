import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("factory diagnosticsは起動中ChromeでChatGPT tabが閉じられているだけならidleとしてunverifiedにする", async () => {
  // MCP/CLIの次の利用でtabを準備し直せるため、Chrome未起動と同じく故障扱いしない。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([
    { id: "a", type: "page", url: "http://192.168.1.2:39310/", webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/a" },
  ])) as typeof fetch;
  try {
    const result = await factoryDiagnostics({ endpoint: "http://127.0.0.1:1", platform: "darwin" });
    assert.equal(result.overall, "unverified");
    assert.deepEqual(result.checks.find((check) => check.id === "cdp"), { id: "cdp", status: "unverified", reason: "chatgpt_tab_idle" });
    assert.equal(result.checks.find((check) => check.id === "auth")?.reason, "cdp_not_inspected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("factory diagnosticsはChatGPT tabの重複をnot_readyのまま返す", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(["a", "b"].map((id) => (
    { id, type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: `ws://127.0.0.1:9223/devtools/page/${id}` }
  )))) as typeof fetch;
  try {
    const result = await factoryDiagnostics({ endpoint: "http://127.0.0.1:1", platform: "darwin" });
    assert.equal(result.overall, "not_ready");
    assert.deepEqual(result.checks.find((check) => check.id === "cdp"), { id: "cdp", status: "not_ready", reason: "cdp_unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("factory diagnosticsはlive browser非対応hostをCDP不備でなくunsupportedにする", async () => {
  for (const platform of ["freebsd"] as const) {
    const result = await factoryDiagnostics({ endpoint: "https://example.com", platform });
    assert.equal(result.overall, "unsupported");
    assert.deepEqual(result.checks.map((check) => check.id), ["version", "state_schema", "job_schema", "migration", "cdp", "official_origin", "auth", "runtime_bridge", "mcp_contract"]);
    assert.equal(result.checks.find((check) => check.id === "cdp")?.status, "unsupported");
    assert.equal(result.checks.find((check) => check.id === "runtime_bridge")?.reason, "live_connector_host_unsupported");
  }
});

test("factory diagnosticsはLinuxの未起動Chromeをidleとしてunverifiedにする", async () => {
  const result = await factoryDiagnostics({ endpoint: "http://127.0.0.1:1", platform: "linux" });
  assert.equal(result.overall, "unverified");
  assert.deepEqual(result.checks.find((check) => check.id === "cdp"), { id: "cdp", status: "unverified", reason: "chrome_idle" });
});

test("factory diagnosticsは不正なuser endpointを通常入力拒否しbugへ分類しない", async () => {
  await assert.rejects(
    factoryDiagnostics({ endpoint: "https://example.com", platform: "darwin" }),
    (error) => error instanceof ConnectorError && error.code === "INVALID_INPUT",
  );
});

test("factory diagnosticsはstateを読めた時にmigrationをcurrent、読めない時にunverifiedで返す", async () => {
  // 工場reporterはstate.migrationのcurrent／failedだけを写し、他の値はunverifiedにする。
  // 固定のnoneを返していた間、migration checkがreadyでも工場ではunverifiedに見えていた。
  const readable = await factoryDiagnostics({ endpoint: "http://127.0.0.1:1", platform: "linux", stateDirectory: mkdtempSync(join(tmpdir(), "gpt-connector-factory-state-")) });
  assert.equal(readable.checks.find((check) => check.id === "migration")?.status, "ready");
  assert.deepEqual([readable.state.migration, readable.job.migration], ["current", "current"]);

  const blocked = join(mkdtempSync(join(tmpdir(), "gpt-connector-factory-state-")), "not-a-directory");
  writeFileSync(blocked, "x");
  const unreadable = await factoryDiagnostics({ endpoint: "http://127.0.0.1:1", platform: "linux", stateDirectory: blocked });
  assert.deepEqual(unreadable.checks.find((check) => check.id === "migration"), { id: "migration", status: "not_ready", reason: "state_unavailable" });
  assert.deepEqual([unreadable.state.migration, unreadable.job.migration], ["unverified", "unverified"]);
});
