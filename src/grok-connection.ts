import { startBrowser } from "./browser-launcher.js";
import { ConnectorError } from "./errors.js";
import { GrokConnector, type GrokConnectorOptions } from "./grok-connector.js";

const ownedEndpoint = "http://127.0.0.1:9223";

interface GrokConnectionPorts {
  connect(options: GrokConnectorOptions): Promise<GrokConnector>;
  start(options: { provider: "grok"; stateDirectory?: string }): Promise<unknown>;
}

const defaultPorts: GrokConnectionPorts = { connect: GrokConnector.connect, start: startBrowser };

export async function connectGrokWithBrowser(
  options: GrokConnectorOptions,
  ports: GrokConnectionPorts = defaultPorts,
): Promise<GrokConnector> {
  try {
    return await ports.connect(options);
  } catch (error) {
    if ((options.endpoint ?? ownedEndpoint) !== ownedEndpoint || !(error instanceof ConnectorError) ||
        !["CDP_UNAVAILABLE", "AUTH_REQUIRED", "RUNTIME_DRIFT"].includes(error.code)) throw error;
  }
  await ports.start({ provider: "grok", stateDirectory: options.stateDirectory });
  return ports.connect(options);
}
