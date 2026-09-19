// WindowsのChrome探索、ポート所有確認、Win32 window制御を所有する。
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { ConnectorError } from "../errors.js";
import type { ListenerProcess } from "./browser.js";
import { quotePowerShell, windowsPowerShell } from "./windows-powershell.js";
import { ensurePrivateDirectory } from "./state.js";

export const prepareProfile = ensurePrivateDirectory;
// CIMとTCP情報の取得は実機で約1.4秒。Windowsのprocess検査だけに余裕を持たせる。
export const ownershipProbeTimeoutMs = 5_000;

export function chromeLaunchCommand(profile: string, env = process.env, exists = existsSync) {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((root): root is string => !!root);
  const command = roots.map(root => win32.join(root, "Google", "Chrome", "Application", "chrome.exe")).find(exists);
  if (!command) throw new ConnectorError("CDP_UNAVAILABLE", "Google Chromeが見つかりません。公式installerで導入してください。");
  return { command, args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`, "--no-startup-window", "--no-first-run", "--no-default-browser-check"] };
}

export async function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  const commandLine = [command, ...args].map(value => '"' +
    value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"').join(" ");
  // detachedだけではCodex等の終了jobを継承する。標準WMIのprocess作成でbrowserの寿命を独立させる。
  await windowsPowerShell(`
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]0x01000008 }
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quotePowerShell(commandLine)}; ProcessStartupInformation = $startup }
if ($created.ReturnValue -ne 0 -or $created.ProcessId -le 0) { throw ('専用Chromeのprocess作成に失敗しました: ' + $created.ReturnValue) }
`);
}

export function isOwnedChromeProcess(listener: ListenerProcess, profile: string): boolean {
  const args = listener.args;
  if (!listener.executable || win32.basename(listener.executable).toLowerCase() !== "chrome.exe" || !args) return false;
  if (win32.normalize(args[0] ?? "").toLowerCase() !== win32.normalize(listener.executable).toLowerCase()) return false;
  const values = (key: string) => args.filter(arg => arg.startsWith(key + "="));
  return values("--remote-debugging-address").length === 1 && args.includes("--remote-debugging-address=127.0.0.1")
    && values("--remote-debugging-port").length === 1 && args.includes("--remote-debugging-port=9223")
    && values("--user-data-dir").length === 1
    && win32.normalize(values("--user-data-dir")[0]!.slice("--user-data-dir=".length)).toLowerCase() === win32.normalize(profile).toLowerCase();
}

const commandLineType = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GptCommandLine {
  [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Split(string command) {
    int count;
    var memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var args = new string[count];
      for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return args;
    } finally { LocalFree(memory); }
  }
}
'@
`;

export async function inspectListenerProcesses(): Promise<readonly ListenerProcess[]> {
  const output = await windowsPowerShell(`${commandLineType}
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 9223)
$result = @(foreach ($connection in $listeners) {
  if ($connection.LocalAddress -ne '127.0.0.1') { throw '専用CDPの待受addressが不正です' }
  $entry = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $connection.OwningProcess)
  if (!$entry.ExecutablePath -or !$entry.CommandLine) { throw '専用Chromeのprocess情報を取得できません' }
  @{ pid = [string]$entry.ProcessId; command = $entry.CommandLine; executable = $entry.ExecutablePath; args = [GptCommandLine]::Split($entry.CommandLine) }
})
ConvertTo-Json -InputObject $result -Compress -Depth 4`);
  return z.array(z.object({ pid: z.string().regex(/^\d+$/), command: z.string(), executable: z.string(), args: z.array(z.string()) })).parse(JSON.parse(output));
}

const windowType = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class GptWindows {
  delegate bool Callback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  public static IntPtr[] ForProcess(uint pid) {
    var result = new List<IntPtr>();
    if (!EnumWindows((window, parameter) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
      if (owner == pid && name.ToString() == "Chrome_WidgetWin_1") result.Add(window);
      return true;
    }, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
    return result.ToArray();
  }
}
'@
`;

async function windowAction(pid: number, action: "hide" | "show" | "activate" | "visible" | "hidden", timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("PIDが不正です");
  const visible = action === "show" || action === "activate" || action === "visible";
  await windowsPowerShell(`${windowType}
$windows = @([GptWindows]::ForProcess(${pid}))
if ($windows.Count -eq 0) { throw '専用Chromeのwindowがありません' }
foreach ($window in $windows) {
  ${action === "hide" || action === "show" ? `if (![GptWindows]::ShowWindowAsync($window, ${visible ? 9 : 0})) { throw 'window表示要求が失敗しました' }` : ""}
  ${action === "activate" ? "[void][GptWindows]::SetForegroundWindow($window)" : ""}
}
$deadline = [DateTime]::UtcNow.AddMilliseconds(${Math.max(1, timeoutMs)})
do {
  $windows = @([GptWindows]::ForProcess(${pid}))
  $shown = @($windows | Where-Object { [GptWindows]::IsWindowVisible($_) -and ![GptWindows]::IsIconic($_) })
  if ($windows.Count -gt 0 -and ${visible ? "$shown.Count -gt 0" : "@($windows | Where-Object { [GptWindows]::IsWindowVisible($_) }).Count -eq 0"}) { return }
  Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
throw '専用Chromeの表示状態が収束しません'`, timeoutMs);
}

export const hideProcess = (pid: number, timeout: number) => windowAction(pid, "hide", timeout);
export const revealProcess = (pid: number, timeout: number) => windowAction(pid, "show", timeout);
export const activateProcess = (pid: number, timeout: number) => windowAction(pid, "activate", timeout);
export async function verifyWindowVisibility(pid: number, visible: boolean, timeout: number): Promise<void> {
  try { await windowAction(pid, visible ? "visible" : "hidden", timeout); }
  catch (cause) { throw new ConnectorError("RUNTIME_DRIFT", "専用ChromeのWindows表示状態を確認できませんでした。", undefined, { cause }); }
}
