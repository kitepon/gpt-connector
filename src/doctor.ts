import type { ConnectorDiagnostics } from "./contract.js";
import { GptConnector, type ConnectorOptions } from "./connector.js";
import { showBrowser, type BrowserShowResult } from "./browser-launcher.js";

interface DoctorDependencies {
  readonly diagnose: (options: ConnectorOptions) => Promise<ConnectorDiagnostics>;
  readonly show: () => Promise<BrowserShowResult>;
}

const defaultDependencies: DoctorDependencies = {
  diagnose: (options) => GptConnector.doctor(options),
  show: () => showBrowser(),
};

/** CLI doctorは認証切れの専用Chromeを表示してから診断結果を返す。 */
export async function doctorWithAuthRecovery(
  options: ConnectorOptions = {},
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<ConnectorDiagnostics> {
  const diagnostics = await dependencies.diagnose(options);
  if (diagnostics.reasonCode === "auth_required") await dependencies.show();
  return diagnostics;
}
