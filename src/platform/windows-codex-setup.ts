import { windowsLauncherSource } from "./windows-codex-launcher.js";
export { windowsLauncherSource } from "./windows-codex-launcher.js";
// Windows Desktop用の実行file、ユーザー環境変数、親processの接続確認を所有する。
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { relayConfigDirectory, CodexSteerSetupError as SetupError, type RelayConfig } from "../codex-steer-config.js";
import type { CodexSteerAction, CodexSteerResult, CodexSteerRuntime } from "../setup-codex-steer.js";
import { configureCodexSteer } from "../setup-codex-steer.js";
import { CodexDeliveryError, withCodexSocket } from "../codex-parent.js";
import { windowsPowerShellSync, quotePowerShell } from "./windows-powershell.js";
import { ensurePrivateDirectory, makeFilePrivate } from "./state.js";
import { readWindowsProcesses, readWindowsRelay, windowsProcessConnection } from "./windows-codex-parent.js";

export function findWindowsCodexCache(resources: string, cache: string): string {
  // Desktopが展開した4実行fileを配布元と照合する。展開・更新はDesktop自身が所有する。
  const names = ["codex.exe", "codex-code-mode-host.exe", "codex-windows-sandbox-setup.exe", "codex-command-runner.exe"];
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const expected = names.map(name => digest(join(resources, name)));
  const found = (existsSync(cache) ? readdirSync(cache, { withFileTypes: true }) : [])
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9a-f]{16}$/.test(entry.name))
    .filter(entry => names.every((name, index) => {
      const file = join(cache, entry.name, name);
      return existsSync(file) && digest(file) === expected[index];
    }));
  if (found.length !== 1) throw new SetupError("codex_desktop_runtime_unavailable", "現在のCodex Desktopが展開した実行fileを特定できません。公式Desktopを起動してからsetupを再実行してください。");
  return join(cache, found[0]!.name, "codex.exe");
}

function findBinary(): string {
  const resources = windowsPowerShellSync(`
$packages = @(Get-AppxPackage -Name OpenAI.Codex)
if ($packages.Count -ne 1) { throw '公式Codex Desktopを一つに特定できません' }
Join-Path $packages[0].InstallLocation 'app/resources'`);
  const value = findWindowsCodexCache(resources, join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin"));
  const result = spawnSync(value, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw new SetupError("codex_binary_unavailable", "公式Codex Desktopの実行fileを起動できません。");
  const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? "");
  if (result.status !== 0 || !match || (Number(match[1]) === 0 && Number(match[2]) < 154)) throw new SetupError("codex_version_unsupported", "公式Codex Desktopの対応CLIを確認できません。");
  return value;
}

function getGui(key: string): string | null {
  return windowsPowerShellSync(`[Environment]::GetEnvironmentVariable(${quotePowerShell(key)}, 'User')`) || null;
}

function setGui(key: string, value: string | null): void {
  windowsPowerShellSync(`
[Environment]::SetEnvironmentVariable(${quotePowerShell(key)}, ${value === null ? "$null" : quotePowerShell(value)}, 'User')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GptEnvironment {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, string value, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][GptEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`, 10_000);
}

export function buildWindowsLauncher(directory: string, source: string): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const launcher = join(directory, `codex-${digest}.exe`);
  const sourceFile = join(directory, `codex-${digest}.cs`);
  if (existsSync(launcher) && existsSync(sourceFile) && readFileSync(sourceFile, "utf8") === source) return launcher;
  const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!existsSync(compiler)) throw new SetupError("codex_launcher_compiler_unavailable", "Windows標準.NET Frameworkのコンパイラが見つかりません。");
  writeFileSync(sourceFile, source); makeFilePrivate(sourceFile);
  const result = spawnSync(compiler, ["/nologo", "/target:exe", "/reference:System.Runtime.Serialization.dll", `/out:${launcher}`, sourceFile], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.status !== 0) throw new SetupError("codex_launcher_build_failed", "Windows用のCodex起動fileを作成できません。");
  makeFilePrivate(launcher);
  return launcher;
}

export async function liveWindowsDesktopRelay(binary: string, socketRoot?: string): Promise<boolean> {
  const processes = readWindowsProcesses();
  const rows = new Map(processes.map(row => [row.pid, row]));
  for (const server of processes) {
    const desktop = rows.get(server.parent_pid);
    const file = windowsProcessConnection(server);
    if (!file || (socketRoot && join(file, "../..") !== socketRoot) ||
      server.executable.toLowerCase() !== binary.toLowerCase() ||
      !desktop || !/\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$/i.test(desktop.executable)) continue;
    if (!existsSync(file)) continue;
    readWindowsRelay(file, processes);
    try {
      await withCodexSocket(file, async request => { await request("thread/loaded/list", { limit: 1 }); }, 1_000);
      return true;
    } catch (error) {
      if (!(error instanceof CodexDeliveryError) || error.code !== "PARENT_DELIVERY_UNAVAILABLE") throw error;
    }
  }
  return false;
}

export function windowsCodexRuntime(directory = relayConfigDirectory()): Partial<CodexSteerRuntime> {
  return {
    directory, socket_root: join(directory, "sessions"),
    relay: fileURLToPath(new URL("./windows-codex-relay.js", import.meta.url)),
    findBinary, getGui, setGui,
    // ユーザー環境変数自体が永続設定なので、別のログイン処理を設けない。
    persist: () => {}, unpersist: () => {}, prepare: ensurePrivateDirectory, save,
    build: async (options, verify) => {
      ensurePrivateDirectory(options.socket_root);
      const launcher = buildWindowsLauncher(options.directory, windowsLauncherSource(options.node, options.relay, options.binary, options.socket_root));
      await verify(launcher);
      return launcher;
    },
    live: config => liveWindowsDesktopRelay(config.binary, config.socket_root),
    compatible: liveWindowsDesktopRelay,
  };
}

export async function configureWindowsCodexSteer(action: CodexSteerAction, overrides: Partial<CodexSteerRuntime> = {}): Promise<CodexSteerResult> {
  return configureCodexSteer(action, { ...overrides, platform: "win32" });
}

function save(directory: string, config: RelayConfig): void {
  const file = join(directory, `${randomUUID()}.tmp`);
  try {
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx" }); makeFilePrivate(file);
    renameSync(file, join(directory, "config.json"));
  } finally { rmSync(file, { force: true }); }
}
