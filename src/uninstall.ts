// 製品の廃止用。自分が置いた登録・hook・専用Chromeだけを外す。login profileと利用者のデータは残す。
import { configureCodexSteer } from "./setup-codex-hooks.js";
import { configureCursorHooks } from "./setup-cursor-hooks.js";
import { removeRegistration, setupClients } from "./setup-registration.js";
import { stopBrowser } from "./browser-launcher.js";

type Step = { readonly step: string; readonly status: string; readonly detail?: string };

async function attempt(step: string, run: () => Promise<string> | string): Promise<Step> {
  try { return { step, status: await run() }; }
  catch (error) { return { step, status: "failed", detail: error instanceof Error ? error.message : String(error) }; }
}

export async function uninstall() {
  const steps: Step[] = [];
  steps.push(await attempt("codex-steer", async () => (await configureCodexSteer("disable")).status));
  steps.push(await attempt("cursor-hooks", () => configureCursorHooks({ disable: true }).changed ? "removed" : "absent"));
  for (const client of setupClients) steps.push(await attempt(`registration:${client}`, async () => (await removeRegistration(client)).status));
  steps.push(await attempt("browser", async () => (await stopBrowser()).status));
  const failed = steps.some((step) => step.status === "failed" || (step.step === "codex-steer" && !["disabled", "unsupported"].includes(step.status)));
  return { schema: "gpt-connector.uninstall.v1", overall: failed ? "failed" : "uninstalled", steps };
}
