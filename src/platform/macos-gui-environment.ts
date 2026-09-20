import { spawnSync } from "node:child_process";
import { CodexSteerSetupError } from "../codex-steer-config.js";

// 永続PTYやSSHのBackground環境ではなく、Desktopが起動するAqua環境を対象にする。
export function macGuiEnvironment(
  action: "getenv" | "setenv" | "unsetenv", key: string, value?: string,
  run = (args: string[]) => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 5_000 }),
  uid = process.getuid?.(),
): string | null {
  if (uid === undefined) throw new CodexSteerSetupError("codex_steer_platform_unsupported", "GUI設定はmacOSで操作します");
  const result = run(["asuser", String(uid), "/bin/launchctl", action, key, ...(value === undefined ? [] : [value])]);
  if (action === "getenv" && result.status === 1 && !result.error && !result.stderr.trim()) return null;
  if (result.error || result.status !== 0) throw new CodexSteerSetupError("codex_steer_environment_unavailable", "GUIの起動設定を操作できません");
  return result.stdout.trim() || null;
}
