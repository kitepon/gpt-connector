import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GptConnector } from "./connector.js";
import { ConsultJobStore } from "./consult-job-store.js";
import { startBrowser, showBrowser } from "./browser-launcher.js";
import { ConnectorError } from "./errors.js";
import { packageVersion } from "./version.js";
import { registerClient, readRegistration, registrationPath, setupClients, setupTools, type SetupClient, type SetupServer } from "./setup-registration.js";
import { setupLaunchDefaults } from "./platform/setup-package.js";

export async function verifyMcp(command: string, args: string[], env: Record<string, string>, cwd?: string) {
  const client = new Client({ name: "gpt-connector-setup", version: packageVersion });
  const transport = new StdioClientTransport({ command, args, cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)), ...env }, stderr: "pipe" });
  let stderrBytes = 0;
  transport.stderr?.on("data", (data: Buffer) => { stderrBytes += data.length; });
  try {
    await client.connect(transport);
    if (client.getServerVersion()?.version !== packageVersion) throw new Error("MCP起動版がsetupの版と一致しません。");
    const { tools } = await client.listTools();
    if (tools.length !== setupTools.length || setupTools.some((name) => !tools.some((tool) => tool.name === name))) throw new Error("MCP公開tool集合が一致しません。");
    const diagnostics = await client.callTool({ name: "diagnostics", arguments: {} });
    if (diagnostics.isError) throw new Error("MCP diagnosticsが失敗しました。");
    if (stderrBytes > 0) throw new Error("MCPがstderrへ診断外の出力を返しました。");
    return { status: "ready", tools: tools.map((tool) => tool.name), diagnostics: "responded" };
  } finally { await client.close(); }
}

function browserDependencies(env: Record<string, string | undefined>) {
  return { doctor: () => GptConnector.doctor({ endpoint: env.GPT_CONNECTOR_CDP_ENDPOINT, stateDirectory: env.GPT_CONNECTOR_STATE_DIR, readOnlyJobs: true }), startBrowser, showBrowser };
}

export async function prepareBrowser(deps = browserDependencies(process.env), endpoint = process.env.GPT_CONNECTOR_CDP_ENDPOINT, check = false) {
  let diagnosis = await deps.doctor();
  if (check) return { status: diagnosis.overall === "ready" ? "ready" : "not_ready", reason: diagnosis.reasonCode };
  if (diagnosis.reasonCode === "cdp_unavailable") {
    if (endpoint && endpoint !== "http://127.0.0.1:9223") throw new Error("指定CDP endpointへ接続できません。既存browser startが所有するendpointは9223だけです。");
    try { await deps.startBrowser(); } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "AUTH_REQUIRED") throw error;
      return { status: "action_required", reason: "auth_required", next: "表示された専用ChromeでChatGPTへログインし、同じsetupコマンドを再実行してください。" };
    }
    diagnosis = await deps.doctor();
  }
  if (diagnosis.reasonCode === "auth_required") {
    if (endpoint && endpoint !== "http://127.0.0.1:9223") throw new Error("指定CDP endpointでログインが必要です。既存browser showが所有するendpointは9223だけです。");
    await deps.showBrowser();
    return { status: "action_required", reason: "auth_required", next: "表示された専用ChromeでChatGPTへログインし、同じsetupコマンドを再実行してください。" };
  }
  return { status: diagnosis.overall === "ready" ? "ready" : "failed", reason: diagnosis.reasonCode };
}

interface SetupOptions {
  clients?: readonly SetupClient[];
  codexConfig?: string;
  check?: boolean;
}

async function inspectState(env: Record<string, string>) {
  const store = new ConsultJobStore({ stateDirectory: env.GPT_CONNECTOR_STATE_DIR ?? process.env.GPT_CONNECTOR_STATE_DIR, readOnly: true });
  try { await store.initialize(); store.diagnostics(); return "ready"; } finally { store.close(); }
}

const setupDependencies = {
  platform: process.platform,
  register: (client: SetupClient, _command: string, _args: string[], path: string) => {
    const defaults = setupLaunchDefaults(client);
    return registerClient(client, defaults.command, [], path, undefined, defaults.env);
  },
  read: readRegistration,
  verify: verifyMcp,
  state: inspectState,
  browser: (env: Record<string, string>, check: boolean) => prepareBrowser(browserDependencies({ ...process.env, ...env }), env.GPT_CONNECTOR_CDP_ENDPOINT ?? process.env.GPT_CONNECTOR_CDP_ENDPOINT, check),
};

export async function setup(options: SetupOptions = {}, deps = setupDependencies) {
  const registrations: Record<string, unknown>[] = [];
  const browsers = new Map<string, Awaited<ReturnType<typeof prepareBrowser>>>();
  let failed = false;
  let actionRequired = false;
  for (const client of options.clients ?? setupClients) {
    const path = client === "codex" && options.codexConfig ? options.codexConfig : registrationPath(client);
    const item: Record<string, unknown> = { client, path };
    registrations.push(item);
    let stage = "registration";
    try {
      const registration = options.check ? await deps.read(client, path) : await deps.register(client, "gpt-connector-mcp", [], path);
      const { server, ...receipt } = registration;
      Object.assign(item, receipt);
      stage = "state";
      item.stateRead = await deps.state(server.env);
      if (server.enabled === false || server.disabled === true) {
        item.clientActivation = "disabled_by_user";
        item.mcp = "not_checked";
        actionRequired = true;
        continue;
      }
      stage = "mcp";
      item.mcp = await deps.verify(server.command, server.args, server.env, typeof server.cwd === "string" ? server.cwd : undefined);
      item.clientActivation = "new_client_session_required";
      item.enabledTools = availableTools(server);
      stage = "browser";
      if (deps.platform === "darwin") {
        const key = JSON.stringify([server.env.GPT_CONNECTOR_CDP_ENDPOINT, server.env.GPT_CONNECTOR_STATE_DIR]);
        if (!browsers.has(key)) browsers.set(key, await deps.browser(server.env, options.check ?? false));
        const live = browsers.get(key)!;
        item.live = live;
        if (live.status === "action_required") actionRequired = true;
        else if (live.status !== "ready") failed = true;
      } else item.live = { status: "unsupported", reason: "live_browser_requires_macos" };
    } catch (error) {
      failed = true;
      // 構文errorや子processの出力は秘密値を含み得るため、段階と公開codeだけを返す。
      item.failure = { stage, code: error instanceof ConnectorError ? error.code : `SETUP_${stage.toUpperCase()}_FAILED` };
    }
  }
  const overall = failed ? "failed" : actionRequired ? "action_required" : deps.platform === "darwin" ? "ready" : "partial";
  return { schema: "gpt-connector.setup.v1", version: packageVersion, overall, package: "ready", registrations, live: { supported: deps.platform === "darwin" }, next: "各AIを新しいセッションで起動し、登録と利用可能なread-only toolを確認してください。" };
}

function availableTools(server: SetupServer) {
  const allowed = Array.isArray(server.enabled_tools) ? server.enabled_tools : setupTools;
  const denied = Array.isArray(server.disabled_tools) ? server.disabled_tools : [];
  return setupTools.filter((tool) => allowed.includes(tool) && !denied.includes(tool));
}
