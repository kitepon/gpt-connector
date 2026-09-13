import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GptConnector } from "./connector.js";
import {
  chatInputSchema,
  consultInputSchema,
  imageInputSchema,
  sessionsInputSchema,
  type ChatInput,
  type CloseInput,
  type ConnectorDiagnostics,
  type ConsultInput,
  type ImageInput,
  type SessionsInput,
} from "./contract.js";
import { ConsultJobStore } from "./consult-job-store.js";
import { ConnectorError } from "./errors.js";
import { recordRuntimeErrorBestEffort, runtimeErrorStoreDiagnostic } from "./runtime-error-store.js";
import { packageVersion } from "./version.js";

interface ConnectorPort {
  models(): ReturnType<GptConnector["models"]>;
  diagnostics(): ReturnType<GptConnector["diagnostics"]>;
  chat(input: ChatInput): ReturnType<GptConnector["chat"]>;
  consult(input: ConsultInput): ReturnType<GptConnector["consult"]>;
  image(input: ImageInput): ReturnType<GptConnector["image"]>;
  sessions(input: SessionsInput): ReturnType<GptConnector["sessions"]>;
  closeSession(input: CloseInput): ReturnType<GptConnector["closeSession"]>;
  close(): void;
  shutdown(): Promise<void>;
}

type ConnectorFactory = () => Promise<ConnectorPort>;
type ConnectorDoctor = () => Promise<ConnectorDiagnostics>;

export class LazyConnectorHost {
  readonly #endpoint: string;
  readonly #stateDirectory: string | undefined;
  readonly #connect: ConnectorFactory;
  readonly #doctor: ConnectorDoctor;
  #connectorPromise: Promise<ConnectorPort> | null = null;

  constructor(
    endpoint = "http://127.0.0.1:9223",
    stateDirectory?: string,
    connect?: ConnectorFactory,
    doctor?: ConnectorDoctor,
  ) {
    this.#endpoint = endpoint;
    this.#stateDirectory = stateDirectory;
    this.#connect = connect ?? (() => GptConnector.connect({
      endpoint: this.#endpoint,
      stateDirectory: this.#stateDirectory,
    }));
    this.#doctor = doctor ?? (() => GptConnector.doctor({
      endpoint: this.#endpoint,
      stateDirectory: this.#stateDirectory,
      readOnlyJobs: true,
    }));
  }

  get(): Promise<ConnectorPort> {
    this.#connectorPromise ??= this.#connect().catch((error) => {
      this.#connectorPromise = null;
      throw error;
    });
    return this.#connectorPromise;
  }

  async run<T>(action: (connector: ConnectorPort) => Promise<T>): Promise<T> {
    const connectorPromise = this.get();
    let connector: ConnectorPort | undefined;
    try {
      connector = await connectorPromise;
      return await action(connector);
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        error.code === "CDP_UNAVAILABLE" &&
        this.#connectorPromise === connectorPromise
      ) {
        this.#connectorPromise = null;
        try {
          connector?.close();
        } catch {
          // 壊れたtransportの退役失敗で、元のCDP errorを置き換えない。
        }
      }
      throw error;
    }
  }

  async diagnostics(): Promise<ConnectorDiagnostics> {
    if (this.#connectorPromise === null) return this.#doctor();
    try {
      return await this.run((connector) => connector.diagnostics());
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "CDP_UNAVAILABLE") throw error;
      return this.#doctor();
    }
  }

  async shutdown(): Promise<void> {
    if (this.#connectorPromise === null) return;
    try {
      await (await this.#connectorPromise).shutdown();
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "ARCHIVE_FAILED") throw error;
    } finally {
      this.#connectorPromise = null;
    }
  }

  async sessions(input: SessionsInput): Promise<ReturnType<GptConnector["sessions"]>> {
    if (this.#connectorPromise !== null) {
      return (await this.#connectorPromise).sessions(input);
    }
    const store = new ConsultJobStore({
      stateDirectory: this.#stateDirectory,
      readOnly: true,
    });
    await store.initialize();
    try {
      return store.get(sessionsInputSchema.parse(input).slug);
    } finally {
      store.close();
    }
  }
}

export const mcpToolNames = [
  "chatgpt_models",
  "chatgpt_chat",
  "chatgpt_image",
  "chatgpt_close",
  "consult",
  "sessions",
  "diagnostics",
] as const;

export const mcpServerVersion = packageVersion;

const chatgptContextWarning =
  "【警告】呼び出し先のChatGPTには、呼び出し元AIの会話・作業前提・ローカルファイル・リポジトリの知識は自動共有されない。" +
  "前提を知らない相手として、目的・背景・制約と、対象を特定できるGitHub等のURLや必要な資料・コードをpromptまたは添付で明示すること。" +
  "根拠を渡さないと、存在しない仕様やコードを捏造して回答するおそれがある。" +
  "URLの指定だけで内容を読めたとはみなさず、参照できない資料は本文または添付で渡すこと。";

// callerが最初に読む境界宣言。検索索引は否定文も一致させるため、他provider固有名を列挙せず
// 本serverが実行できるChatGPTの肯定能力だけを書く。
export const mcpServerInstructions =
  "このserverはログイン済みOpenAI ChatGPT (consumer Web) 専用のconnectorである。" +
  chatgptContextWarning +
  "通常Chatは「最新」の5段階をlevelで選ぶ。指定がなければ最新スライダーの右端を使う。" +
  "段階名と順序はchatgpt_modelsのlevelsが正。内部model/effortの変換はconnectorが行う。" +
  "ChatGPTへ送る場合: second opinionはconsult、画像生成はchatgpt_imageへcaller既知slug・model・workspaceRoot・outputを渡す。" +
  "caller timeout後は再送せずsessionsで同じslugを確認する。最新の段階と互換model一覧はchatgpt_models、" +
  "既存互換chatはchatgpt_chat、終了はchatgpt_closeを使う。";

export const mcpToolDescriptions = {
  chatgpt_models:
    "通常Chatの「最新」の思考量をWebと同じ名前・順序でlevelsに返す。defaultLevelは右端。互換用のmodel一覧も返す。",
  chatgpt_chat:
    "OpenAI ChatGPT公式Web runtimeの通常Chatへ送信する。levelで最新の段階を選び、省略時は最新の右端。keepOpen=falseなら応答後archiveする。" +
    chatgptContextWarning,
  chatgpt_image:
    "OpenAI ChatGPT通常枠で画像を生成し、Libraryと会話を相関確認してworkspaceRoot配下へno-clobber保存する。slugで冪等化する。" +
    chatgptContextWarning,
  consult:
    "OpenAI ChatGPT公式Web runtimeの通常Chatへ相談する。levelで最新の段階を選び、省略時は最新の右端。filesはworkspaceRoot相対で正規添付し、slugで冪等化する。" +
    chatgptContextWarning,
  sessions:
    "本serverが所有する既知slug 1件の状態・terminal result・errorを返し、再送は行わない。",
  diagnostics:
    "本server自身をread-only診断し、会話やuploadを作らず接続・bridge・job/session件数だけを返す。",
  chatgpt_close:
    "本serverがChatGPT上に開いたprocess内sessionをserver archiveし、opaque handleを破棄する。deleteは行わない。",
} as const;

export function createGptConnectorMcpServer(host: LazyConnectorHost): McpServer {
  const server = new McpServer(
    { name: "gpt-connector", version: mcpServerVersion },
    { instructions: mcpServerInstructions },
  );

  server.registerTool(
    "chatgpt_models",
    {
      title: "ChatGPTの通常Chatモデル一覧",
      description: mcpToolDescriptions.chatgpt_models,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => toolResult(async () => host.run((connector) => connector.models())),
  );

  server.registerTool(
    "chatgpt_chat",
    {
      title: "ChatGPTの通常Chatへ送信",
      description: mcpToolDescriptions.chatgpt_chat,
      inputSchema: chatInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => toolResult(async () => host.run((connector) => connector.chat(input))),
  );

  server.registerTool(
    "chatgpt_image",
    {
      title: "ChatGPTの通常Chatで画像生成",
      description: mcpToolDescriptions.chatgpt_image,
      inputSchema: imageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => toolResult(async () => host.run((connector) => connector.image(input))),
  );

  server.registerTool(
    "consult",
    {
      title: "ChatGPTへ相談",
      description: mcpToolDescriptions.consult,
      inputSchema: consultInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => toolResult(async () => host.run((connector) => connector.consult(input))),
  );

  server.registerTool(
    "sessions",
    {
      title: "ChatGPT相談の状態を回収",
      description: mcpToolDescriptions.sessions,
      inputSchema: sessionsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => toolResult(async () => host.sessions(input)),
  );

  server.registerTool(
    "diagnostics",
    {
      title: "ChatGPT connectorの診断",
      description: mcpToolDescriptions.diagnostics,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => toolResult(async () => host.diagnostics()),
  );

  server.registerTool(
    "chatgpt_close",
    {
      title: "ChatGPTの通常Chat sessionを閉じる",
      description: mcpToolDescriptions.chatgpt_close,
      inputSchema: z.object({ sessionId: z.string().uuid() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => toolResult(async () => host.run((connector) => connector.closeSession(input))),
  );

  return server;
}

async function toolResult(action: () => Promise<unknown>) {
  try {
    const result = await action();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent:
        typeof result === "object" && result !== null ? { ...result } : { value: result },
    };
  } catch (error) {
    const telemetry = error instanceof ConnectorError ? recordRuntimeErrorBestEffort(error.code) : "disabled";
    if (telemetry === "store_unavailable") process.stderr.write(runtimeErrorStoreDiagnostic);
    const body =
      error instanceof ConnectorError
        ? { code: error.code, message: error.message }
        : { code: "CHAT_FAILED", message: "connector operationが失敗しました。" };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      isError: true,
    };
  }
}
