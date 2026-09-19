// Codexの設定領域にはhook登録だけを置き、配送の所有情報はgpt-connectorが保持する。
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { relayConfigDirectory } from "./codex-steer-config.js";
import { CodexHookError as CodexDeliveryError } from "./codex-delivery-error.js";
import { readRuntimeProcesses, type RuntimeProcess } from "./platform/codex-processes.js";

const processSchema = z.object({ pid: z.number().int(), started_identity: z.string() });
export const codexHookConfigSchema = z.object({
  schema: z.literal("gpt-connector.codex-parent-hooks.v1"), enabled: z.boolean(),
  codex_home: z.string(), binary: z.string(), command: z.string(), node: z.string(), hook: z.string(),
  stale_processes: z.array(processSchema),
}).strict();
export type CodexHookConfig = z.infer<typeof codexHookConfigSchema>;
export function codexHookDirectory(): string { return path.join(path.dirname(relayConfigDirectory()), "codex-parent-hooks"); }
export function writeHookJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function readCodexHookConfig(directory = codexHookDirectory()): CodexHookConfig | null {
  try { return codexHookConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CodexDeliveryError("CODEX_HOOK_CONFIG_INVALID", "gpt-connectorのCodex hook設定を読めません");
  }
}
export function codexInputDirectory(root: string, home: string, thread: string): string {
  z.uuid().parse(thread);
  const hash = createHash("sha256").update(fs.realpathSync(home)).digest("hex");
  return path.join(root, "inputs", hash, thread);
}
export const hookInputSchema = z.object({
  delivery_id: z.uuid(), thread_id: z.uuid(), text_sha256: z.string(),
}).strict();
export function answerDigest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export function registerCodexHookInput(home: string, thread: string, id: string, text: string, root = codexHookDirectory()): void {
  const input = hookInputSchema.parse({ delivery_id: id, thread_id: thread, text_sha256: answerDigest(text) });
  const directory = codexInputDirectory(root, home, thread);
  fs.mkdirSync(path.join(directory, "pending"), { recursive: true, mode: 0o700 });
  // 一つの配送IDを別の本文で再使用しない。送信前の所有記録は再送の指示にはしない。
  fs.writeFileSync(path.join(directory, "pending", `${id}.json`), JSON.stringify(input) + "\n", { flag: "wx", mode: 0o600 });
}
export function finishCodexHookSubmission(home: string, thread: string, id: string, root: string): void {
  const directory = codexInputDirectory(root, home, thread);
  const file = path.join(directory, "settled", `${id}.json`);
  writeHookJson(file, { delivery_id: id });
  if (!fs.existsSync(path.join(directory, "pending", `${id}.json`))) fs.rmSync(file, { force: true });
}
export function codexHookDeliveryState(home: string, thread: string, id: string, root = codexHookDirectory()): "sending" | "unknown" | null {
  if (!fs.existsSync(path.join(root, "inputs"))) return null;
  let directory: string;
  try { directory = codexInputDirectory(root, home, thread); }
  catch (error) {
    // Codex環境の削除・移動で照会できなくても、台帳の回答は回収できる。配送の確定だけを取り消す。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unknown";
    throw error;
  }
  let value: Record<string, unknown>;
  try { value = z.record(z.string(), z.unknown()).parse(JSON.parse(fs.readFileSync(path.join(directory, "claims", `${z.uuid().parse(id)}.json`), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  // 所有権のlinkだけを作った段階では、公式キューからまだ削除していない。
  if (hookInputSchema.safeParse(value).success) return null;
  if (value.state === "unknown") return "unknown";
  if (value.state === "deleting") return readRuntimeProcesses().some(row => row.pid === value.pid && row.started_identity === value.started_identity) ? "sending" : "unknown";
  if (value.state === "emitted" || value.state === "not_in_queue") return null;
  throw new CodexDeliveryError("CODEX_HOOK_STATE_INVALID", "hookの配送状態を読めません");
}

const ownedHookSchema = z.object({
  command: z.string(), sourcePath: z.string(), eventName: z.string(), handlerType: z.string(),
  async: z.boolean().optional(), enabled: z.boolean(), trustStatus: z.string(),
  key: z.string().optional(), currentHash: z.string().nullish(),
}).passthrough();
export function ownedCodexHooks(response: unknown, command: string, file: string): z.infer<typeof ownedHookSchema>[] {
  const parsed = z.object({ data: z.array(z.object({ hooks: z.array(z.record(z.string(), z.unknown())), errors: z.array(z.unknown()).optional() })) }).safeParse(response);
  if (!parsed.success || parsed.data.data.length !== 1 || parsed.data.data[0]?.errors?.length) {
    throw new CodexDeliveryError("CODEX_HOOK_UNAVAILABLE", "公式APIでCodexのhook設定を読めません");
  }
  const source = fs.realpathSync(file);
  const owned = parsed.data.data[0]!.hooks.filter(hook => hook.command === command && hook.sourcePath === source).map(hook => ownedHookSchema.parse(hook));
  for (const event of ["postToolUse", "stop"]) {
    const matches = owned.filter(hook => hook.eventName === event);
    if (matches.length !== 1 || matches[0]!.async || matches[0]!.handlerType !== "command") {
      throw new CodexDeliveryError("CODEX_HOOK_UNAVAILABLE", "gpt-connectorの同期hook登録を確認できません");
    }
  }
  if (owned.length !== 2) throw new CodexDeliveryError("CODEX_HOOK_UNAVAILABLE", "gpt-connectorのhook登録が重複しています");
  return owned;
}
export function assertCodexHooksReady(response: unknown, command: string, file: string): void {
  if (ownedCodexHooks(response, command, file).some(hook => !hook.enabled || !["trusted", "managed"].includes(hook.trustStatus))) {
    throw new CodexDeliveryError("CODEX_HOOK_UNTRUSTED", "gpt-connectorのCodex hookが無効または未承認です。gpt-connector setupを実行してください");
  }
}
export function assertCodexHookParentCurrent(config: CodexHookConfig, rows?: RuntimeProcess[], pid = process.pid): void {
  try { fs.accessSync(config.node, fs.constants.X_OK); fs.accessSync(config.hook, fs.constants.R_OK); }
  catch { throw new CodexDeliveryError("CODEX_HOOK_RUNTIME_UNAVAILABLE", "Codex親hookの実行ファイルを確認できません。gpt-connector setupを実行してください"); }
  if (!config.stale_processes.length) return;
  const processes = new Map((rows ?? readRuntimeProcesses()).map(row => [row.pid, row]));
  const seen = new Set<number>();
  let current = processes.get(pid);
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (config.stale_processes.some(stale => stale.pid === current!.pid && stale.started_identity === current!.started_identity)) {
      throw new CodexDeliveryError("CODEX_STEER_RESTART_REQUIRED", "親のCodexはhookの導入前から動いています。完全終了して再起動してください");
    }
    current = processes.get(current.parent_pid);
  }
}
