import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { bridgeBuildId } from "../src/page-bridge.js";
import { packageVersion } from "../src/version.js";

function runTool(name: "diagnostics" | "chatgpt_models") {
  const root = mkdtempSync(join(tmpdir(), "gpt-connector-mcp-diagnostics-"));
  const config = join(root, "config", "dotagents", "factory-reporter.json");
  const store = join(root, "state", "gpt-connector", "runtime-errors.json");
  mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  writeFileSync(config, JSON.stringify({
    schema_version: "1.0",
    host: { id: "mcp-diagnostics-test", profile: "wsl" },
    collection: { enabled: true },
    reporting: { enabled: false },
  }), { mode: 0o600 });

  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/mcp.ts")], {
    encoding: "utf8",
    input: `${input}\n`,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      GPT_CONNECTOR_CDP_ENDPOINT: "http://127.0.0.1:1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const response = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
    id?: number;
    result?: { isError?: boolean; content: Array<{ text: string }> };
  }).find((entry) => entry.id === 2);
  assert.ok(response?.result);
  return { response: response.result, store };
}

test("MCP diagnosticsはCDP未接続を正常なread-only結果にし、runtime errorを記録しない", () => {
  const result = runTool("diagnostics");
  assert.equal(result.response.isError, undefined);
  assert.deepEqual(JSON.parse(result.response.content[0]!.text), {
    schema: "gpt-connector.diagnostics.v1",
    packageVersion,
    overall: "not_ready",
    reasonCode: "cdp_unavailable",
    cdpConnected: false,
    officialOrigin: null,
    authenticated: null,
    bridgeBuildId,
    sessionCount: null,
    operationCount: null,
    uploadCount: null,
    bufferedUploadBytes: null,
    downloadCount: null,
    bufferedDownloadBytes: null,
    jobCount: null,
    activeJobCount: null,
    terminalJobCount: null,
  });
  assert.throws(() => statSync(result.store), { code: "ENOENT" });
});

test("実操作のCDP接続失敗は従来どおりruntime errorを記録する", () => {
  const result = runTool("chatgpt_models");
  assert.equal(result.response.isError, true);
  const store = JSON.parse(readFileSync(result.store, "utf8")) as {
    records: Array<{ error_code: string; status: string; severity: string }>;
  };
  assert.deepEqual(store.records.map(({ error_code, status, severity }) => ({ error_code, status, severity })), [
    { error_code: "CDP_UNAVAILABLE", status: "open", severity: "high" },
  ]);
});
