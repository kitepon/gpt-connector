// OS依存のstate置き場と権限強制の唯一の置き場。Windowsはicacls ACL、POSIXはmode bitsで
// owner-only privacyを強制する。どちらを使うかの分岐は本fileの外へ漏らさない。
import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir, platform as hostPlatform } from "node:os";
import { join } from "node:path";

export type WindowsAclApplier = (path: string, directory: boolean) => void;

export function isWindows(env?: NodeJS.ProcessEnv): boolean { return env?.OS === "Windows_NT" || hostPlatform() === "win32"; }

export function defaultFactoryReporterConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return isWindows(env)
    ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "dotagents", "factory-reporter", "config.json")
    : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "dotagents", "factory-reporter.json");
}

export function defaultRuntimeErrorStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return isWindows(env)
    ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "gpt-connector", "runtime-errors.json")
    : join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "gpt-connector", "runtime-errors.json");
}

export function defaultConsultStateDirectory(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "gpt-connector");
}

export function makeFilePrivate(path: string, env?: NodeJS.ProcessEnv, windowsAcl?: WindowsAclApplier): void {
  if (!isWindows(env)) chmodSync(path, 0o600); else applyWindowsAcl(path, false, windowsAcl);
}

export function ensurePrivateDirectory(directory: string, env?: NodeJS.ProcessEnv, windowsAcl?: WindowsAclApplier): void { mkdirSync(directory, { recursive: true, mode: 0o700 }); const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe store directory"); if (!isWindows(env)) chmodSync(directory, 0o700); else applyWindowsAcl(directory, true, windowsAcl); assertPrivate(directory, true, env, windowsAcl); }

export function assertPrivate(path: string, directory: boolean, env?: NodeJS.ProcessEnv, windowsAcl?: WindowsAclApplier): void { const info = statSync(path); if (!isWindows(env) && (info.mode & 0o077) !== 0) throw new Error(directory ? "directory permissions" : "file permissions"); if (isWindows(env)) applyWindowsAcl(path, directory, windowsAcl); }

function applyWindowsAcl(path: string, directory: boolean, injected?: WindowsAclApplier): void {
  if (injected) return injected(path, directory);
  const user = execFileSync("whoami", [], { encoding: "utf8", windowsHide: true }).trim();
  if (!user) throw new Error("windows acl user");
  const grant = `${user}:${directory ? "(OI)(CI)F" : "F"}`;
  execFileSync("icacls", [path, "/inheritance:r", "/grant:r", grant, "/remove:g", "Users", "Everyone", "Authenticated Users"], { encoding: "utf8", windowsHide: true });
  const verified = execFileSync("icacls", [path], { encoding: "utf8", windowsHide: true });
  if (!verified.toLowerCase().includes(user.toLowerCase()) || /Everyone|Authenticated Users/iu.test(verified)) throw new Error("windows acl verification");
}

export async function chmodPrivateIfPosix(path: string): Promise<void> {
  if (!isWindows()) await chmod(path, 0o600);
}

export function posixModeExposesOthers(mode: number): boolean {
  return !isWindows() && (mode & 0o077) !== 0;
}
