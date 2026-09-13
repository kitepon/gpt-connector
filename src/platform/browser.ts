// ブラウザのOS選択はここだけで行う。起動・認証の順序は共通launcherが所有する。
import * as darwin from "./darwin.js";
import * as windows from "./windows-browser.js";
import { ConnectorError } from "../errors.js";

export interface ListenerProcess {
  readonly pid: string;
  readonly command: string;
  readonly executable?: string;
  readonly args?: readonly string[];
}
export interface SpawnedChild { readonly once: (event: "error", listener: (error: Error) => void) => unknown; }
export interface BrowserPlatform {
  prepareProfile?(profile: string): void | Promise<void>;
  readonly ownershipProbeTimeoutMs?: number;
  chromeLaunchCommand(profile: string): { readonly command: string; readonly args: readonly string[] };
  spawnDetached(command: string, args: readonly string[]): SpawnedChild;
  inspectListenerProcesses(): Promise<readonly ListenerProcess[]>;
  isOwnedChromeProcess(listener: ListenerProcess, profile: string): boolean;
  hideProcess(pid: number, timeoutMs: number): Promise<void>;
  revealProcess(pid: number, timeoutMs: number): Promise<void>;
  activateProcess(pid: number, timeoutMs: number): Promise<void>;
  verifyWindowVisibility(pid: number, visible: boolean, timeoutMs: number): Promise<void>;
}

export function supportsLiveBrowser(platform: string = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function browserPlatform(platform: string = process.platform): BrowserPlatform {
  if (platform === "darwin") return { ...darwin, isOwnedChromeProcess: (listener, profile) => darwin.isOwnedChromeCommand(listener.command, profile) };
  if (platform === "win32") return windows;
  throw new ConnectorError("INVALID_INPUT", "専用Chromeの起動・表示はこのOSでは未対応です。");
}
