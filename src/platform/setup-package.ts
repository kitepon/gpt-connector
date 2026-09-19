import { execFileSync, spawnSync } from "node:child_process";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupNodeExecutable } from "./setup-node.js";
import { realpathSync } from "node:fs";
import { packageVersion } from "../version.js";
import type { SetupClient } from "../setup-registration.js";

export function runNpm(args: string[], cwd?: string): string {
  const cli = process.env.npm_execpath;
  if (cli && basename(cli) === "npm-cli.js") return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  if (process.platform === "win32") return execFileSync(process.execPath, [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args], { cwd, encoding: "utf8" });
  return execFileSync("npm", args, { cwd, encoding: "utf8" });
}

export function setupLaunchDefaults(client: SetupClient) {
  const node = setupNodeExecutable();
  const prefix = runNpm(["prefix", "--global"]).trim();
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  const command = client === "grok" || client === "cursor" ? join(bin, process.platform === "win32" ? "gpt-connector-mcp.cmd" : "gpt-connector-mcp") : "gpt-connector-mcp";
  const windows = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const directories = process.platform === "win32" ? [bin, dirname(process.execPath), join(windows, "System32"), windows, join(windows, "System32", "Wbem"), join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7"), join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE!, "AppData", "Local"), "Microsoft", "WindowsApps")] : [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return { command, env: { PATH: [...new Set([bin, dirname(node), ...directories])].join(delimiter) } };
}

/** npxの一時ディレクトリを登録せず、同じ公開版を公式npmで導入してから引き継ぐ。 */
export function installSetupPackage(args: string[]): number | null {
  const globalRoot = runNpm(["root", "--global"]).trim();
  const installed = join(globalRoot, "gpt-connector");
  const current = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let installedReal: string | undefined;
  try { installedReal = realpathSync(installed); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (installedReal === realpathSync(current)) return null;
  process.stderr.write(`gpt-connector@${packageVersion}をnpm globalへ導入します。\n`);
  runNpm(["install", "--global", `gpt-connector@${packageVersion}`]);
  const result = spawnSync(process.execPath, [join(installed, "dist/src/cli.js"), "setup", ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error("導入後のsetupが中断しました。");
  return result.status;
}
