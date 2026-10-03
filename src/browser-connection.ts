import { startBrowser } from "./browser-launcher.js";
import { GptConnector, type ConnectorOptions } from "./connector.js";
import { ConnectorError } from "./errors.js";
import { GrokConnector, type GrokConnectorOptions } from "./grok-connector.js";

const ownedEndpoint = "http://127.0.0.1:9223";

type StartBrowser<P extends "chatgpt" | "grok"> = (options: { provider: P; stateDirectory?: string }) => Promise<unknown>;

interface GrokConnectionPorts {
  connect(options: GrokConnectorOptions): Promise<GrokConnector>;
  start: StartBrowser<"grok">;
}

interface ChatGptConnectionPorts {
  connect(options: ConnectorOptions): Promise<GptConnector>;
  start: StartBrowser<"chatgpt">;
}

const defaultGrokPorts: GrokConnectionPorts = { connect: GrokConnector.connect, start: startBrowser };
const defaultChatGptPorts: ChatGptConnectionPorts = { connect: GptConnector.connect, start: startBrowser };

export async function connectGrokWithBrowser(
  options: GrokConnectorOptions,
  ports: GrokConnectionPorts = defaultGrokPorts,
): Promise<GrokConnector> {
  return connectWithBrowser("grok", options, ports, ["CDP_UNAVAILABLE", "AUTH_REQUIRED", "RUNTIME_DRIFT"]);
}

/**
 * 専用Chromeが止まっている、またはChatGPT tabが閉じられている時は、Grokと同じく
 * `browser start`相当の準備をしてから接続し直す。転送された9223で準備できない時は元の失敗を返す。
 */
export async function connectChatGptWithBrowser(
  options: ConnectorOptions,
  ports: ChatGptConnectionPorts = defaultChatGptPorts,
): Promise<GptConnector> {
  return connectWithBrowser("chatgpt", options, ports, ["CDP_UNAVAILABLE"]);
}

async function connectWithBrowser<P extends "chatgpt" | "grok", O extends { endpoint?: string; stateDirectory?: string }, C>(
  provider: P,
  options: O,
  ports: { connect(options: O): Promise<C>; start: StartBrowser<P> },
  recoverable: readonly string[],
): Promise<C> {
  let failure: ConnectorError;
  try {
    return await ports.connect(options);
  } catch (error) {
    if ((options.endpoint ?? ownedEndpoint) !== ownedEndpoint || !(error instanceof ConnectorError) ||
        !recoverable.includes(error.code)) throw error;
    failure = error;
  }
  try {
    await ports.start({ provider, stateDirectory: options.stateDirectory });
  } catch (error) {
    // 9223が別の持ち主（SSH転送など）なら、この端末では準備できない。ポート衝突ではなく元の失敗を返す。
    if (error instanceof ConnectorError && error.details?.portConflict === true) throw failure;
    throw error;
  }
  return ports.connect(options);
}
