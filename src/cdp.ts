import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { ConnectorError } from "./errors.js";

export interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface CdpEvent {
  readonly method: string;
  readonly params?: unknown;
}

interface CdpSuccessResponse {
  readonly id: number;
  readonly result: unknown;
}

interface CdpErrorResponse {
  readonly id: number;
  readonly error: {
    readonly code?: number;
    readonly message?: string;
  };
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export interface CdpSocket {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: WebSocket.RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type CdpEventListener = (event: CdpEvent) => void;

const loopbackHosts = new Set(["127.0.0.1", "[::1]"]);

export function validateCdpEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConnectorError("INVALID_INPUT", "CDP endpointがURLではありません。");
  }

  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new ConnectorError(
      "INVALID_INPUT",
      "CDP endpointはloopback HTTPだけを利用できます。",
    );
  }

  if (url.username !== "" || url.password !== "" || url.pathname !== "/") {
    throw new ConnectorError("INVALID_INPUT", "CDP endpointの形式が不正です。");
  }

  return url;
}

function isCdpTarget(value: unknown): value is CdpTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CdpTarget>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.webSocketDebuggerUrl === "string"
  );
}

export async function discoverChatGptTarget(
  endpoint: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<CdpTarget> {
  const base = validateCdpEndpoint(endpoint);
  const listUrl = new URL("/json/list", base);
  let response: Response;

  try {
    response = await fetchImplementation(listUrl);
  } catch {
    // 接続自体の失敗＝専用Chromeが起動していない（unreachable）。起動中の異常（HTTP error・
    // target形式不正）と区別し、診断がidle（平常）と故障を見分けられるようにする。
    throw new ConnectorError("CDP_UNAVAILABLE", "CDP target一覧へ接続できません。", { unreachable: true });
  }

  if (!response.ok) {
    throw new ConnectorError("CDP_UNAVAILABLE", "CDP target一覧の取得に失敗しました。", {
      status: response.status,
    });
  }

  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) {
    throw new ConnectorError("CDP_UNAVAILABLE", "CDP target一覧の形式が不正です。");
  }

  const targets = raw.filter(isCdpTarget);
  const matches = targets.filter((target) => {
    if (target.type !== "page") return false;
    try {
      return new URL(target.url).origin === "https://chatgpt.com";
    } catch {
      return false;
    }
  });

  if (matches.length === 0) {
    throw new ConnectorError(
      "CDP_UNAVAILABLE",
      "専用ChromeにChatGPT公式page targetがありません。",
    );
  }

  if (matches.length > 1) {
    throw new ConnectorError(
      "CDP_UNAVAILABLE",
      "ChatGPT page targetが複数あります。専用Chromeでは1tabだけ開いてください。",
      { count: matches.length },
    );
  }

  return matches[0]!;
}

export class CdpClient {
  readonly #socket: CdpSocket;
  readonly #defaultTimeoutMs: number;
  readonly #events = new EventEmitter();
  readonly #pending = new Map<number, PendingCall>();
  #sequence = 0;
  #closed = false;

  constructor(socket: CdpSocket, defaultTimeoutMs = 30_000) {
    this.#socket = socket;
    this.#defaultTimeoutMs = defaultTimeoutMs;

    socket.on("message", (data) => {
      this.#handleMessage(data.toString());
    });
    socket.on("close", () => {
      this.#failAll(new ConnectorError("CDP_UNAVAILABLE", "CDP接続が閉じられました。"));
    });
    socket.on("error", () => {
      this.#failAll(new ConnectorError("CDP_UNAVAILABLE", "CDP接続でエラーが発生しました。"));
    });
  }

  static async connect(
    debuggerUrl: string,
    defaultTimeoutMs = 30_000,
  ): Promise<CdpClient> {
    let url: URL;
    try {
      url = new URL(debuggerUrl);
    } catch {
      throw new ConnectorError("CDP_UNAVAILABLE", "debugger WebSocket URLが不正です。");
    }

    if (url.protocol !== "ws:" || !loopbackHosts.has(url.hostname)) {
      throw new ConnectorError(
        "CDP_UNAVAILABLE",
        "debugger WebSocketはloopbackだけを利用できます。",
      );
    }

    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(url, { handshakeTimeout: defaultTimeoutMs });
      candidate.once("open", () => resolve(candidate));
      candidate.once("error", () => {
        reject(new ConnectorError("CDP_UNAVAILABLE", "CDP WebSocketへ接続できません。"));
      });
    });

    return new CdpClient(socket, defaultTimeoutMs);
  }

  onEvent(listener: CdpEventListener): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  call<T>(method: string, params: unknown = {}, timeoutMs = this.#defaultTimeoutMs): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new ConnectorError("CDP_UNAVAILABLE", "閉じたCDP接続は利用できません。"),
      );
    }

    const id = ++this.#sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ConnectorError("CDP_UNAVAILABLE", "CDP呼出しがtimeoutしました。", {
            method,
          }),
        );
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
    this.#failAll(new ConnectorError("CDP_UNAVAILABLE", "CDP接続を終了しました。"));
  }

  #handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message !== "object" || message === null) return;
    const record = message as Partial<CdpSuccessResponse & CdpErrorResponse & CdpEvent>;

    if (typeof record.id === "number") {
      const pending = this.#pending.get(record.id);
      if (pending === undefined) return;
      this.#pending.delete(record.id);
      clearTimeout(pending.timeout);

      if (record.error !== undefined) {
        pending.reject(
          new ConnectorError("CHAT_FAILED", "CDP methodがエラーを返しました。", {
            cdpCode: record.error.code ?? null,
          }),
        );
      } else {
        pending.resolve(record.result);
      }
      return;
    }

    if (typeof record.method === "string") {
      this.#events.emit("event", {
        method: record.method,
        ...(record.params === undefined ? {} : { params: record.params }),
      } satisfies CdpEvent);
    }
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
