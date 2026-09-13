import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ConnectorError } from "./errors.js";

export class CodexSteerSetupError extends ConnectorError {
  constructor(readonly reasonCode: string, message: string) {
    super("PARENT_DELIVERY_UNAVAILABLE", message);
  }
}

export const relayConfigSchema = z.object({
  schema: z.literal("gpt-connector.codex-relay.v1"), enabled: z.boolean(),
  binary: z.string(), node: z.string(), launcher: z.string(), socket_root: z.string(),
  previous_cli_path: z.string().nullable(),
}).strict();
export type RelayConfig = z.infer<typeof relayConfigSchema>;

export function relayConfigDirectory(home = homedir()): string {
  return join(home, ".gpt-connector", "codex-steer");
}

export function readRelayConfig(directory = relayConfigDirectory()): RelayConfig | null {
  let text: string;
  try { text = readFileSync(join(directory, "config.json"), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw new CodexSteerSetupError("codex_steer_config_invalid", "gpt-connectorのSteer設定JSONが不正です。");
  }
  const parsed = relayConfigSchema.safeParse(value);
  if (!parsed.success) throw new CodexSteerSetupError("codex_steer_config_invalid", "gpt-connectorのSteer設定が不正です。");
  return parsed.data;
}

export function prepareRelayDirectory(directory: string): void {
  if (!isAbsolute(directory)) throw new CodexSteerSetupError("codex_steer_path_invalid", "Steer保存先は絶対pathが必要です。");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new CodexSteerSetupError("codex_steer_path_invalid", "Steer保存先は本人所有の0700が必要です。");
  }
}

export function verifyRelaySocket(socket: string): void {
  const directory = lstatSync(dirname(socket));
  const entry = lstatSync(socket);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700 ||
      !entry.isSocket() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600) {
    throw new CodexSteerSetupError("codex_steer_path_invalid", "本人所有のCodex Steer socketを確認できません。");
  }
}

export interface CodexProcess { pid: number; parent_pid: number; command: string }
export function readCodexProcesses(): CodexProcess[] {
  const text = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return text.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), parent_pid: Number(match[2]), command: match[3]! }] : [];
  });
}

/** 接続先は公式App Serverの実引数から取得する。他製品の設定・保存先は参照しない。 */
export function processSocket(process: CodexProcess): string | null {
  return /(?:^|\s)--listen(?:=|\s+)unix:\/\/([^\s]+)(?:\s|$)/u.exec(process.command)?.[1] ?? null;
}
