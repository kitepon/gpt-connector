import { isAbsolute } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { ConnectorError } from "./errors.js";
import { packageVersion } from "./version.js";
import { processSocket, readCodexProcesses, verifyRelaySocket, type CodexProcess } from "./codex-steer-config.js";
import { parentSocketForPlatform, codexSocketConnection } from "./platform/codex.js";

export const codexParentSchema = z.object({ threadId: z.string().uuid(), socketPath: z.string().refine(isAbsolute) }).strict();
export type CodexParent = z.infer<typeof codexParentSchema>;

export class CodexDeliveryError extends ConnectorError {
  constructor(message: string, readonly outcomeUnknown = false) {
    super(outcomeUnknown ? "PARENT_DELIVERY_UNKNOWN" : "PARENT_DELIVERY_UNAVAILABLE", message);
  }
}

/** 宛先はCodexが付けた要求metadataと、同じ親processの公式受付だけから取得する。 */
export function parentFromRequest(clientName: string | undefined, metadata: unknown): CodexParent | null {
  if (clientName !== "codex-mcp-client") return null;
  const parsed = z.object({ threadId: z.string().uuid() }).safeParse(metadata);
  if (!parsed.success) throw new CodexDeliveryError("CodexのMCP要求に親タスクIDがありません。対応するCodexを使ってください。");
  return { threadId: parsed.data.threadId, socketPath: parentSocketForPlatform(() => findParentSocket(readCodexProcesses(), process.pid)) };
}

export function findParentSocket(processes: readonly CodexProcess[], pid: number): string {
  const rows = new Map(processes.map(row => [row.pid, row]));
  const seen = new Set<number>();
  let parent = rows.get(pid)?.parent_pid;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const row = rows.get(parent);
    const socket = row && processSocket(row);
    if (socket) {
      try { verifyRelaySocket(socket); return socket; } catch {
        throw new CodexDeliveryError("親CodexのSteer socketを確認できません。");
      }
    }
    parent = row?.parent_pid;
  }
  throw new CodexDeliveryError("親CodexのSteer接続がありません。gpt-connector setup --codex-steer enableを実行し、Codexを再起動してください。");
}

type Request = (method: string, params: unknown) => Promise<unknown>;

/** 追加clientは承認要求や通知に応答せず、公式App ServerへRPCを送るだけとする。 */
export async function withCodexParent<T>(parent: CodexParent, action: (request: Request) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  return withCodexSocket(parent.socketPath, action, timeoutMs);
}

export async function withCodexSocket<T>(socketPath: string, action: (request: Request) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  let connection: ReturnType<typeof codexSocketConnection>;
  try { connection = codexSocketConnection(socketPath); } catch (error) {
    if (error instanceof CodexDeliveryError) throw error;
    throw new CodexDeliveryError("CodexのSteer socketへ接続できません。");
  }
  const socket = new WebSocket(connection.url, {
    ...connection.options, handshakeTimeout: timeoutMs, perMessageDeflate: false,
  });
  let sequence = 0;
  let failed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; writing: boolean }>();
  const fail = () => {
    failed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new CodexDeliveryError("Codexとの通信が途切れました。送信済み本文は自動再送しません。", item.writing));
    }
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", fail);
  socket.on("message", (bytes, binary) => {
    const parsed = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
    let response: z.infer<typeof parsed>;
    try { if (binary) throw new Error(); response = parsed.parse(JSON.parse(bytes.toString())); } catch { fail(); return; }
    if (response.method !== undefined || typeof response.id !== "number") return;
    const item = pending.get(response.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(response.id);
    if (response.error) item.reject(new CodexDeliveryError("Codexが配送要求を拒否しました。"));
    else if ("result" in response) item.resolve(response.result);
    else item.reject(new CodexDeliveryError("Codexの受付結果を確認できません。", item.writing));
  });
  const request: Request = (method, params) => new Promise((resolve, reject) => {
    if (failed || socket.readyState !== WebSocket.OPEN) { reject(new CodexDeliveryError("CodexのSteer接続が閉じています。")); return; }
    const id = ++sequence;
    const writing = method === "turn/start";
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CodexDeliveryError("Codexの受付結果が時間内に返りませんでした。", writing));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, writing });
    socket.send(JSON.stringify({ id, method, params }), error => { if (error) fail(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new CodexDeliveryError("CodexのSteer接続を開けません。")));
      socket.once("close", () => reject(new CodexDeliveryError("CodexがSteer接続を閉じました。")));
    });
    await request("initialize", { clientInfo: { name: "gpt_connector_parent_delivery", version: packageVersion } });
    socket.send(JSON.stringify({ method: "initialized" }));
    return await action(request);
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    socket.terminate();
  }
}

async function verifyLoaded(request: Request, threadId: string): Promise<void> {
  let cursor: string | null = null;
  do {
    const result = z.object({ data: z.array(z.string()), nextCursor: z.string().nullable().optional() }).parse(
      await request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) }));
    if (result.data.includes(threadId)) {
      const result = z.object({ thread: z.object({ id: z.string(), source: z.unknown() }) }).parse(
        await request("thread/read", { threadId, includeTurns: false }));
      if (result.thread.id !== threadId) throw new CodexDeliveryError("親タスクIDの照合に失敗しました。");
      const source = result.thread.source as { subAgent?: { thread_spawn?: unknown } } | null;
      if (source?.subAgent && "thread_spawn" in source.subAgent) throw new CodexDeliveryError("Codexのnative sub-agentへはSteer配送できません。");
      return;
    }
    const next = result.nextCursor ?? null;
    if (next !== null && next === cursor) throw new CodexDeliveryError("Codexのタスク一覧の続きが不正です。");
    cursor = next;
  } while (cursor);
  throw new CodexDeliveryError("同じApp Serverに親タスクがありません。別processでの再開やキューへの退避は行いません。");
}

export async function verifyCodexParent(parent: CodexParent): Promise<void> {
  await withCodexParent(parent, request => verifyLoaded(request, parent.threadId));
}

export async function deliverCodexAnswer(parent: CodexParent, deliveryId: string, text: string): Promise<void> {
  await withCodexParent(parent, async request => {
    await verifyLoaded(request, parent.threadId);
    // 公式の同一処理内で実行中はSteer、終了後は開始する。状態による分岐と二重送信を作らない。
    const result = await request("turn/start", { threadId: parent.threadId, clientUserMessageId: deliveryId,
      input: [{ type: "text", text, text_elements: [] }] });
    if (!z.object({ turn: z.object({ id: z.string().min(1) }) }).safeParse(result).success) {
      throw new CodexDeliveryError("Codexの受付IDが不明です。回答は保存済みで、自動再送しません。", true);
    }
  });
}
