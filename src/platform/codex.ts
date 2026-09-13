// 親配送のOS選択だけを所有する。RPC、宛先threadの照合、配送状態は共通コードが所有する。
import { createConnection } from "node:net";
import { verifyRelaySocket } from "../codex-steer-config.js";
import { findWindowsParentSocket, windowsSocketConnection } from "./windows-codex-parent.js";
import { windowsCodexRuntime } from "./windows-codex-setup.js";
import { ConnectorError } from "../errors.js";

export const supportsCodexSteer = (platform: string = process.platform) => platform === "darwin" || platform === "win32";
export const codexSteerPlatform = (platform: string = process.platform, directory?: string) => platform === "win32" ? windowsCodexRuntime(directory) : undefined;

export function parentSocketForPlatform(mac: () => string): string {
  if (process.platform === "win32") return findWindowsParentSocket();
  if (process.platform === "darwin") return mac();
  throw new ConnectorError("PARENT_DELIVERY_UNAVAILABLE", "Codex親へのSteerはこのOSでは未対応です。");
}

export function codexSocketConnection(file: string) {
  if (process.platform === "win32") return windowsSocketConnection(file);
  verifyRelaySocket(file);
  return { url: "ws://localhost/rpc", options: { createConnection: () => createConnection(file) } };
}
