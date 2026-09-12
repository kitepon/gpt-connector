import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

/** Windowsのドライブ文字を扱えるOS標準tarで設定を保存する。 */
export function archiveSetupConfig(archive: string, source: string): void {
  let command = "tar";
  if (process.platform === "win32") {
    if (!process.env.SystemRoot) throw new Error("Windows標準tarの解決にSystemRootが必要です。");
    command = join(process.env.SystemRoot, "System32", "tar.exe");
  }
  execFileSync(command, ["-cf", archive, "-C", dirname(source), basename(source)], { stdio: "pipe", windowsHide: true });
}
