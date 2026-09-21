import { createServer, connect } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import { CodexDeliveryError } from "./codex-delivery-error.js";
import { defaultConsultStateDirectory, ensurePrivateDirectory, isWindows } from "./platform/state.js";

export const cursorParentSchema = z.object({
  socketRoot: z.string().refine(isAbsolute),
}).strict();

export type CursorParent = z.infer<typeof cursorParentSchema>;

const deliveryMessageSchema = z.object({
  deliveryId: z.string().uuid(),
  text: z.string().min(1),
  outcome: z.enum(["succeeded", "failed"]),
}).strict();

export type CursorDeliveryMessage = z.infer<typeof deliveryMessageSchema>;

const connectRetryMs = 200;
const defaultReceiveTimeoutMs = 86_400_000;
const defaultSubmitTimeoutMs = 86_400_000;

/** Cursor Desktop / VS Code派生のstdio MCP client名。 */
export function isCursorMcpClient(clientName: string | undefined): boolean {
  if (clientName === undefined) return false;
  return clientName === "cursor-vscode" || clientName.startsWith("cursor-vscode ");
}

export function cursorParentFromRequest(
  clientName: string | undefined,
  stateDirectory = defaultConsultStateDirectory(),
): CursorParent | null {
  if (!isCursorMcpClient(clientName)) return null;
  return { socketRoot: join(stateDirectory, "cp") };
}

export function cursorIpcPath(parent: CursorParent, deliveryId: string): string {
  // macOSのsun_path上限（104）を超えないよう、hyphenなしUUID＋短いrootにする。
  const compact = deliveryId.replaceAll("-", "");
  if (isWindows()) return `\\\\.\\pipe\\gpt-connector-cursor-${compact}`;
  return join(parent.socketRoot, `${compact}.sock`);
}

export function cursorReceiveCommand(
  deliveryId: string,
  stateDirectory: string,
  bin = process.env.GPT_CONNECTOR_BIN ?? "gpt-connector",
): string {
  return `${shellSingleQuote(bin)} cursor-receive --delivery ${deliveryId} --state-directory ${shellSingleQuote(stateDirectory)}`;
}

export async function verifyCursorParent(parent: CursorParent): Promise<void> {
  cursorParentSchema.parse(parent);
  if (!isWindows()) ensurePrivateDirectory(parent.socketRoot);
}

/** MCPがlistenし、受け口が来たら本文を一度だけ書いて閉じる。 */
export async function deliverCursorAnswer(
  parent: CursorParent,
  deliveryId: string,
  text: string,
  options: { timeoutMs?: number; outcome?: "succeeded" | "failed" } = {},
): Promise<void> {
  await verifyCursorParent(parent);
  const path = cursorIpcPath(parent, deliveryId);
  const timeoutMs = options.timeoutMs ?? defaultSubmitTimeoutMs;
  const message = `${JSON.stringify(deliveryMessageSchema.parse({
    deliveryId,
    text,
    outcome: options.outcome ?? "succeeded",
  }))}\n`;

  if (!isWindows()) {
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CodexDeliveryError("Cursor配送socketを準備できません。");
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const server = createServer(socket => {
      socket.write(message, error => {
        socket.end();
        if (error) fail(new CodexDeliveryError("Cursor受け口への書込みに失敗しました。", true));
        else finish();
      });
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => {
        if (!isWindows()) void unlink(path).catch(() => {});
        resolve();
      });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => {
        if (!isWindows()) void unlink(path).catch(() => {});
        reject(error);
      });
    };
    const timer = setTimeout(
      () => fail(new CodexDeliveryError("Cursor受け口が時間内に接続しませんでした。")),
      timeoutMs,
    );
    server.once("error", (error: NodeJS.ErrnoException) => {
      fail(new CodexDeliveryError(
        error.code === "ENAMETOOLONG"
          ? "Cursor配送socketのpathが長すぎます。"
          : "Cursor配送socketを開けません。",
      ));
    });
    server.listen(path, () => {
      if (isWindows()) return;
      void chmod(path, 0o600).catch(() => {
        fail(new CodexDeliveryError("Cursor配送socketの権限を設定できません。"));
      });
    });
  });
}

/** 受け口。MCPのlistenへ接続し、押し込みを1通受け取って返す。 */
export async function receiveCursorAnswer(
  parent: CursorParent,
  deliveryId: string,
  options: { timeoutMs?: number } = {},
): Promise<CursorDeliveryMessage> {
  await verifyCursorParent(parent);
  const path = cursorIpcPath(parent, deliveryId);
  const timeoutMs = options.timeoutMs ?? defaultReceiveTimeoutMs;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      return await readOnce(path, Math.max(1, deadline - Date.now()), deliveryId);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "ECONNABORTED" ||
        code === "EPIPE" ||
        code === "EAGAIN"
      ) {
        if (Date.now() >= deadline) {
          throw new CodexDeliveryError("Cursor配送の受付が時間内に始まりませんでした。");
        }
        await delay(connectRetryMs);
        continue;
      }
      if (error instanceof CodexDeliveryError) throw error;
      throw new CodexDeliveryError("Cursor配送socketへの接続が切れました。", true);
    }
  }
}

function readOnce(path: string, timeoutMs: number, deliveryId: string): Promise<CursorDeliveryMessage> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(
      () => fail(new CodexDeliveryError("Cursor配送の本文が時間内に届きませんでした。")),
      timeoutMs,
    );
    const finish = (value: CursorDeliveryMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = deliveryMessageSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (parsed.deliveryId !== deliveryId) {
          fail(new CodexDeliveryError("Cursor配送IDが一致しません。"));
          return;
        }
        finish(parsed);
      } catch {
        fail(new CodexDeliveryError("Cursor配送本文が不正です。", true));
      }
    });
    socket.on("error", error => fail(error));
    socket.on("end", () => {
      if (settled) return;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        fail(new CodexDeliveryError("Cursor配送socketが本文の前に閉じました。", true));
        return;
      }
      try {
        const parsed = deliveryMessageSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (parsed.deliveryId !== deliveryId) {
          fail(new CodexDeliveryError("Cursor配送IDが一致しません。"));
          return;
        }
        finish(parsed);
      } catch {
        fail(new CodexDeliveryError("Cursor配送本文が不正です。", true));
      }
    });
    socket.on("close", () => {
      if (!settled) fail(new CodexDeliveryError("Cursor配送socketが本文の前に閉じました。", true));
    });
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
