import { createHash } from "node:crypto";
import type { GrokModules } from "./grok-asset-discovery.js";

export const grokBridgeGlobalName = "__gptConnectorGrokBridgeV1";

const bootstrapSource = String.raw`async function(ids, expectedBuildId) {
  const name = "__gptConnectorGrokBridgeV1";
  if (globalThis[name]?.buildId === expectedBuildId) return globalThis[name].summary();
  if (globalThis.__gptConnectorGrokBridgeInit) return globalThis.__gptConnectorGrokBridgeInit;
  globalThis.__gptConnectorGrokBridgeInit = (async () => {
    if (location.origin !== "https://grok.com" || !globalThis.TURBOPACK?.push) {
      throw new Error("RUNTIME_DRIFT:Grok公式runtimeがありません");
    }
    const moduleId = Math.floor(1_000_000_000 + Math.random() * 1_000_000_000);
    let importer;
    await globalThis.TURBOPACK.push(["static/chunks/gpt-connector-grok-" + moduleId + ".js", moduleId, (context) => {
      importer = context.i;
    }]);
    await globalThis.TURBOPACK.push(["static/chunks/gpt-connector-grok-runtime-" + moduleId + ".js", {
      otherChunks: [], runtimeModuleIds: [moduleId]
    }]);
    if (typeof importer !== "function") throw new Error("RUNTIME_DRIFT:Grok module importerがありません");
    const api = importer(ids.api).chatApi;
    const responseStore = importer(ids.responseStore).useResponseStore;
    const conversationStore = importer(ids.conversationStore).useConversationStore;
    const modesStore = importer(ids.modesStore).useModesStore;
    const chatPageStore = importer(ids.chatPageStore).useChatPageStore;
    if (typeof api?.chatListResponses !== "function" ||
        typeof api?.chatGetConversation !== "function" ||
        typeof api?.chatSoftDeleteConversation !== "function" ||
        typeof responseStore?.getState()?.streamCreateAndRespond !== "function" ||
        typeof responseStore?.getState()?.streamResponse !== "function" ||
        typeof conversationStore?.getState()?.upsertAndCacheConversation !== "function" ||
        typeof modesStore?.getState()?.ensureLoaded !== "function" ||
        typeof chatPageStore?.getState()?.activeModelId !== "string") {
      throw new Error("RUNTIME_DRIFT:Grok runtime roleが一致しません");
    }
    const operations = new Map();
    const busySessions = new Set();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const assertUuid = (value) => typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

    async function readBack(conversationId, responseIds, expectedPrompt) {
      if (!assertUuid(conversationId) || responseIds.length === 0) {
        throw new Error("STREAM_INCOMPLETE:Grok回答IDを確認できません");
      }
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const data = await api.chatListResponses({ conversationId });
        const server = Array.isArray(data?.responses) ? data.responses : null;
        if (!server) throw new Error("RUNTIME_DRIFT:Grok回答一覧の形式が変わりました");
        const matched = server.filter((item) =>
          responseIds.includes(item.responseId) && item.sender === "ASSISTANT" &&
          typeof item.message === "string" && item.message.length > 0);
        const parent = matched[0] && server.find((item) => item.responseId === matched[0].parentResponseId);
        if (matched.length === 1 && parent?.sender === "human" && parent.message === expectedPrompt) {
          const metadata = matched[0].requestMetadata;
          return { text: matched[0].message,
            reportedModel: typeof metadata?.model === "string" ? metadata.model : null,
            resolvedEffort: typeof metadata?.effort === "string" ? metadata.effort.toLowerCase() : null };
        }
        await sleep(500);
      }
      throw new Error("STREAM_INCOMPLETE:Grok回答をサーバーから照合できません");
    }

    async function execute(input, operation) {
      await modesStore.getState().ensureLoaded();
      if (modesStore.getState().selectedModeId !== "auto") {
        throw new Error("MODEL_NOT_AVAILABLE:Grok専用tabのmodeを自動にしてください");
      }
      const modelName = chatPageStore.getState().activeModelId;
      if (!modelName) throw new Error("RUNTIME_DRIFT:Grokのmodel IDがありません");
      const oldId = input.sessionId;
      let conversationId = oldId;
      const closedIds = [];
      let streamError = null;
      const callbacks = {
        onOptimisticConversation() {}, onOptimisticResponse() {}, onOptimisticModelResponse() {},
        onStart() {}, onUserResponse() {},
        onStartExperiment() {}, onRealResponseId() {}, onCitations() {}, onDisclaimer() {},
        onHasImage() {}, onSideBySideConfig() {}, onSurvey() {}, onThrottle() {},
        onWke(error) { streamError = error; },
        onError() { return false; },
        onClose(values) {
          for (const value of values ?? []) {
            if (value?.state === "closed" && assertUuid(value.responseId)) closedIds.push(value.responseId);
          }
        },
      };
      if (oldId) {
        let conversation;
        try { conversation = await api.chatGetConversation({ conversationId: oldId }); }
        catch (error) {
          if (error?.status === 404 || error?.response?.status === 404) {
            throw new Error("SESSION_NOT_FOUND:Grok会話が見つかりません");
          }
          throw error;
        }
        if (conversation?.conversationId !== oldId) throw new Error("SESSION_NOT_FOUND:Grok会話が見つかりません");
        conversationStore.getState().upsertAndCacheConversation(conversation);
        const history = await api.chatListResponses({ conversationId: oldId });
        const parent = history?.responses?.filter((item) => item.sender === "ASSISTANT").at(-1);
        if (!assertUuid(parent?.responseId)) throw new Error("SESSION_NOT_FOUND:Grok会話に継続できる回答がありません");
        operation.sessionId = oldId;
        await responseStore.getState().streamResponse({
          message: input.prompt, conversationId: oldId, parentResponseId: parent.responseId,
          modelName, modelMode: "auto", ff: {}, requestType: "followup",
          onOptimisticUserResponse() {}, onOptimisticModelResponse() {},
          ...callbacks,
        });
      } else {
        await responseStore.getState().streamCreateAndRespond({
          temporary: !input.keepOpen, message: input.prompt,
          modelName, modelMode: "auto", ff: {}, requestType: "new_chat",
          ...callbacks,
          onConversation(value) {
            conversationId = value?.conversationId;
            if (assertUuid(conversationId)) operation.sessionId = conversationId;
          },
        });
      }
      if (streamError) throw streamError;
      const read = await readBack(conversationId, closedIds, input.prompt);
      operation.result = {
        text: read.text, status: "finished_successfully", endTurn: true,
        requestedMode: "auto", reportedModel: read.reportedModel,
        resolvedModel: null, resolvedEffort: read.resolvedEffort,
        ...(input.keepOpen ? { sessionId: conversationId } : {}),
        attachments: { count: 0, names: [], mimeTypes: [], readBack: "confirmed",
          retention: "unknown", cleanup: "not_supported" },
        archived: false,
      };
      operation.state = "succeeded";
    }

    const bridge = {
      version: 1, buildId: expectedBuildId,
      summary() { return { version: 1, buildId: expectedBuildId, ready: true }; },
      async auth() {
        try {
          const data = await api.chatListConversations({ pageSize: 1 });
          return { authenticated: Array.isArray(data?.conversations) };
        } catch (error) {
          const status = error?.status ?? error?.response?.status;
          if (status === 401 || status === 403) return { authenticated: false };
          throw error;
        }
      },
      async modes() {
        await modesStore.getState().ensureLoaded();
        const state = modesStore.getState();
        if (state.status !== "ready" || !Array.isArray(state.modes)) {
          throw new Error("RUNTIME_DRIFT:Grok mode一覧がありません");
        }
        return { defaultMode: state.defaultModeId, selectedMode: state.selectedModeId,
          modes: state.modes.map((mode) => ({ id: mode.id, title: mode.title,
            available: Boolean(mode.availability?.available) })) };
      },
      startChat(input) {
        if (typeof input?.prompt !== "string" || !input.prompt ||
            (input.sessionId && !assertUuid(input.sessionId))) {
          throw new Error("INVALID_INPUT:Grok chat入力が不正です");
        }
        const operationId = crypto.randomUUID();
        const operation = { state: "pending", sessionId: null,
          result: null, error: null };
        operations.set(operationId, operation);
        if (input.sessionId && busySessions.has(input.sessionId)) {
          operation.state = "failed";
          operation.error = { code: "SESSION_BUSY", message: "Grok会話は別turnを処理中です" };
          return { operationId };
        }
        if (input.sessionId) busySessions.add(input.sessionId);
        void execute(input, operation).catch((error) => {
          const message = String(error?.message ?? "");
          const code = /^(SESSION_NOT_FOUND|STREAM_INCOMPLETE|RUNTIME_DRIFT|MODEL_NOT_AVAILABLE|CHAT_FAILED):/.exec(message)?.[1] ?? "CHAT_FAILED";
          const descriptions = {
            SESSION_NOT_FOUND: "Grok会話が見つかりません。",
            STREAM_INCOMPLETE: "Grok回答をサーバーから照合できませんでした。",
            RUNTIME_DRIFT: "Grok Web runtimeの形式が変わりました。",
            MODEL_NOT_AVAILABLE: "Grok専用tabのmodeを自動にしてください。",
            CHAT_FAILED: "Grok Chatが失敗しました。"
          };
          operation.error = { code, message: descriptions[code] };
          operation.state = "failed";
        }).finally(() => { if (input.sessionId) busySessions.delete(input.sessionId); });
        return { operationId };
      },
      poll(operationId, consume) {
        const operation = operations.get(operationId);
        if (!operation) throw new Error("RUNTIME_DRIFT:Grok operationが見つかりません");
        const envelope = { ...operation };
        if (consume && operation.state !== "pending") operations.delete(operationId);
        return envelope;
      },
      async close(sessionId) {
        if (!assertUuid(sessionId)) throw new Error("INVALID_INPUT:Grok sessionIdが不正です");
        if (busySessions.has(sessionId)) throw new Error("SESSION_BUSY:Grok会話は別turnを処理中です");
        const conversation = await api.chatGetConversation({ conversationId: sessionId });
        if (conversation?.conversationId !== sessionId) throw new Error("SESSION_NOT_FOUND:Grok会話が見つかりません");
        await api.chatSoftDeleteConversation({ conversationId: sessionId });
        return { deleted: true };
      },
      diagnostics() { return { operationCount: operations.size, sessionCount: busySessions.size }; },
    };
    globalThis[name] = bridge;
    return bridge.summary();
  })();
  try { return await globalThis.__gptConnectorGrokBridgeInit; }
  finally { delete globalThis.__gptConnectorGrokBridgeInit; }
}`;

export const grokBridgeBuildId = createHash("sha256").update(bootstrapSource).digest("hex").slice(0, 16);

export function createGrokBridgeBootstrapExpression(ids: GrokModules): string {
  return `(${bootstrapSource})(${JSON.stringify(ids)},${JSON.stringify(grokBridgeBuildId)})`;
}

export function createGrokBridgeCallExpression(method: string, args: readonly unknown[]): string {
  return `globalThis[${JSON.stringify(grokBridgeGlobalName)}].${method}(...${JSON.stringify(args)})`;
}
