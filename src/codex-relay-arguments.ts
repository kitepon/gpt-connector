// Macのlauncherで使っていた二巡の引数判定を、そのまま全OSへ共有する。
export function codexServerArguments(args: string[]): string[] | null {
  let mode: "root" | "server" | "other" = "root";
  let value = false;
  for (const arg of args) {
    if (value) { value = false; continue; }
    if (["-c", "--config", "--enable", "--disable", "--listen"].includes(arg)) { value = true; continue; }
    if (mode === "root") {
      if (/^(?:--config=|--enable=|--disable=|-c[\s\S])/.test(arg)) continue;
      if (arg === "app-server") mode = "server";
      else { mode = "other"; break; }
    } else if (["proxy", "start", "stop", "status", "generate-ts", "generate-json-schema", "--help", "-h", "--version", "-V"].includes(arg)) {
      mode = "other"; break;
    }
  }
  if (mode !== "server") return null;
  const result: string[] = [];
  value = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (value) { result.push(arg); value = false; continue; }
    if (["-c", "--config", "--enable", "--disable"].includes(arg)) { value = true; result.push(arg); }
    else if (arg === "--stdio" || arg === "--listen=stdio://") continue;
    else if (arg === "--listen") {
      if (args[++i] !== "stdio://") throw new Error("stdio以外の接続指定は変更できません");
    } else if (arg.startsWith("--listen=")) throw new Error("stdio以外の接続指定は変更できません");
    else result.push(arg);
  }
  return result;
}
