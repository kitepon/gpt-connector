// macOS専用プリミティブの唯一の置き場。open起動・JXAによるwindow/process制御・lsof/psのポート所有確認だけを持ち、
// 起動オーケストレーション（lock・deadline・CDP window制御）はbrowser-launcher側に置く。
import { execFile as execFileCallback, spawn as nodeSpawn } from "node:child_process";
import { promisify } from "node:util";
import { ConnectorError } from "../errors.js";

export interface ListenerProcess { readonly pid: string; readonly command: string; }
export interface SpawnedChild { readonly once: (event: "error", listener: (error: Error) => void) => unknown; }

const execFile = promisify(execFileCallback);
const appProbeTimeoutMs = 3_000;

export function chromeLaunchCommand(profile: string): { readonly command: string; readonly args: readonly string[] } {
  return { command: "open", args: ["-j", "-g", "-n", "-a", "Google Chrome", "--args", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`, "--no-startup-window", "--no-first-run", "--no-default-browser-check"] };
}

export function spawnDetached(command: string, args: readonly string[]): SpawnedChild {
  return nodeSpawn(command, args, { detached: true, stdio: "ignore" });
}

const runningApplicationActionScript = "ObjC.import('AppKit'); function run(argv) { const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])); if (a.isNil()) throw new Error('PID not running'); const action = String(argv[1]); if (action === 'hide') a.hide; else if (action === 'unhide') a.unhide; else if (action === 'activate') { if (!a.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps)) throw new Error('activate failed'); } else throw new Error('invalid action'); return 'ok'; }";
const runningApplicationStatusScript = "ObjC.import('AppKit'); function run(argv) { const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])); if (a.isNil()) throw new Error('PID not running'); const status = String(argv[1]); if (status === 'hide') return String(Boolean(a.hidden)); if (status === 'unhide') return String(!Boolean(a.hidden)); if (status === 'activate') return String(Boolean(a.active)); throw new Error('invalid status'); }";
async function runningApplicationAction(pid: number, action: "hide" | "unhide" | "activate", timeoutMs = appProbeTimeoutMs): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("PIDが不正です");
  await execFile("osascript", ["-l", "JavaScript", "-e", runningApplicationActionScript, "--", String(pid), action], { timeout: Math.min(timeoutMs, 500) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const { stdout } = await execFile("osascript", ["-l", "JavaScript", "-e", runningApplicationStatusScript, "--", String(pid), action], { timeout: Math.min(500, remaining) });
    if (stdout.trim() === "true") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(action === "hide" ? "hidden状態への遷移がtimeoutしました" : action === "unhide" ? "hidden状態の解除がtimeoutしました" : "active状態への遷移がtimeoutしました");
}
export async function hideProcess(pid: number, timeoutMs: number): Promise<void> { await runningApplicationAction(pid, "hide", timeoutMs); }
export async function revealProcess(pid: number, timeoutMs: number): Promise<void> { await runningApplicationAction(pid, "unhide", timeoutMs); }
export async function activateProcess(pid: number, timeoutMs: number): Promise<void> { await runningApplicationAction(pid, "activate", timeoutMs); }

const windowVisibilityScript = "ObjC.import('CoreGraphics'); function run(argv) { const pid = Number(argv[0]); const r = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID); const n = $.CFArrayGetCount(r); let count = 0; for (let i = 0; i < n; i += 1) { const value = ObjC.deepUnwrap(ObjC.castRefToObject($.CFArrayGetValueAtIndex(r, i))); if (value.kCGWindowOwnerPID === pid && value.kCGWindowLayer === 0) count += 1; } return String(count); }";
export async function verifyWindowVisibility(pid: number, expectedVisible: boolean, timeoutMs: number): Promise<void> { const deadline = Date.now() + timeoutMs; do { let stdout: string; try { ({ stdout } = await execFile("osascript", ["-l", "JavaScript", "-e", windowVisibilityScript, "--", String(pid)], { timeout: Math.min(3_000, Math.max(1, deadline - Date.now())) })); } catch (error) { throw new ConnectorError("CDP_UNAVAILABLE", "WindowServer状態を確認できませんでした。", undefined, { cause: error }); } const count = Number(stdout.trim()); if (Number.isSafeInteger(count) && (expectedVisible ? count >= 1 : count === 0)) return; if (Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 100)); } while (Date.now() < deadline); throw new ConnectorError("RUNTIME_DRIFT", expectedVisible ? "WindowServer表示windowがありません。" : "WindowServer表示windowが残っています。"); }

export function isOwnedChromeCommand(command: string, profile: string): boolean {
  const token = (value: string) => new RegExp(`(?:^|\\s)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`);
  return /\/Google Chrome(?:\s|$)/.test(command)
    && token("--remote-debugging-address=127.0.0.1").test(command)
    && token("--remote-debugging-port=9223").test(command)
    && token(`--user-data-dir=${profile}`).test(command);
}

export async function inspectListenerProcesses(): Promise<readonly ListenerProcess[]> {
  try {
    const { stdout } = await execFile("lsof", ["-nP", "-iTCP:9223", "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    const pids = [...new Set(stdout.split("\n").map((value) => value.trim()).filter((value) => /^\d+$/.test(value)))];
    return Promise.all(pids.map(async (pid) => {
      const { stdout: command } = await execFile("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
      return { pid, command: command.trim() };
    }));
  } catch { return []; }
}

// macOS専用面のゲート判定の唯一の置き場。呼び出し側でprocess.platformを直接比較しない。
export function isDarwin(platformOverride?: string): boolean {
  return (platformOverride ?? process.platform) === "darwin";
}
