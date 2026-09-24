import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GptConnector } from "./connector.js";
import { GrokConnector } from "./grok-connector.js";
import { connectGrokWithBrowser } from "./grok-connection.js";
import { parentFromRequest } from "./codex-parent.js";
import { cursorParentFromRequest } from "./cursor-parent.js";
import type { DeliveryParent } from "./consult-job-store.js";
import { defaultConsultStateDirectory } from "./platform/state.js";
import { join } from "node:path";
import {
  chatInputSchema,
  consultInputSchema,
  imageInputSchema,
  grokChatInputSchema,
  grokConsultInputSchema,
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
  readonly transportFailed: boolean;
  models(): ReturnType<GptConnector["models"]>;
  diagnostics(): ReturnType<GptConnector["diagnostics"]>;
  chat(input: ChatInput): ReturnType<GptConnector["chat"]>;
  consult(input: ConsultInput, parent?: DeliveryParent): ReturnType<GptConnector["consult"]>;
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

  get stateDirectory(): string {
    return this.#stateDirectory ?? defaultConsultStateDirectory();
  }

  get(): Promise<ConnectorPort> {
    this.#connectorPromise ??= this.#connect().catch((error) => {
      this.#connectorPromise = null;
      throw error;
    });
    return this.#connectorPromise;
  }

  async run<T>(action: (connector: ConnectorPort) => Promise<T>): Promise<T> {
    let connectorPromise = this.get();
    let connector: ConnectorPort | undefined;
    try {
      connector = await connectorPromise;
      if (connector.transportFailed) {
        if (this.#connectorPromise === connectorPromise) {
          // 受付後に失敗した相談の保存と配送を終えてから、次の要求用に接続する。
          const replacement = connector.shutdown().then(() => this.#connect()).catch((error) => {
            if (this.#connectorPromise === replacement) this.#connectorPromise = null;
            throw error;
          });
          this.#connectorPromise = replacement;
        }
        connectorPromise = this.get();
        connector = await connectorPromise;
      }
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

export class LazyGrokConnectorHost {
  readonly #endpoint: string;
  readonly #rootStateDirectory: string;
  readonly #stateDirectory: string;
  #connectorPromise: Promise<GrokConnector> | null = null;

  constructor(endpoint = "http://127.0.0.1:9223", stateDirectory = defaultConsultStateDirectory()) {
    this.#endpoint = endpoint;
    this.#rootStateDirectory = stateDirectory;
    this.#stateDirectory = join(stateDirectory, "grok");
  }

  get stateDirectory(): string { return this.#stateDirectory; }

  #connect(): Promise<GrokConnector> {
    return connectGrokWithBrowser({ endpoint: this.#endpoint, stateDirectory: this.#rootStateDirectory });
  }

  async run<T>(action: (connector: GrokConnector) => Promise<T>): Promise<T> {
    this.#connectorPromise ??= this.#connect().catch((error) => { this.#connectorPromise = null; throw error; });
    let promise = this.#connectorPromise;
    let connector = await promise;
    if (connector.transportFailed) {
      if (this.#connectorPromise === promise) {
        const replacement = connector.shutdown().then(() => this.#connect()).catch((error) => {
          if (this.#connectorPromise === replacement) this.#connectorPromise = null;
          throw error;
        });
        this.#connectorPromise = replacement;
      }
      promise = this.#connectorPromise;
      connector = await promise;
    }
    try { return await action(connector); }
    catch (error) {
      if (error instanceof ConnectorError && error.code === "CDP_UNAVAILABLE" && this.#connectorPromise === promise) {
        connector.close();
        this.#connectorPromise = null;
      }
      throw error;
    }
  }

  async sessions(input: SessionsInput): Promise<ReturnType<GrokConnector["sessions"]>> {
    if (this.#connectorPromise) return (await this.#connectorPromise).sessions(input);
    const store = new ConsultJobStore({ stateDirectory: this.#stateDirectory, readOnly: true });
    await store.initialize();
    try { return store.get(sessionsInputSchema.parse(input).slug); }
    finally { store.close(); }
  }

  async diagnostics(): Promise<Awaited<ReturnType<typeof GrokConnector.doctor>>> {
    if (this.#connectorPromise) {
      try { return await (await this.#connectorPromise).diagnostics(); }
      catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "CDP_UNAVAILABLE") throw error;
        this.#connectorPromise = null;
      }
    }
    return GrokConnector.doctor({ endpoint: this.#endpoint, stateDirectory: this.#rootStateDirectory });
  }

  async shutdown(): Promise<void> {
    if (!this.#connectorPromise) return;
    try { await (await this.#connectorPromise).shutdown(); }
    finally { this.#connectorPromise = null; }
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
  "grok_modes",
  "grok_chat",
  "grok_consult",
  "grok_sessions",
  "grok_diagnostics",
  "grok_close",
] as const;

export const mcpServerVersion = packageVersion;

const chatgptContextWarning =
  "【警告】呼び出し先のChatGPTには、呼び出し元AIの会話・作業前提・ローカルファイル・リポジトリの知識は自動共有されない。" +
  "新規会話では、目的・背景・制約と、対象を特定できるGitHub等のURLや必要な資料・コードをpromptまたは添付で明示すること。" +
  "同じsessionIdでの継続時は、それまでに渡した前提・資料を利用できるため、追加質問と変更点を渡すこと。" +
  "根拠を渡さないと、存在しない仕様やコードを捏造して回答するおそれがある。" +
  "URLの指定だけで内容を読めたとはみなさず、参照できない資料は本文または添付で渡すこと。";

// callerが最初に読む境界宣言。検索索引は否定文も一致させるため、他provider固有名を列挙せず
// 本serverが実行できるChatGPTの肯定能力だけを書く。
export const mcpServerInstructions =
  "このserverはログイン済みChatGPTとGrokのconsumer Web connectorである。" +
  chatgptContextWarning +
  "通常Chatは「最新」の5段階をlevelで選ぶ。指定がなければ最新スライダーの右端を使う。" +
  "段階名と順序はchatgpt_modelsのlevelsが正。内部model/effortの変換はconnectorが行う。" +
  "ChatGPTへ送る場合: second opinionはconsult、画像生成はchatgpt_imageへcaller既知slug・model・workspaceRoot・outputを渡す。" +
  "継続相談はconsultへkeepOpen=true・wait=falseを渡すと、回答完了前の受付時にsessionIdを返す。" +
  "Codex親からのconsultは受付後に戻り、connectorが10秒ごとに完了を監視して親へ自動Steerする。callerは監視ループや同じ相談の再実行を作らない。" +
  "Cursor親からのconsultは受付後に戻り、receiveCommandを背景シェルで回す。connectorが完了時に受け口へ回答を押し込む。callerは監視ループや同じ相談の再実行を作らない。" +
  "他のクライアントではwait=trueで回答を待つか、sessionsで同じslugから取得する。完了後の追加質問は同じsessionId・新しいslug・keepOpen=trueで送る。" +
  "slugは1問い合わせの重複防止ID、sessionIdは複数問い合わせで共有する会話ID。最後はchatgpt_closeで会話を閉じる。" +
  "caller timeout後は再送せずsessionsで同じslugを確認する。最新の段階と互換model一覧はchatgpt_models、" +
  "既存互換chatはchatgpt_chat、終了はchatgpt_closeを使う。" +
  "Grokへ相談する場合はgrok_consult、状態確認はgrok_sessions、追加質問は同じsessionIdと新しいslug、終了はgrok_closeを使う。Grokは本文のみ、modeはauto・fast・expert・heavyから選べる（省略時auto）。";

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
    "keepOpen=trueで会話を保持する。Codex親にはwait指定にかかわらず受付時に戻り、10秒ごとのコード監視で完了時に自動Steerするため、callerの監視ループは不要。配送不可ならChatGPTへの送信前にエラーにする。" +
    "Cursor親にはwait指定にかかわらず受付時に戻り、receiveCommandを返す。callerはそれを背景シェルで回し、完了時にconnectorが受け口へ回答を押し込む。配送不可ならChatGPTへの送信前にエラーにする。" +
    "他のクライアントではwait=falseで受付時のsessionIdを返し、回答はsessions(slug)で取得する。完了後は同じsessionId・新しいslugで追加質問する。継続中はkeepOpen=true、最後はchatgpt_close。" +
    chatgptContextWarning,
  sessions:
    "本serverが所有する既知slug 1件の状態・sessionId・terminal result・errorを返し、再送は行わない。会話の継続はconsultへ同じsessionIdと新しいslugを渡す。",
  diagnostics:
    "本server自身をread-only診断し、会話やuploadを作らず接続・bridge・job/session件数だけを返す。",
  chatgpt_close:
    "本serverがChatGPT上に保持したsessionをserver archiveし、継続用sessionIdを破棄する。MCP再接続後も専用Chromeのpageに会話が残っていれば利用できる。deleteは行わない。",
  grok_modes: "Grok公式Web runtimeのmode一覧と現在選択中のmodeを返す。Chat送信ではauto・fast・expert・heavyから選ぶ。",
  grok_chat: "Grok公式Web runtimeへ本文を送信する。回答にGrokが記録したmodel IDとeffortを返す。auto内の具体モデルは取得できない。keepOpen=trueならsessionIdで継続できる。",
  grok_consult: "Grok公式Web runtimeへ本文で相談する。slugで冪等化し、CodexとCursorの親には完了時に自動配送する。回答に記録されたmodel IDとeffortを返す。添付ファイルには未対応。",
  grok_sessions: "Grok相談の既知slugの状態と回答を返す。再送は行わない。",
  grok_diagnostics: "Grokへの接続、bridge、job件数を診断する。会話は作らない。",
  grok_close: "指定したGrok会話をsoft deleteして継続を終える。",
} as const;

/** Codexは従来どおり。Cursor clientのときだけsocket配送親を返す。 */
export function resolveDeliveryParent(
  clientName: string | undefined,
  metadata: unknown,
  stateDirectory: string,
): DeliveryParent | null {
  const codex = parentFromRequest(clientName, metadata);
  if (codex) return codex;
  return cursorParentFromRequest(clientName, stateDirectory);
}

export function createGptConnectorMcpServer(
  host: LazyConnectorHost,
  resolveParent: (
    clientName: string | undefined,
    metadata: unknown,
  ) => DeliveryParent | null = (name, meta) => resolveDeliveryParent(name, meta, host.stateDirectory),
  grokHost: LazyGrokConnectorHost = new LazyGrokConnectorHost(),
): McpServer {
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
    async (input, extra) => toolResult(async () => {
      const parent = input.dryRun ? null : resolveParent(server.server.getClientVersion()?.name, extra._meta);
      return host.run((connector) => connector.consult(input, parent ?? undefined));
    }),
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

  server.registerTool("grok_modes", {
    title: "Grokのmode一覧", description: mcpToolDescriptions.grok_modes,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => toolResult(async () => grokHost.run((connector) => connector.modes())));

  server.registerTool("grok_chat", {
    title: "Grok Chatへ送信", description: mcpToolDescriptions.grok_chat,
    inputSchema: grokChatInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (input) => toolResult(async () => grokHost.run((connector) => connector.chat(input))));

  server.registerTool("grok_consult", {
    title: "Grokへ相談", description: mcpToolDescriptions.grok_consult,
    inputSchema: grokConsultInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (input, extra) => toolResult(async () => {
    const parent = input.dryRun ? null : resolveDeliveryParent(
      server.server.getClientVersion()?.name, extra._meta, grokHost.stateDirectory,
    );
    return grokHost.run((connector) => connector.consult(input, parent ?? undefined));
  }));

  server.registerTool("grok_sessions", {
    title: "Grok相談の状態を回収", description: mcpToolDescriptions.grok_sessions,
    inputSchema: sessionsInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (input) => toolResult(async () => grokHost.sessions(input)));

  server.registerTool("grok_diagnostics", {
    title: "Grok connectorの診断", description: mcpToolDescriptions.grok_diagnostics,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => toolResult(async () => grokHost.diagnostics()));

  server.registerTool("grok_close", {
    title: "Grok会話を削除して閉じる", description: mcpToolDescriptions.grok_close,
    inputSchema: z.object({ sessionId: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async (input) => toolResult(async () => grokHost.run((connector) => connector.closeSession(input))));

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
