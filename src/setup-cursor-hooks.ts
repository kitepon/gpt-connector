// Cursorの公式hook（afterMCPExecution・postToolUse）の登録。本体はaiterm-steer-delivery。
// 0.14以前の`gpt-connector cursor-hook`の登録は、同じ位置のまま新しいhook入口へ置き換える。
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as steer from "aiterm-steer-delivery";

import { makeFilePrivate } from "./platform/state.js";
import { GPT_CONNECTOR_PROFILE as PROFILE } from "./steer-profile.js";

export type CursorHooksResult = {
  readonly status: "ready" | "unchanged" | "disabled";
  readonly path: string;
  readonly changed: boolean;
};

const events = ["afterMCPExecution", "postToolUse"] as const;

export function cursorHooksPath(home = homedir(), env = process.env): string {
  return join(env.CURSOR_HOME ?? join(home, ".cursor"), "hooks.json");
}

export function cursorHookRuntime(node = process.execPath): steer.HookRuntime {
  return {
    command: steer.setupNodeExecutable(node),
    script: fileURLToPath(new URL("./gpt-connector-cursor-parent-hook.js", import.meta.url)),
  };
}

/** 0.14以前に登録した`'gpt-connector' cursor-hook`。 */
function ownsLegacyHook(hook: unknown): boolean {
  if (hook === null || typeof hook !== "object") return false;
  const command = (hook as { command?: unknown }).command;
  return typeof command === "string" && command.includes("cursor-hook") &&
    (command.includes("gpt-connector") || command.includes("GPT_CONNECTOR"));
}

function readHooks(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) {
    try {
      if (lstatSync(file).isSymbolicLink()) throw new steer.SetupError("config_invalid", "Cursorのhooks設定symlinkの参照先がありません");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return null;
  }
  let document: unknown;
  try { document = JSON.parse(readFileSync(realpathSync(file), "utf8")); }
  catch { throw new steer.SetupError("config_invalid", "Cursorのhook設定JSONを読めません"); }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new steer.SetupError("config_invalid", "Cursorのhooks設定はobjectである必要があります");
  }
  return document as Record<string, unknown>;
}

function hasLegacyHooks(document: Record<string, unknown> | null): boolean {
  const hooks = document?.hooks;
  if (hooks === null || typeof hooks !== "object") return false;
  return events.some(event => {
    const list = (hooks as Record<string, unknown>)[event];
    return Array.isArray(list) && list.some(ownsLegacyHook);
  });
}

/** 旧登録を最初の位置で新しい登録へ置き換え、残りの旧登録を外す。entryがnullなら旧登録を外すだけ。 */
function replaceLegacyHooks(file: string, entry: Record<string, unknown> | null): boolean {
  const current = readHooks(file);
  if (!hasLegacyHooks(current)) return false;
  const hooks = { ...(current!.hooks as Record<string, unknown>) };
  for (const event of events) {
    const list = hooks[event];
    if (!Array.isArray(list) || !list.some(ownsLegacyHook)) continue;
    const index = list.findIndex(ownsLegacyHook);
    const next = list.flatMap((hook, i) => i === index && entry ? [entry] : ownsLegacyHook(hook) ? [] : [hook]);
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  const next = { ...current!, hooks };
  const target = realpathSync(file);
  copyFileSync(target, `${target}${PROFILE.backup_suffix}`);
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  makeFilePrivate(target);
  if (!isDeepStrictEqual(JSON.parse(readFileSync(target, "utf8")), next)) {
    throw new steer.SetupError("config_readback_failed", "Cursorのhook登録の読戻しが一致しません");
  }
  return true;
}

export function configureCursorHooks(options: {
  readonly check?: boolean;
  readonly disable?: boolean;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtime?: steer.HookRuntime;
} = {}): CursorHooksResult {
  const path = cursorHooksPath(options.home, options.env);
  if (options.check) {
    const document = readHooks(path);
    const ready = steer.cursorParentHooksRegistered(PROFILE, document) && !hasLegacyHooks(document);
    return { status: ready ? "ready" : "disabled", path, changed: false };
  }
  if (options.disable) {
    const legacy = replaceLegacyHooks(path, null);
    const current = steer.removeCursorParentHooks(PROFILE, path) === "removed";
    return { status: "disabled", path, changed: legacy || current };
  }
  const runtime = options.runtime ?? cursorHookRuntime();
  // パッケージの登録と同じ形で置き換えるので、続く登録は位置を変えずにunchangedになる。
  const legacy = replaceLegacyHooks(path, { command: steer.cursorParentHookCommand(runtime), timeout: 15 });
  const current = steer.mergeCursorParentHooks(PROFILE, path, runtime) === "configured";
  const changed = legacy || current;
  return { status: changed ? "ready" : "unchanged", path, changed };
}
