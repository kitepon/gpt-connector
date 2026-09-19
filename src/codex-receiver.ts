import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { packageVersion } from "./version.js";
import { CodexHookError as CodexDeliveryError } from "./codex-delivery-error.js";
import { assertCodexHookParentCurrent, assertCodexHooksReady, codexHookDirectory, finishCodexHookSubmission, readCodexHookConfig, registerCodexHookInput } from "./codex-hook-state.js";

export const realCodexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
export interface CodexReceiverParent { thread_id: string; codex_home: string }
export interface CodexReceiverRuntime { executable: string; args?: string[]; timeout_ms?: number; hook_directory?: string }
export type CodexRequest = (method: string, params: object) => Promise<unknown>;

// 公式CLIを通常stdioで起動する。親Desktopの起動・認証・設定を差し替えない。
export async function withCodexReceiver<T>(parent: CodexReceiverParent, action: (request: CodexRequest) => Promise<T>, runtime?: CodexReceiverRuntime): Promise<T> {
  const config = readCodexHookConfig(runtime?.hook_directory);
  const executable = runtime?.executable ?? config?.binary;
  if (!executable) throw new CodexDeliveryError("CODEX_HOOK_UNAVAILABLE", "gpt-connector setupでCodexの公式hookを導入してください。");
  const child = spawn(executable, runtime?.args ?? ["app-server"], {
    env: { ...process.env, CODEX_HOME: parent.codex_home }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; writing: boolean }>();
  let sequence = 0;
  let failed = false;
  const fail = () => {
    failed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new CodexDeliveryError("CODEX_RECEIVER_TRANSPORT_FAILED", "Codexとの通信が途切れました。送信済み本文は自動再送しません。", item.writing));
    }
    pending.clear();
  };
  child.on("error", fail); child.on("close", fail); child.stdin.on("error", fail);
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  const responseSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
  reader.on("line", line => {
    let message: z.infer<typeof responseSchema>;
    try { message = responseSchema.parse(JSON.parse(line)); } catch { fail(); return; }
    if (message.method !== undefined || typeof message.id !== "number") return;
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new CodexDeliveryError("CODEX_RECEIVER_REJECTED", "Codexが配送要求を拒否しました。"));
    else if (Object.hasOwn(message, "result")) item.resolve(message.result);
    else item.reject(new CodexDeliveryError("CODEX_RECEIVER_INVALID_RESPONSE", "Codexの受付結果を確認できません。", item.writing));
  });
  const request: CodexRequest = (method, params) => new Promise((resolve, reject) => {
    if (failed) { reject(new CodexDeliveryError("CODEX_RECEIVER_TRANSPORT_FAILED", "Codexの公式接続が閉じています。")); return; }
    const id = ++sequence;
    const writing = method === "thread/queue/add";
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CodexDeliveryError("CODEX_RECEIVER_TIMEOUT", "Codexの受付結果が時間内に返りませんでした。", writing));
    }, runtime?.timeout_ms ?? 15_000);
    pending.set(id, { resolve, reject, timer, writing });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "gpt_connector_parent_delivery", version: packageVersion }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return await action(request);
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear(); child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited; clearTimeout(timer); reader.close();
  }
}

export async function verifyCodexQueueParent(parent: CodexReceiverParent, runtime?: CodexReceiverRuntime): Promise<void> {
  const config = readCodexHookConfig(runtime?.hook_directory);
  if (!config?.enabled) throw new CodexDeliveryError("CODEX_HOOK_UNAVAILABLE", "gpt-connector setupでCodexの公式hookを導入してください。");
  if (realpathSync(parent.codex_home) !== realpathSync(config.codex_home)) throw new CodexDeliveryError("CODEX_HOOK_HOME_MISMATCH", "配送先とhook設定のCodex環境が一致しません。");
  assertCodexHookParentCurrent(config);
  await withCodexReceiver(parent, async request => {
    const { thread } = z.object({ thread: z.object({ id: z.string(), cwd: z.string(), source: z.unknown() }) }).parse(await request("thread/read", { threadId: parent.thread_id, includeTurns: false }));
    if (thread.id !== parent.thread_id) throw new CodexDeliveryError("CODEX_PARENT_UNAVAILABLE", "親タスクIDの照合に失敗しました。");
    const source = z.object({ subAgent: z.object({ thread_spawn: z.unknown() }).passthrough() }).safeParse(thread.source);
    if (source.success && Object.hasOwn(source.data.subAgent, "thread_spawn")) throw new CodexDeliveryError("CODEX_PARENT_UNSUPPORTED", "Codexのnative sub-agentへの配送は未対応です。");
    await request("thread/queue/list", { threadId: parent.thread_id, limit: 1 });
    assertCodexHooksReady(await request("hooks/list", { cwds: [thread.cwd] }), config.command, join(parent.codex_home, "hooks.json"));
  }, runtime);
}

export async function submitCodexQueueAnswer(parent: CodexReceiverParent, deliveryId: string, text: string, runtime?: CodexReceiverRuntime): Promise<void> {
  const root = runtime?.hook_directory ?? codexHookDirectory();
  const config = readCodexHookConfig(root);
  if (!config?.enabled) throw new CodexDeliveryError("CODEX_HOOK_UNAVAILABLE", "gpt-connectorのCodex hookが無効です。回答はsessionsで回収できます。");
  if (realpathSync(parent.codex_home) !== realpathSync(config.codex_home)) throw new CodexDeliveryError("CODEX_HOOK_HOME_MISMATCH", "配送先とhook設定のCodex環境が一致しません。");
  registerCodexHookInput(parent.codex_home, parent.thread_id, deliveryId, text, root);
  try {
    await withCodexReceiver(parent, async request => {
      const result = await request("thread/queue/add", { threadId: parent.thread_id, clientUserMessageId: deliveryId, input: [{ type: "text", text, text_elements: [] }] });
      if (!z.object({ queuedSubmission: z.object({ id: z.string().min(1) }) }).safeParse(result).success) {
        throw new CodexDeliveryError("CODEX_RECEIVER_INVALID_RESPONSE", "Codexのキュー受付IDを確認できません。自動再送しません。", true);
      }
    }, runtime);
  } finally { finishCodexHookSubmission(parent.codex_home, parent.thread_id, deliveryId, root); }
}
