import assert from "node:assert/strict";
import test from "node:test";
import { prepareBrowser, setup, setupRuntimeDriftOptions, verifyMcp } from "../src/setup.js";
import { ConnectorError } from "../src/errors.js";
import type { ConnectorDiagnostics } from "../src/contract.js";
import { setupClients, type SetupClient, type SetupServer } from "../src/setup-registration.js";
import type { configureCodexSteer } from "../src/setup-codex-steer.js";
import type { configureCursorHooks } from "../src/setup-cursor-hooks.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GptConnector } from "../src/connector.js";
import { mergeRegistration, readRegistration, registerClient, registrationPath } from "../src/setup-registration.js";
import { defaultFactoryReporterConfigPath, defaultRuntimeErrorStorePath, readRuntimeErrorSnapshot, recordRuntimeErrorBestEffort } from "../src/runtime-error-store.js";
import { readRuntimeErrorEvents } from "../src/runtime-error-events.js";
import { evaluateByValue } from "../src/runtime-evaluate.js";
import type { CdpClient } from "../src/cdp.js";

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

test("この端末でbrowserを準備できないだけの状態は、失敗にせず理由を返す", async () => {
  const unavailable = (details: Record<string, boolean>) => prepareBrowser({ doctor: async () => diagnosis("cdp_unavailable"),
    startBrowser: async () => { throw new ConnectorError(details.portConflict ? "RUNTIME_DRIFT" : "CDP_UNAVAILABLE", "fixture", details); },
    showBrowser: async () => { throw new Error("unexpected show"); } });
  // 9223が他端末のChromeへのSSH転送で、転送先にChatGPT tabが無い時。
  const external = await unavailable({ portConflict: true });
  assert.equal(external.status, "external");
  assert.equal(external.reason, "cdp_endpoint_not_owned");
  // ChromeかX11の無いLinux server。
  assert.deepEqual(await unavailable({ hostUnsupported: true }), { status: "unsupported", reason: "live_browser_host_unsupported" });
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
    steer: (async () => ({ status: "ready" })) as typeof configureCodexSteer,
    cursorHooks: (() => ({ status: "ready", path: "fixture-hooks.json", changed: false })) as typeof configureCursorHooks,
  };
}

test("明示した起動先修理はMCP受入だけを行いstate/browser/hookを操作しない", async () => {
  const deps = setupPorts("linux");
  let verified = 0;
  const result = await setup({ repairLaunch: true, clients: ["claude"] }, {
    ...deps,
    register: async (client, command, args, path, repairLaunch) => {
      assert.equal(repairLaunch, true);
      return deps.register(client, command, args, path);
    },
    state: async () => { throw new Error("unexpected state"); },
    browser: async () => { throw new Error("unexpected browser"); },
    steer: async () => { throw new Error("unexpected steer"); },
    cursorHooks: () => { throw new Error("unexpected hooks"); },
    verify: async (_command, _args, _env, _cwd, diagnostics) => {
      assert.equal(diagnostics, false); verified++;
      return { status: "ready", tools: ["diagnostics", "sessions"], diagnostics: "not_checked" };
    },
  });
  assert.equal(verified, 1);
  assert.equal(result.overall, "ready");
  assert.equal(result.mode, "repair_launch");
  assert.equal(result.live.status, "not_checked");
  assert.equal(result.registrations[0]!.stateRead, undefined);
  await assert.rejects(setup({ check: true, repairLaunch: true }, deps), /併用/u);
});

test("起動先修理の通常MCP受入は製品childを終了しdiagnosticsを実行しない", async () => {
  const result = await verifyMcp(process.execPath, ["--import", "tsx", "src/mcp.ts"], {}, undefined, false);
  assert.equal(result.status, "ready");
  assert.equal(result.diagnostics, "not_checked");
  assert.equal(result.tools.length, 13);
});

test("Linux: 4AIの登録から共通のlive準備へ進み、Codex Steerも導入する", async () => {
  const deps = setupPorts("linux");
  let browserCalls = 0;
  let steerCalls = 0;
  deps.browser = async () => { browserCalls++; return { status: "ready", reason: "ready" }; };
  deps.steer = (async () => { steerCalls++; return { status: "ready" }; }) as typeof configureCodexSteer;
  const result = await setup({}, deps);
  assert.equal(result.overall, "ready");
  assert.equal(result.live.supported, true);
  assert.equal(browserCalls, 1);
  assert.equal(steerCalls, 1);
  assert.deepEqual(result.registrations.map((item) => item.client), setupClients);
  assert.ok(result.registrations.every((item) => (item.live as { status: string }).status === "ready"));
});

test("live未対応のOSは登録とMCPを実行し、liveを未対応のままpartialにする", async () => {
  const deps = setupPorts("freebsd");
  deps.browser = async () => { throw new Error("未対応OSでbrowserを起動しました"); };
  const result = await setup({}, deps);
  assert.equal(result.overall, "partial");
  assert.equal(result.live.supported, false);
  assert.deepEqual(result.registrations.map((item) => item.client), setupClients);
  for (const item of result.registrations) {
    assert.equal(item.stateRead, "ready");
    assert.deepEqual(item.live, { status: "unsupported", reason: "live_browser_host_unsupported" });
    assert.equal(item.failure, undefined);
  }
});

test("browserを準備できない端末は、登録とMCPの確認を終えてpartialにする", async () => {
  for (const live of [{ status: "external", reason: "cdp_endpoint_not_owned" }, { status: "unsupported", reason: "live_browser_host_unsupported" }]) {
    const deps = { ...setupPorts("linux"), browser: async () => live };
    const result = await setup({}, deps as unknown as Parameters<typeof setup>[1]);
    assert.equal(result.overall, "partial");
    assert.equal(result.live.supported, true);
    for (const item of result.registrations) {
      assert.deepEqual(item.live, live);
      assert.equal(item.failure, undefined);
    }
  }
  // 手動対応が要る時は、partialより先にaction_requiredを返す。
  const deps = { ...setupPorts("linux"), browser: async () => ({ status: "external", reason: "cdp_endpoint_not_owned" }),
    steer: (async () => ({ status: "restart_required", reason_code: "codex_restart_required" })) as typeof configureCodexSteer };
  assert.equal((await setup({}, deps as unknown as Parameters<typeof setup>[1])).overall, "action_required");
});

test("Windows: 4AIの登録から共通のlive準備へ進み、readyを確認する", async () => {
  const deps = setupPorts("win32");
  let browserCalls = 0;
  deps.browser = async () => { browserCalls++; return { status: "ready", reason: "ready" }; };
  const result = await setup({}, deps);
  assert.equal(result.overall, "ready");
  assert.equal(result.live.supported, true);
  assert.equal(browserCalls, 1);
  assert.ok(result.registrations.every(item => (item.live as { status: string }).status === "ready"));
});

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

test("setup records one runtime drift for shared browser failures, while check stays read-only", async () => {
  let reports = 0;
  let browsers = 0;
  const deps = { ...setupPorts("darwin"), reportRuntimeDrift: async () => { reports++; },
    browser: async () => {
      if (++browsers === 1) throw new ConnectorError("RUNTIME_DRIFT", "private fixture");
      return { status: "failed", reason: "runtime_drift" as const };
    } };
  const result = await setup({}, deps);
  assert.equal(result.overall, "failed");
  assert.equal(reports, 1);
  assert.doesNotMatch(JSON.stringify(result), /private fixture/u);
  browsers = 0;
  await setup({ check: true }, deps);
  assert.equal(reports, 1);
});

test("thrown first probe and cached later drift retain both stages in one occurrence without changing setup JSON", async () => {
  let calls = 0;
  const reports: Parameters<typeof setupRuntimeDriftOptions>[0][] = [];
  const result = await setup({}, { ...setupPorts("win32"),
    browser: async () => {
      if (++calls === 1) throw new ConnectorError("RUNTIME_DRIFT", "private-token", { runtimeStage: "bridge_bootstrap", runtimeTag: "sender" });
      return { status: "failed", reason: "runtime_drift", runtimeFailure: { stage: "runtime_discovery", tag: "rspack_runtime" } };
    },
    reportRuntimeDrift: async failures => { reports.push(failures); },
  });
  assert.equal(result.overall, "failed");
  assert.equal(calls, 2);
  assert.deepEqual(result.registrations[0]!.failure, { stage: "browser", code: "RUNTIME_DRIFT" });
  assert.deepEqual(result.registrations[1]!.live, { status: "failed", reason: "runtime_drift" });
  assert.deepEqual(reports, [[{ stage: "bridge_bootstrap", tag: "sender" }, { stage: "runtime_discovery", tag: "rspack_runtime" }]]);
  assert.doesNotMatch(JSON.stringify(result), /private-token|runtimeFailure|rspack_runtime|sender/u);
});

test("doctor keeps its public schema and failure result even if the diagnostic observer throws", async () => {
  const connect = GptConnector.connect;
  try {
    GptConnector.connect = async () => { throw new ConnectorError("RUNTIME_DRIFT", "private-token", { runtimeStage: "bridge_bootstrap", runtimeTag: "sender" }); };
    const result = await GptConnector.doctor({}, failure => {
      assert.deepEqual(failure, { stage: "bridge_bootstrap", tag: "sender" });
      throw new Error("observer private-token");
    });
    assert.equal(result.overall, "not_ready");
    assert.equal(result.reasonCode, "runtime_drift");
    assert.doesNotMatch(JSON.stringify(result), /private-token|runtimeFailure|sender|context/u);
  } finally { GptConnector.connect = connect; }
});

for (const platform of ["darwin", "linux", "win32"] as const) {
  for (const client of setupClients) {
    test(`diagnostic fixture ${platform}/${client}: actual config merge, doctor, events, check and disabled preservation`, async () => {
      const root = mkdtempSync(join(tmpdir(), "gpt-connector-setup-drift-"));
      const env = { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
      const configPath = defaultFactoryReporterConfigPath(env);
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      writeFileSync(configPath, JSON.stringify({ schema_version: "1.0", host: { id: "fixture", profile: "linux" }, collection: { enabled: true }, reporting: { enabled: false } }), { mode: 0o600 });
      const path = registrationPath(client, root, {});
      const connect = GptConnector.connect;
      let reports = 0;
      try {
        // No Chrome/CDP connection: only this in-memory error response crosses the real evaluation path.
        GptConnector.connect = async () => {
          await evaluateByValue({ call: async () => ({ exceptionDetails: { exception: { description: "Error: RUNTIME_DRIFT:rspack_runtime:0\nprivate-token" } } }) } as unknown as CdpClient, "fixture", true, "runtime_discovery");
          throw new Error("unreachable");
        };
        const deps = {
          ...setupPorts(platform),
          register: (c: SetupClient) => registerClient(c, "fixture-mcp", [], path, join(root, "backups")),
          read: (c: SetupClient) => readRegistration(c, path),
          browser: (_env: Record<string, string>, check: boolean) => prepareBrowser(undefined, undefined, check),
          reportRuntimeDrift: async (failures: Parameters<typeof setupRuntimeDriftOptions>[0]) => {
            reports++;
            assert.equal(recordRuntimeErrorBestEffort("RUNTIME_DRIFT", { ...setupRuntimeDriftOptions(failures), env }), "recorded");
          },
        };
        const result = await setup({ clients: [client] }, deps);
        assert.equal(result.overall, "failed");
        assert.equal(reports, 1);
        assert.deepEqual(result.registrations[0]!.live, { status: "failed", reason: "runtime_drift" });
        const events = readRuntimeErrorEvents({ env });
        assert.deepEqual(events[0]!.assessment, { cause: "unknown", impact: "operation_failed", handling: "unknown", recovery: "unknown", cancelled: false });
        assert.deepEqual(events[0]!.context, { source: "setup_live_check", failures: [{ stage: "runtime_discovery", tag: "rspack_runtime" }] });
        assert.deepEqual(events[0]!.decision, { register: true, severity: "high" });
        const storePath = defaultRuntimeErrorStorePath(env);
        const store = readFileSync(storePath, "utf8");
        const eventBytes = readFileSync(`${storePath}.events.v2`, "utf8");
        assert.doesNotMatch(eventBytes, /private-token/u);
        assert.equal(readRuntimeErrorSnapshot({ env }).runtime_errors[0]!.occurrence_count, 1);
        assert.doesNotMatch(store, /setup_live_check|rspack_runtime|context/u);
        const config = readFileSync(path, "utf8");
        await setup({ clients: [client], check: true }, deps);
        assert.equal(reports, 1);
        assert.equal(readFileSync(path, "utf8"), config);
        assert.equal(readFileSync(storePath, "utf8"), store);
        assert.equal(readFileSync(`${storePath}.events.v2`, "utf8"), eventBytes);
        // A complete existing disabled registration must not be re-enabled or probed.
        const source = client === "codex" || client === "grok"
          ? '[mcp_servers.gpt_connector]\ncommand="fixture-mcp"\nenabled=false\n'
          : JSON.stringify({ mcpServers: { gpt_connector: { command: "fixture-mcp", disabled: true } } });
        writeFileSync(path, mergeRegistration(source, client, "fixture-mcp", []).text, { mode: 0o600 });
        const disabledConfig = readFileSync(path, "utf8");
        const disabled = await setup({ clients: [client] }, { ...deps,
          verify: async () => { throw new Error("disabled MCP was started"); },
          browser: async () => { throw new Error("disabled browser was probed"); },
        });
        assert.equal(disabled.overall, "action_required");
        assert.equal(disabled.registrations[0]!.clientActivation, "disabled_by_user");
        assert.equal(disabled.registrations[0]!.mcp, "not_checked");
        assert.equal(disabled.registrations[0]!.live, undefined);
        assert.equal(disabled.registrations[0]!.failure, undefined);
        assert.equal(readFileSync(path, "utf8"), disabledConfig);
        assert.equal(readFileSync(storePath, "utf8"), store);
        assert.equal(reports, 1);
      } finally {
        GptConnector.connect = connect;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
