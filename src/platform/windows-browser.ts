// WindowsのChrome探索、ポート所有確認、Win32 window制御を所有する。
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { ConnectorError } from "../errors.js";
import type { ListenerProcess } from "./browser.js";
import { quotePowerShell, windowsPowerShell } from "./windows-powershell.js";
import { ensurePrivateDirectory } from "./state.js";
import { runInInteractiveSession } from "./windows-interactive.js";

export const prepareProfile = ensurePrivateDirectory;
// CIMとTCP情報の取得は実機で約1.4秒。Windowsのprocess検査だけに余裕を持たせる。
export const ownershipProbeTimeoutMs = 5_000;

export function chromeLaunchCommand(profile: string, env = process.env, exists = existsSync) {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((root): root is string => !!root);
  const command = roots.map(root => win32.join(root, "Google", "Chrome", "Application", "chrome.exe")).find(exists);
  if (!command) throw new ConnectorError("CDP_UNAVAILABLE", "Google Chromeが見つかりません。公式installerで導入してください。");
  return { command, args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`, "--no-startup-window", "--no-first-run", "--no-default-browser-check"] };
}

/** WMI owns argument quoting, same-session placement and lifetime; the caller owns interactive UI eligibility. */
export function detachedLaunchSource(command: string, args: readonly string[]): string {
  const commandLine = [command, ...args].map(value => '"' +
    value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"').join(" ");
  // Same-SIDの対話sessionでWMIを呼び、表示sessionとbrowserの独立した寿命を両立する。
  return `
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]0x01000008 }
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quotePowerShell(commandLine)}; ProcessStartupInformation = $startup }
if ($created.ReturnValue -ne 0 -or $created.ProcessId -le 0) { throw 'interactive_browser_create_failed' }
$child = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $created.ProcessId)
if (!$child -or $child.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'interactive_browser_session_mismatch' }
$owner = Invoke-CimMethod -InputObject $child -MethodName GetOwnerSid
if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'interactive_browser_owner_mismatch' }
`;
}

export async function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  await runInInteractiveSession(detachedLaunchSource(command, args), 10_000);
}

// Chrome hardens its process DACL, so its command line and image path are unreadable even to the same user.
// Ownership is therefore the 9223 listener being the process that holds the dedicated profile's lockfile.
// Restart Manager is not used: it returned access denied under the CI runner's service account.
export function isOwnedChromeProcess(listener: ListenerProcess): boolean {
  return listener.command.toLowerCase() === "chrome.exe" && listener.profileLock === true;
}

const profileLockType = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class GptProfileLock {
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public IntPtr Information; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle file, out IoStatus status, IntPtr buffer, int length, int fileClass);
  // FileProcessIdsUsingFileInformation needs only an attribute handle to the file, never a handle to the hardened process.
  public static long[] Holders(string path) {
    using (var file = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (file.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      for (int length = 4096; length <= 1 << 20; length *= 2) {
        var buffer = Marshal.AllocHGlobal(length);
        try {
          IoStatus status; int code = NtQueryInformationFile(file, out status, buffer, length, 47);
          if (code == unchecked((int)0xC0000004)) continue;
          if (code != 0) throw new System.ComponentModel.Win32Exception("NtQueryInformationFile 0x" + code.ToString("X8"));
          var count = Marshal.ReadInt32(buffer);
          var pids = new long[count];
          for (int i = 0; i < count; i++) pids[i] = Marshal.ReadIntPtr(buffer, IntPtr.Size * (i + 1)).ToInt64();
          return pids;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("file_process_ids_too_large");
    }
  }
}
'@
`;

export async function inspectListenerProcesses(profile: string, port = 9223): Promise<readonly ListenerProcess[]> {
  const output = await windowsPowerShell(`${profileLockType}
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq ${port})
$lock = Join-Path ${quotePowerShell(profile)} 'lockfile'
$holders = if ($listeners.Count -gt 0 -and (Test-Path -LiteralPath $lock)) { @([GptProfileLock]::Holders($lock)) } else { @() }
$result = @(foreach ($connection in $listeners) {
  if ($connection.LocalAddress -ne '127.0.0.1') { throw '専用CDPの待受addressが不正です' }
  $entry = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $connection.OwningProcess)
  if (!$entry -or !$entry.Name) { throw '専用Chromeのprocess情報を取得できません' }
  @{ pid = [string]$entry.ProcessId; command = [string]$entry.Name; profileLock = ($holders -contains [long]$entry.ProcessId) }
})
ConvertTo-Json -InputObject $result -Compress -Depth 4`);
  return z.array(z.object({ pid: z.string().regex(/^\d+$/), command: z.string(), profileLock: z.boolean() })).parse(JSON.parse(output));
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
  const script = `
$target = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if (!$target -or $target.SessionId -le 0 -or $target.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'interactive_window_session_mismatch' }
$owner = Invoke-CimMethod -InputObject $target -MethodName GetOwnerSid
if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'interactive_window_owner_mismatch' }
${windowType}
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
throw '専用Chromeの表示状態が収束しません'`;
  await runInInteractiveSession(script, timeoutMs);
}

export const hideProcess = (pid: number, timeout: number) => windowAction(pid, "hide", timeout);
export const revealProcess = (pid: number, timeout: number) => windowAction(pid, "show", timeout);
export const activateProcess = (pid: number, timeout: number) => windowAction(pid, "activate", timeout);
export async function verifyWindowVisibility(pid: number, visible: boolean, timeout: number): Promise<void> {
  try { await windowAction(pid, visible ? "visible" : "hidden", timeout); }
  catch (cause) { throw new ConnectorError("RUNTIME_DRIFT", "専用ChromeのWindows表示状態を確認できませんでした。", undefined, { cause }); }
}
