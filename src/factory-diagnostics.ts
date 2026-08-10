import { CdpClient, discoverChatGptTarget } from "./cdp.js";
import { ConsultJobStore } from "./consult-job-store.js";
import { ConnectorError } from "./errors.js";
import { bridgeBuildId } from "./page-bridge.js";
import { evaluateByValue } from "./runtime-evaluate.js";
import { packageVersion } from "./version.js";

export const factoryDiagnosticsSchema = "gpt-connector.factory-diagnostics.v1" as const;

export interface FactoryDiagnosticsOptions {
  readonly endpoint?: string;
  readonly stateDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

type CheckStatus = "ready" | "not_ready" | "unsupported" | "unverified";
interface FactoryCheck { readonly id: string; readonly status: CheckStatus; readonly reason: string; }
interface RuntimeProbe {
  readonly cdp: FactoryCheck;
  readonly origin: FactoryCheck;
  readonly auth: FactoryCheck;
  readonly bridge: FactoryCheck;
}

/** Read-only product readiness. It never invokes models/chat/consult, upload, archive, or job creation. */
export async function factoryDiagnostics(options: FactoryDiagnosticsOptions = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return factoryResult("unsupported", [
    check("version", "ready", "package_version_available"),
    check("state_schema", "ready", "consult_jobs_json_v1"),
    check("job_schema", "ready", "consult_job_v1"),
    check("migration", "ready", "none"),
    check("cdp", "unsupported", "live_connector_host_unsupported"),
    check("official_origin", "unsupported", "live_connector_host_unsupported"),
    check("auth", "unsupported", "live_connector_host_unsupported"),
    check("runtime_bridge", "unsupported", "live_connector_host_unsupported"),
    check("mcp_contract", "ready", "stdio_contract_v1"),
  ]);

  const state = await inspectState(options.stateDirectory);
  const runtime = await inspectRuntime(options.endpoint ?? "http://127.0.0.1:9223");
  const checks = [
    check("version", "ready", "package_version_available"),
    check("state_schema", state, state === "ready" ? "consult_jobs_json_v1" : "state_unavailable"),
    check("job_schema", state, state === "ready" ? "consult_job_v1" : "state_unavailable"),
    check("migration", state, state === "ready" ? "none" : "state_unavailable"),
    runtime.cdp,
    runtime.origin,
    runtime.auth,
    runtime.bridge,
    check("mcp_contract", "ready", "stdio_contract_v1"),
  ];
  return factoryResult(checks.some((item) => item.status === "not_ready") ? "not_ready"
    : checks.some((item) => item.status === "unverified") ? "unverified" : "ready", checks);
}

async function inspectState(stateDirectory?: string): Promise<"ready" | "not_ready"> {
  const store = new ConsultJobStore({ stateDirectory, readOnly: true });
  try {
    await store.initialize();
    store.diagnostics();
    return "ready";
  } catch {
    return "not_ready";
  } finally {
    store.close();
  }
}

async function inspectRuntime(endpoint: string): Promise<RuntimeProbe> {
  let client: CdpClient | undefined;
  try {
    const target = await discoverChatGptTarget(endpoint);
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.call("Runtime.enable");
    const result = await evaluateByValue<{
      readonly officialOrigin: boolean;
      readonly authenticated: boolean;
      readonly bridgeReady: boolean;
    }>(client, String.raw`(async () => {
      const response = await fetch("/api/auth/session", { credentials: "include" });
      let authenticated = false;
      if (response.ok) {
        const data = await response.json();
        authenticated = Boolean(data?.user);
      }
      const bridge = globalThis.__gptConnectorBridgeV1;
      return {
        officialOrigin: location.origin === "https://chatgpt.com",
        authenticated,
        bridgeReady: bridge?.version === 1 &&
          bridge?.buildId === ${JSON.stringify(bridgeBuildId)} &&
          typeof bridge.summary === "function"
      };
    })()`);
    return {
      cdp: check("cdp", "ready", "connected"),
      origin: check("official_origin", result.officialOrigin ? "ready" : "not_ready", result.officialOrigin ? "official" : "not_official"),
      auth: check("auth", result.authenticated ? "ready" : "not_ready", result.authenticated ? "authenticated" : "auth_required"),
      bridge: check("runtime_bridge", result.bridgeReady ? "ready" : "not_ready", result.bridgeReady ? "existing_bridge_ready" : "bridge_not_initialized"),
    };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "INVALID_INPUT") throw error;
    if (
      error instanceof ConnectorError && error.code === "CDP_UNAVAILABLE" &&
      error.details?.unreachable === true
    ) {
      // 専用Chromeが起動していない＝on-demand設計の平常状態（idle）。故障ではないため
      // not_readyへ丸めず、live runtime系checkを「未検証（chrome_idle）」として返す。
      // 起動中の異常（HTTP error・target不正・RUNTIME_DRIFT）は従来どおりnot_ready。
      return {
        cdp: check("cdp", "unverified", "chrome_idle"),
        origin: check("official_origin", "unverified", "cdp_not_inspected"),
        auth: check("auth", "unverified", "cdp_not_inspected"),
        bridge: check("runtime_bridge", "unverified", "cdp_not_inspected"),
      };
    }
    const reason = error instanceof ConnectorError && error.code === "RUNTIME_DRIFT"
      ? "runtime_unverified" : "cdp_unavailable";
    return {
      cdp: check("cdp", "not_ready", reason),
      origin: check("official_origin", "unverified", "cdp_not_inspected"),
      auth: check("auth", "unverified", "cdp_not_inspected"),
      bridge: check("runtime_bridge", "unverified", "cdp_not_inspected"),
    };
  } finally {
    client?.close();
  }
}

function check(id: string, status: CheckStatus, reason: string): FactoryCheck { return { id, status, reason }; }
function factoryResult(overall: CheckStatus, checks: readonly FactoryCheck[]) {
  return {
    schema: factoryDiagnosticsSchema,
    package_version: packageVersion,
    overall,
    diagnostic_schema: "gpt-connector.diagnostics.v1",
    state: { schema: "gpt-connector.consult-jobs.v1", migration: "none" },
    job: { schema: "gpt-connector.consult-job.v1", migration: "none" },
    checks,
  };
}
