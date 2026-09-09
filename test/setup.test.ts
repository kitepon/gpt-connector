import assert from "node:assert/strict";
import test from "node:test";
import { prepareBrowser, setup } from "../src/setup.js";
import { ConnectorError } from "../src/errors.js";
import type { ConnectorDiagnostics } from "../src/contract.js";
import { setupClients, type SetupClient, type SetupServer } from "../src/setup-registration.js";

function diagnosis(reasonCode: ConnectorDiagnostics["reasonCode"]): ConnectorDiagnostics {
  return { overall: reasonCode === "ready" ? "ready" : "not_ready", reasonCode } as ConnectorDiagnostics;
}

test("readyならbrowser起動・表示を繰り返さない", async () => {
  const result = await prepareBrowser({ doctor: async () => diagnosis("ready"), startBrowser: async () => { throw new Error("unexpected start"); }, showBrowser: async () => { throw new Error("unexpected show"); } });
  assert.equal(result.status, "ready");
});

test("初回は既存startBrowserを呼び、起動後を再診断する", async () => {
  let probes = 0;
  let starts = 0;
  const result = await prepareBrowser({ doctor: async () => diagnosis(++probes === 1 ? "cdp_unavailable" : "ready"), startBrowser: async () => { starts++; return { ok: true, status: "started", endpoint: "http://127.0.0.1:9223" }; }, showBrowser: async () => { throw new Error("unexpected show"); } });
  assert.equal(starts, 1);
  assert.equal(probes, 2);
  assert.equal(result.status, "ready");
});

test("手動ログイン待ちは成功にせず、再実行で続行できる", async () => {
  let loggedIn = false;
  let shown = 0;
  const deps = { doctor: async () => diagnosis(loggedIn ? "ready" : "auth_required"), startBrowser: async () => { throw new Error("unexpected start"); }, showBrowser: async () => { shown++; return { ok: true as const, status: "shown" as const, endpoint: "http://127.0.0.1:9223" as const }; } };
  assert.equal((await prepareBrowser(deps)).status, "action_required");
  assert.equal(shown, 1);
  loggedIn = true;
  assert.equal((await prepareBrowser(deps)).status, "ready");
  assert.equal(shown, 1);
});

test("準備失敗・表示失敗・runtime driftを成功にしない", async () => {
  await assert.rejects(prepareBrowser({ doctor: async () => diagnosis("cdp_unavailable"), startBrowser: async () => { throw new ConnectorError("RUNTIME_DRIFT", "fixture"); }, showBrowser: async () => { throw new Error("unexpected show"); } }), { code: "RUNTIME_DRIFT" });
  await assert.rejects(prepareBrowser({ doctor: async () => diagnosis("auth_required"), startBrowser: async () => { throw new Error("unexpected start"); }, showBrowser: async () => { throw new Error("show failed"); } }), /show failed/);
  assert.equal((await prepareBrowser({ doctor: async () => diagnosis("runtime_drift"), startBrowser: async () => { throw new Error("unexpected start"); }, showBrowser: async () => { throw new Error("unexpected show"); } })).status, "failed");
});

function setupPorts(platform: NodeJS.Platform) {
  const server: SetupServer = { command: "gpt-connector-mcp", args: [], env: {} };
  const record = (client: SetupClient, path: string) => ({ client, path, backup: null, status: "registered", server });
  return {
    platform,
    register: async (client: SetupClient, _command: string, _args: string[], path: string) => record(client, path),
    read: async (client: SetupClient, path?: string) => record(client, path ?? "fixture"),
    state: async () => "ready",
    verify: async () => ({ status: "ready", tools: ["diagnostics", "sessions"], diagnostics: "responded" }),
    browser: async () => ({ status: "ready", reason: "ready" as const }),
  };
}

for (const platform of ["win32", "linux"] as const) {
  test(`${platform}: live未対応でも4AI登録・MCP・stateを実行する`, async () => {
    const deps = setupPorts(platform);
    deps.browser = async () => { throw new Error("非Macでbrowserを起動しました"); };
    const result = await setup({}, deps);
    assert.equal(result.overall, "partial");
    assert.deepEqual(result.registrations.map((item) => item.client), setupClients);
    for (const item of result.registrations) {
      assert.equal(item.stateRead, "ready");
      assert.deepEqual(item.live, { status: "unsupported", reason: "live_browser_requires_macos" });
      assert.equal(item.failure, undefined);
    }
  });
}

test("登録失敗は他AIの結果と分離し、全体を失敗にする", async () => {
  const deps = setupPorts("linux");
  const register = deps.register;
  deps.register = async (...args) => {
    if (args[0] === "codex") throw new Error("secret fixture in parser error");
    return register(...args);
  };
  const result = await setup({}, deps);
  assert.equal(result.overall, "failed");
  assert.equal(result.registrations.length, 4);
  assert.deepEqual(result.registrations[1]!.failure, { stage: "registration", code: "SETUP_REGISTRATION_FAILED" });
  assert.doesNotMatch(JSON.stringify(result), /secret fixture/u);
});

test("checkは登録処理を実行せず、指定したCodex project設定を診断する", async () => {
  const deps = setupPorts("darwin");
  deps.register = async () => { throw new Error("checkで書込みしました"); };
  const result = await setup({ clients: ["codex"], codexConfig: "/project/.codex/config.toml", check: true }, deps);
  assert.equal(result.overall, "ready");
  assert.equal(result.registrations[0]!.path, "/project/.codex/config.toml");
});

test("利用者の無効化は維持し、MCPを起動して成功扱いしない", async () => {
  const deps = setupPorts("darwin");
  const register = deps.register;
  deps.register = async (...args) => {
    const value = await register(...args);
    value.server.enabled = false;
    return value;
  };
  deps.verify = async () => { throw new Error("無効化したserverを起動しました"); };
  const result = await setup({ clients: ["codex"] }, deps);
  assert.equal(result.overall, "action_required");
  assert.equal(result.registrations[0]!.clientActivation, "disabled_by_user");
  assert.equal(result.registrations[0]!.failure, undefined);
});
