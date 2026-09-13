import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const argumentsFor = (script: string) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from(`$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n${script}`, "utf16le").toString("base64")];

/** PowerShell 7へUTF-16のscriptを引数として渡す。シェル展開やprofile読込みを行わない。 */
export async function windowsPowerShell(script: string, timeout = 10_000): Promise<string> {
  const { stdout } = await execFile("pwsh.exe", argumentsFor(script), {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export function windowsPowerShellSync(script: string, timeout = 10_000): string {
  return execFileSync("pwsh.exe", argumentsFor(script), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout, maxBuffer: 1024 * 1024 }).trim();
}

export const quotePowerShell = (text: string) => `'${text.replace(/'/g, "''")}'`;
