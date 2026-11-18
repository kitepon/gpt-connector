// 製品の廃止用。自分が置いた登録・hook・専用Chromeだけを外す。login profileと利用者のデータは残す。
import { CodexSteerSetupError, readRelayConfig } from "./codex-steer-config.js";
import { configureCodexSteer } from "./setup-codex-hooks.js";
import { configureCursorHooks } from "./setup-cursor-hooks.js";
import { removeRegistration, setupClients } from "./setup-registration.js";
import { stopBrowser } from "./browser-launcher.js";

type Step = { readonly step: string; readonly status: string; readonly detail?: string };
type Outcome = string | { readonly status: string; readonly detail: string };

async function attempt(step: string, run: () => Promise<Outcome> | Outcome): Promise<Step> {
  try {
    const outcome = await run();
    return { step, ...(typeof outcome === "string" ? { status: outcome } : outcome) };
  } catch (error) { return { step, status: "failed", detail: error instanceof Error ? error.message : String(error) }; }
}

// SSHなどGUIのlaunchd領域に入れない場面では、旧中継が既に無効な時だけGUI側の確認を省いてhookを外す。
// 旧中継が有効のまま省くと、GUIにlauncher変数が残り得るので失敗のままにする。
async function disableCodexSteer(): Promise<Outcome> {
  try { return (await configureCodexSteer("disable")).status; } catch (error) {
    if (!(error instanceof CodexSteerSetupError) || error.reasonCode !== "codex_steer_environment_unavailable" || readRelayConfig()?.enabled) throw error;
    const result = await configureCodexSteer("disable", { legacyOverride: () => null });
    return { status: result.status, detail: "gui_unchecked: no GUI launchd domain in this session; the old relay was already disabled" };
  }
}

export async function uninstall() {
  const steps: Step[] = [];
  steps.push(await attempt("codex-steer", disableCodexSteer));
  steps.push(await attempt("cursor-hooks", () => configureCursorHooks({ disable: true }).changed ? "removed" : "absent"));
  for (const client of setupClients) steps.push(await attempt(`registration:${client}`, async () => (await removeRegistration(client)).status));
  steps.push(await attempt("browser", async () => (await stopBrowser()).status));
  // restart_required: the hook is removed and only a Codex restart is left, so it is not a failure.
  const failed = steps.some((step) => step.status === "failed" || (step.step === "codex-steer" && !["disabled", "unsupported", "restart_required"].includes(step.status)));
  return { schema: "gpt-connector.uninstall.v1", overall: failed ? "failed" : "uninstalled", steps };
}
