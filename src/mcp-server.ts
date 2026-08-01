import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GptConnector } from "./connector.js";
import {
  chatgptEffortFieldDescription,
  chatgptModelFieldDescription,
  consultInputSchema,
  imageInputSchema,
  sessionsInputSchema,
  type ChatInput,
  type CloseInput,
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

export class LazyConnectorHost {
  readonly #endpoint: string;
  readonly #stateDirectory: string | undefined;
  readonly #connect: ConnectorFactory;
  #connectorPromise: Promise<ConnectorPort> | null = null;

  constructor(
    endpoint = "http://127.0.0.1:9223",
    stateDirectory?: string,
    connect?: ConnectorFactory,
  ) {
    this.#endpoint = endpoint;
    this.#stateDirectory = stateDirectory;
    this.#connect = connect ?? (() => GptConnector.connect({
      endpoint: this.#endpoint,
      stateDirectory: this.#stateDirectory,
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

// callerが最初に読む境界宣言。provider scopeを先頭へ置かないと、tool名が中立な
// consult／sessions／diagnosticsが「別modelへ相談する」全般を吸い込み、
// Claude・Gemini等を使う場面で誤って本serverが呼ばれる。
export const mcpServerInstructions =
  "このserverはログイン済みOpenAI ChatGPT (consumer Web) 専用のconnectorである。" +
  "実行できるのはChatGPT accountで利用可能なmodelだけで、Anthropic Claude (Fable、Opus、Sonnet、Haiku)、" +
  "Google Gemini、その他providerのmodelは呼べない。ChatGPT以外のmodelを使うことが目的なら、" +
  "tool名が用途に近く見えても本serverのtoolを呼ばず、caller側の当該provider経路を使う。" +
  "ChatGPTへ送る場合: second opinionはconsult、画像生成はchatgpt_imageへcaller既知slug・model・workspaceRoot・outputを渡す。" +
  "caller timeout後は再送せずsessionsで同じslugを確認する。live model/effortはchatgpt_models、" +
  "既存互換chatはchatgpt_chat、終了はchatgpt_closeを使う。";

export function createGptConnectorMcpServer(host: LazyConnectorHost): McpServer {
  const server = new McpServer(
    { name: "gpt-connector", version: mcpServerVersion },
    { instructions: mcpServerInstructions },
  );

  server.registerTool(
    "chatgpt_models",
    {
      title: "ChatGPTの通常Chatモデル一覧",
      description:
        "ログイン中のOpenAI ChatGPT accountで利用可能な通常Chat modelとthinking effortを返す。" +
        "返るのはChatGPTのmodelだけで、Claudeなど他providerのmodelは含まない。",
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
      description:
        "OpenAI ChatGPT公式Web runtimeの通常ChatへUIなしで送信する。送信先はChatGPTのmodelに限られ、" +
        "Claudeなど他providerのmodelへは送れない。keepOpen=falseなら応答後archiveする。",
      inputSchema: z
        .object({
          prompt: z.string().min(1),
          model: z.string().min(1).optional().describe(chatgptModelFieldDescription),
          effort: z.string().min(1).optional().describe(chatgptEffortFieldDescription),
          sessionId: z.string().uuid().optional(),
          keepOpen: z.boolean().default(false),
        })
        .strict(),
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
      description:
        "OpenAI ChatGPT通常枠の画像生成ツールで画像を生成し、Libraryと会話を相関確認してworkspaceRoot配下へno-clobber保存する。" +
        "slugで冪等化する。ChatGPT以外の画像生成provider（Gemini等）は扱えない。",
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
      description:
        "OpenAI ChatGPT公式Web runtimeへ相談する。相談先はChatGPTのmodelに固定されており、" +
        "Claude・Gemini等へのsecond opinionには使えない（そちらはcaller側の当該provider経路を使う）。" +
        "filesはworkspaceRoot相対で正規添付し、slugで冪等化する。",
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
      description:
        "本server (ChatGPT connector) が持つ既知slug 1件の状態・terminal result・errorを返し、再送は行わない。" +
        "他providerやcaller側の会話履歴は扱わない。",
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
      description:
        "本server (ChatGPT connector) 自身の診断。会話やuploadを作らず、接続・bridge・job/session件数だけを返す。" +
        "caller側の環境や他providerの状態は診断しない。",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => toolResult(async () => host.run((connector) => connector.diagnostics())),
  );

  server.registerTool(
    "chatgpt_close",
    {
      title: "ChatGPTの通常Chat sessionを閉じる",
      description:
        "本serverがChatGPT上に開いたprocess内sessionをserver archiveし、opaque handleを破棄する。deleteは行わない。",
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
