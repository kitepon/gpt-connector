import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  bridgeBuildId,
  createBridgeBootstrapExpression,
  createBridgeCallExpression,
  createSingleFlightBootstrapExpression,
} from "../src/page-bridge.js";

test("同時接続はpage bridgeを一度だけ初期化する", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const context = vm.createContext({ starts: 0, gate });
  const expression = createSingleFlightBootstrapExpression("__testBootstrap", "(async () => { globalThis.starts += 1; await gate; return { ready: true }; })()");
  const first = vm.runInContext(expression, context);
  const second = vm.runInContext(expression, context);
  assert.equal(context.starts, 1);
  finish();
  assert.equal((await first).ready, true);
  assert.equal((await second).ready, true);
  assert.equal(vm.runInContext("globalThis.__testBootstrap", context), undefined);
});

test("bridgeは画面のDOMやReact内部に触れず現行runtimeを使う", () => {
  const expression = createBridgeBootstrapExpression("https://chatgpt.com/cdn/assets/runtime.js");
  assert.doesNotMatch(expression, /querySelector|__reactFiber|\.click\(|dispatchEvent/u);
  assert.match(expression, /__webpack_require__/u);
  assert.match(expression, /AppScope/u);
  assert.match(expression, /conversationMode: "primary_assistant"/u);
  assert.match(expression, /onServerThreadIdChange/u);
  assert.match(expression, /sessionCount/u);
  assert.match(expression, new RegExp(bridgeBuildId, "u"));
  assert.doesNotThrow(() => new Function(expression));
  // 内部関数の検出は圧縮後の変数名に依存しない（2026-09末の更新で変数名が入れ替わった）。
  assert.doesNotMatch(expression, /"watch=s"|"n=\{toString:\(\)=>r\}"|"return n\?n\(\)"/u);
});

test("archiveのHTTP失敗は回答失敗に分類せず、段階とstatusを保持する", async () => {
  const expression = createBridgeBootstrapExpression("runtime");
  const start = expression.indexOf("const archive = ");
  const end = expression.indexOf("const startOperation = ", start);
  const errorHelpers = expression.slice(expression.indexOf("const knownErrorCodes = "), expression.indexOf("const clearChunks = "));
  for (const method of ["safePatch", "safeGet"] as const) for (const status of [500, 401]) {
    const apiClient = {
      safePatch: async () => {},
      safeGet: async () => ({ is_archived: true }),
    };
    apiClient[method] = async () => { throw Object.assign(new Error("Something went wrong."), { response: { status } }); };
    const archive = vm.runInNewContext(`${errorHelpers}; ${expression.slice(start, end)}; archive`, {
      apiClient, serverIdOf: () => "test-conversation",
    });
    await assert.rejects(archive({}), new RegExp(`${status === 500 ? "ARCHIVE_FAILED" : "AUTH_REQUIRED"}:.*HTTP ${status}.*Something went wrong\\.`, "u"));
  }
});

function terminalTurnWaiter(serverReplies: (read: number) => unknown) {
  const expression = createBridgeBootstrapExpression("runtime");
  const code = expression.slice(expression.indexOf("const readTerminalMessage = "), expression.indexOf("const extractResult = "));
  let reads = 0;
  const apiClient = { safeGet: async () => serverReplies(++reads) };
  // 待機を即時に進める。
  const setTimeout = (resolve: () => void) => { queueMicrotask(resolve); return 0; };
  const wait = vm.runInNewContext(`${code}; waitForTerminalTurn`, { apiClient, setTimeout }) as
    (conversation: object, status: () => string | null, failure: () => Error | null, imageMode: boolean) => Promise<void>;
  return { wait, reads: () => reads };
}

const finished = (id: string) => ({ mapping: { a: { message: {
  id, author: { role: "assistant" }, create_time: 10, status: "finished_successfully", end_turn: true,
} } } });

test("通常Chatは完了通知が来なくても打ち切らず、サーバーの終端メッセージで回答を拾う", async () => {
  // 旧実装の上限（660回）を超えた15回目の照合で初めて終端メッセージが見える。
  const { wait, reads } = terminalTurnWaiter(read => read < 15 ? { mapping: {} } : finished("answer"));
  const conversation = { serverId: "server-1", parentMessageId: "user-1", lastMessage: null } as Record<string, unknown>;
  await wait(conversation, () => null, () => null, false);
  assert.equal(reads(), 15);
  assert.equal((conversation.lastMessage as { id: string }).id, "answer");
  assert.equal(conversation.parentMessageId, "answer");
});

test("待機中にサーバーが失敗を記録したら止め、画像は従来どおり打ち切る", async () => {
  const failedTurn = { mapping: { a: { message: { id: "x", author: { role: "assistant" }, create_time: 10, status: "failed" } } } };
  const failing = terminalTurnWaiter(() => failedTurn);
  await assert.rejects(failing.wait({ serverId: "server-1", lastMessage: null }, () => null, () => null, false), /CHAT_FAILED:assistant_message_failed/u);
  const image = terminalTurnWaiter(() => ({ mapping: {} }));
  await assert.rejects(image.wait({ serverId: "server-1", lastMessage: null }, () => null, () => null, true), /STREAM_INCOMPLETE:terminal_turn_not_observed/u);
  assert.equal(image.reads(), 0);
});

test("添付は公式アップロードの結果を会話へ渡して読戻す", () => {
  const expression = createBridgeBootstrapExpression("https://chatgpt.com/cdn/assets/runtime.js");
  assert.match(expression, /process_upload_stream/u);
  assert.match(expression, /uploadClient\(scope, file/u);
  assert.match(expression, /attachments,/u);
  assert.match(expression, /ATTACHMENT_READBACK_FAILED/u);
});

test("公式uploadの添付情報に食い違いがあれば止める", () => {
  const expression = createBridgeBootstrapExpression("https://chatgpt.com/cdn/assets/runtime.js");
  const start = expression.indexOf("const normalizeUploadedAttachment = ");
  const end = expression.indexOf("const readBackAttachments = ", start);
  const normalize = vm.runInNewContext(`${expression.slice(start, end)}; normalizeUploadedAttachment`);
  const input = { name: "source.ts", size: 42, mimeType: "text/plain" };
  const uploaded = { id: "file-source", name: "source.ts", size: 42, mimeType: "application/javascript" };
  assert.equal(normalize(input, uploaded).mime_type, "application/javascript");
  for (const [field, value] of [["id", ""], ["name", "different.ts"], ["size", 43], ["mimeType", ""]] as const) {
    assert.throws(() => normalize(input, { ...uploaded, [field]: value }), /RUNTIME_DRIFT:upload_metadata/u);
  }
});

test("bridgeは生成画像をcurrent turnとLibraryの二重IDで相関しchunk回収する", () => {
  const expression = createBridgeBootstrapExpression("https://chatgpt.com/cdn/assets/runtime.js");

  assert.match(expression, /origination_thread_id/u);
  assert.match(expression, /origination_message_id/u);
  assert.match(expression, /turn_exchange_id/u);
  assert.match(expression, /working_turn_id/u);
  assert.match(expression, /image_asset_pointer/u);
  assert.match(expression, /IMAGE_NOT_GENERATED/u);
  assert.match(expression, /readDownloadChunk/u);
  assert.match(expression, /discardDownload/u);
  assert.match(expression, /softDeleteDownloadSource/u);
  assert.match(expression, /soft_delete:\s*true/u);
  assert.doesNotMatch(expression, /items\?\.\[0\]|items\[0\]/u);
});

test("asset discoveryもUI selectorへ依存しない", async () => {
  const source = await import("../src/asset-discovery.js");
  assert.doesNotMatch(source.listLoadedAssetUrls.toString(), /querySelector|__reactFiber/u);
});

test("bridge callはupload methodの引数をJSONとして閉じ込める", () => {
  let captured: unknown;
  const expression = createBridgeCallExpression("startUpload", [
    { name: "`);globalThis.pwned=true;//" },
  ]);
  const context = {
    __gptConnectorBridgeV1: {
      startUpload: (input: unknown) => {
        captured = input;
      },
    },
  };

  vm.runInNewContext(expression, context);
  assert.equal(
    (captured as { name?: unknown } | undefined)?.name,
    "`);globalThis.pwned=true;//",
  );
  assert.equal("pwned" in context, false);
});
