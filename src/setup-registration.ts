import { readFile, mkdir, writeFile, rename, lstat, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { archiveSetupConfig } from "./platform/setup-backup.js";
import { ensurePrivateDirectory, makeFilePrivate } from "./platform/state.js";
import { addTomlValues } from "./setup-toml.js";

export const setupClients = ["claude", "codex", "grok", "cursor"] as const;
export type SetupClient = typeof setupClients[number];
export const setupTools = ["chatgpt_models", "chatgpt_chat", "chatgpt_image", "chatgpt_close", "consult", "sessions", "diagnostics"];
type Table = Record<string, unknown>;
export interface SetupServer extends Table { command: string; args: string[]; env: Record<string, string>; }

function table(value: unknown): Table {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("MCP設定のobject形式が不正です。");
  return value as Table;
}

export function registrationPath(client: SetupClient, home = homedir(), env = process.env): string {
  switch (client) {
    case "claude": return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
    case "codex": return join(env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
    case "grok": return join(env.GROK_HOME ?? join(home, ".grok"), "config.toml");
    case "cursor": return join(env.CURSOR_HOME ?? join(home, ".cursor"), "mcp.json");
  }
}

export function mergeRegistration(source: string, client: SetupClient, command: string, args: string[], environmentDefaults: Record<string, string> = {}) {
  const toml = client === "codex" || client === "grok";
  const data = table(source.trim() ? (toml ? parse(source, { integersAsBigInt: true }) : JSON.parse(source)) : {});
  const key = toml ? "mcp_servers" : "mcpServers";
  const servers = data[key] === undefined ? {} : table(data[key]);
  const existing = servers.gpt_connector === undefined ? {} : table(servers.gpt_connector);
  if (existing.url !== undefined || existing.type === "http" || existing.type === "sse") throw new Error("gpt_connectorは既存のremote登録です。自動移行できません。");
  if (existing.command !== undefined && typeof existing.command !== "string") throw new Error("MCP commandには文字列が必要です。");
  if (existing.args !== undefined && (!Array.isArray(existing.args) || existing.args.some((arg) => typeof arg !== "string"))) throw new Error("MCP argsには文字列配列が必要です。");
  const defaults: Table = client === "codex" ? {
    startup_timeout_sec: 20n, tool_timeout_sec: 240n, enabled: true, required: false, enabled_tools: setupTools,
  } : client === "grok" ? { enabled: true } : {};
  const env = existing.env === undefined ? {} : table(existing.env);
  if (Object.values(env).some((value) => typeof value !== "string")) throw new Error("MCP envには文字列が必要です。");
  const server: SetupServer = { command, args: existing.command === undefined ? args : [], ...defaults, ...existing, env: { ...environmentDefaults, GPT_CONNECTOR_CDP_ENDPOINT: process.env.GPT_CONNECTOR_CDP_ENDPOINT ?? "http://127.0.0.1:9223", ...(process.env.GPT_CONNECTOR_STATE_DIR ? { GPT_CONNECTOR_STATE_DIR: process.env.GPT_CONNECTOR_STATE_DIR } : {}), ...env } };
  const changed = !isDeepStrictEqual(existing, server);
  data[key] = { ...servers, gpt_connector: server };
  const additions = Object.entries(server).filter(([name]) => name !== "env" && existing[name] === undefined).map(([name, value]) => ({ path: [key, "gpt_connector", name], value }));
  additions.push(...Object.entries(server.env).filter(([name]) => env[name] === undefined).map(([name, value]) => ({ path: [key, "gpt_connector", "env", name], value })));
  return { text: changed ? (toml ? addTomlValues(source, additions, servers.gpt_connector === undefined) : `${JSON.stringify(data, null, 2)}\n`) : source, server, changed };
}

export async function registerClient(client: SetupClient, command: string, args: string[], path = registrationPath(client), backupDirectory = join(homedir(), ".gpt-connector", "setup-backups"), environmentDefaults: Record<string, string> = {}) {
  // 共有設定の保存先がsymlinkなら、その実体を更新してリンクを維持する。
  let source = "";
  let target = path;
  let mode = 0o600;
  let exists = false;
  try {
    const info = await lstat(path);
    exists = true;
    target = info.isSymbolicLink() ? await realpath(path) : path;
    source = await readFile(target, "utf8");
    mode = (await lstat(target)).mode & 0o777;
  } catch (error) {
    if (exists || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const merged = mergeRegistration(source, client, command, args, environmentDefaults);
  let backup: string | null = null;
  if (merged.changed) {
    await mkdir(dirname(target), { recursive: true });
    if (exists) {
      ensurePrivateDirectory(backupDirectory);
      backup = join(backupDirectory, `${client}-${randomUUID()}.tar`);
      await writeFile(backup, "", { mode: 0o600, flag: "wx" });
      makeFilePrivate(backup);
      archiveSetupConfig(backup, target);
    }
    const temporary = `${target}.gpt-connector-${randomUUID()}.tmp`;
    await writeFile(temporary, merged.text, { mode, flag: "wx" });
    if (process.platform === "win32") makeFilePrivate(temporary);
    try {
      let current: string | null = null;
      try { current = await readFile(target, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== (exists ? source : null)) throw new Error("共有AI設定が更新されました。setupを再実行してください。");
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary);
      throw error;
    }
    if (await readFile(target, "utf8") !== merged.text) throw new Error("MCP設定の保存確認に失敗しました。");
  }
  return { client, path, backup, status: merged.changed ? "registered" : "unchanged", server: merged.server };
}

export async function readRegistration(client: SetupClient, path = registrationPath(client)) {
  const source = await readFile(path, "utf8");
  const data = client === "codex" || client === "grok" ? parse(source, { integersAsBigInt: true }) : JSON.parse(source);
  const server = table(table(table(data)[client === "codex" || client === "grok" ? "mcp_servers" : "mcpServers"]).gpt_connector);
  if (typeof server.command !== "string" || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")))) throw new Error("MCP command/args形式が不正です。");
  const env = server.env === undefined ? {} : table(server.env);
  if (Object.values(env).some((value) => typeof value !== "string")) throw new Error("MCP env形式が不正です。");
  return { client, path, backup: null, status: "existing", server: { ...server, args: server.args ?? [], env } as SetupServer };
}
