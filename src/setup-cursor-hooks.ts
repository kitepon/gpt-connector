import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { makeFilePrivate } from "./platform/state.js";

const hookEntrySchema = z.object({
  command: z.string().min(1),
  timeout: z.number().positive().optional(),
  matcher: z.string().optional(),
  failClosed: z.boolean().optional(),
  type: z.string().optional(),
}).passthrough();

const hooksDocumentSchema = z.object({
  version: z.number().optional(),
  hooks: z.record(z.string(), z.array(hookEntrySchema)).optional(),
}).passthrough();

export type CursorHooksResult = {
  readonly status: "ready" | "unchanged" | "disabled";
  readonly path: string;
  readonly changed: boolean;
};

export function cursorHooksPath(home = homedir(), env = process.env): string {
  return join(env.CURSOR_HOME ?? join(home, ".cursor"), "hooks.json");
}

export function cursorHookCommand(
  bin = process.env.GPT_CONNECTOR_BIN ?? "gpt-connector",
): string {
  return `${shellSingleQuote(bin)} cursor-hook`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ownsHook(hook: z.infer<typeof hookEntrySchema>, command: string, previous?: string): boolean {
  if (hook.command === command) return true;
  if (previous !== undefined && hook.command === previous) return true;
  return typeof hook.command === "string" &&
    hook.command.includes("cursor-hook") &&
    (hook.command.includes("gpt-connector") || hook.command.includes("GPT_CONNECTOR"));
}

/** Cursorのhooks.jsonへ自分の2本だけを登録／解除する。他製品のhookと位置は保持する。 */
export function mergeCursorParentHooks(
  file: string,
  command: string | null,
  previousCommand?: string,
): boolean {
  if (!existsSync(file)) {
    try {
      if (lstatSync(file).isSymbolicLink()) {
        throw new Error("Cursorのhooks設定symlinkの参照先がありません");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const target = existsSync(file) ? realpathSync(file) : file;
  let input: unknown = { version: 1, hooks: {} };
  if (existsSync(target)) {
    try {
      input = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      throw new Error("Cursorのhooks設定JSONを読めません");
    }
  }
  const document = hooksDocumentSchema.safeParse(input);
  if (!document.success) throw new Error("Cursorのhooks設定を読めません");
  const current = document.data;
  const hooks: Record<string, z.infer<typeof hookEntrySchema>[]> = {
    ...(current.hooks ?? {}),
  };

  const desired: Record<string, z.infer<typeof hookEntrySchema> | null> = {
    afterMCPExecution: command === null ? null : {
      command,
      timeout: 5,
      matcher: "consult",
    },
    postToolUse: command === null ? null : {
      command,
      timeout: 5,
    },
  };

  let changed = false;
  for (const [event, entry] of Object.entries(desired)) {
    const existing = [...(hooks[event] ?? [])];
    const withoutOwned = existing.filter(hook => !ownsHook(hook, command ?? "", previousCommand));
    const owned = existing.filter(hook => ownsHook(hook, command ?? "", previousCommand));
    if (entry === null) {
      if (owned.length === 0) continue;
      if (withoutOwned.length) hooks[event] = withoutOwned;
      else delete hooks[event];
      changed = true;
      continue;
    }
    if (owned.length === 1 && isDeepStrictEqual(owned[0], entry) && withoutOwned.length + 1 === existing.length) {
      // 位置も含め自分の登録が既に正しい。
      continue;
    }
    // 登録済みならその位置を保ち、中身だけ更新。無ければ末尾へ追加。
    if (owned.length === 1) {
      const index = existing.findIndex(hook => ownsHook(hook, command ?? "", previousCommand));
      const next = existing.map((hook, i) => i === index ? entry : hook)
        .filter((hook, i) => i === index || !ownsHook(hook, command ?? "", previousCommand));
      hooks[event] = next;
    } else {
      hooks[event] = [...withoutOwned, entry];
    }
    changed = true;
  }

  const next = { ...current, version: current.version ?? 1, hooks };
  if (!changed && isDeepStrictEqual(current, next)) return false;
  if (existsSync(target)) copyFileSync(target, `${target}.gpt-connector-backup`);
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  makeFilePrivate(target);
  if (!isDeepStrictEqual(JSON.parse(readFileSync(target, "utf8")), next)) {
    throw new Error("Cursor hookの読戻しが一致しません");
  }
  return true;
}

export function configureCursorHooks(options: {
  readonly check?: boolean;
  readonly disable?: boolean;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly bin?: string;
} = {}): CursorHooksResult {
  const path = cursorHooksPath(options.home, options.env);
  const command = cursorHookCommand(options.bin);
  if (options.check) {
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { hooks: {} };
    const document = hooksDocumentSchema.safeParse(raw);
    const hooks = document.success ? document.data.hooks ?? {} : {};
    const hasAfter = (hooks.afterMCPExecution ?? []).some(hook => ownsHook(hook, command));
    const hasPost = (hooks.postToolUse ?? []).some(hook => ownsHook(hook, command));
    return {
      status: hasAfter && hasPost ? "ready" : "disabled",
      path,
      changed: false,
    };
  }
  if (options.disable) {
    const changed = mergeCursorParentHooks(path, null, command);
    return { status: "disabled", path, changed };
  }
  const changed = mergeCursorParentHooks(path, command);
  return { status: changed ? "ready" : "unchanged", path, changed };
}
