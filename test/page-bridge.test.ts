import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  bridgeBuildId,
  createBridgeBootstrapExpression,
  createBridgeCallExpression,
} from "../src/page-bridge.js";

test("同じモデル一覧を返す録音用clientを除き、標準clientだけを選ぶ", async () => {
  const expression = createBridgeBootstrapExpression("core", "conversation", "upload", "shared");
  const start = expression.indexOf("  const apiClientCandidates = ");
  const end = expression.indexOf("  const threadGetter = ", start);
  let unintendedFetches = 0;
  const candidates = [false, true].map(recording => ({
    async safeGet(route: string, options: { overrideBaseUrl?: string; overrideUrl?: (url: URL) => never }) {
      if (route === "/models") return { models: [], default_model_slug: "fixture" };
      const url = new URL(recording && route === "/record" ? "/meetings" : route, options.overrideBaseUrl);
      options.overrideUrl?.(url);
      unintendedFetches++;
      throw new Error("probeから通信してはいけない");
    },
    safePost() {}, safePatch() {}, safeDelete() {},
  }));
  const selected = await vm.runInNewContext(`(async()=>{${expression.slice(start,end)};return apiClient;})()`, {
    shared: { standard: candidates[0], recording: candidates[1] },
    entries: Object.entries, concrete: () => true, location: { origin: "https://chatgpt.com" },
    unique: (_: string, values: [string, unknown][]) => { assert.equal(values.length, 1); return values[0]![1]; },
  });
  assert.equal(selected, candidates[0]);
  assert.equal(unintendedFetches, 0);
});

test("bridgeはDOM selector・event・fiberを利用しない", () => {
  const expression = createBridgeBootstrapExpression(
    "https://cdn.oaistatic.com/assets/core.js",
    "https://cdn.oaistatic.com/assets/conversation.js",
    "https://cdn.oaistatic.com/assets/upload.js",
    "https://cdn.oaistatic.com/assets/shared.js",
  );

  assert.doesNotMatch(expression, /querySelector|__reactFiber|\.click\(|dispatchEvent/u);
  assert.match(expression, /conversationFactory/u);
  assert.match(expression, /requestedModelId/u);
  assert.match(expression, /sessionCount/u);
  assert.match(expression, new RegExp(bridgeBuildId, "u"));
  assert.doesNotThrow(() => new Function(expression));
});

test("sender検出は現行wrapperのfollowup前処理とsettled callbackを固定する", () => {
  const expression = createBridgeBootstrapExpression(
    "https://cdn.oaistatic.com/assets/core.js",
    "https://cdn.oaistatic.com/assets/conversation.js",
    "https://cdn.oaistatic.com/assets/upload.js",
    "https://cdn.oaistatic.com/assets/shared.js",
  );

  assert.match(expression, /promptMessage/u);
  assert.match(expression, /followups_v2_followup_source/u);
  assert.match(expression, /conversational_onboarding_/u);
  assert.match(expression, /onRequestSettled/u);
});

test("builder呼出しはcomposerControllerへ専用objectを渡し拡張slotを空で解決する", () => {
  const expression = createBridgeBootstrapExpression(
    "https://cdn.oaistatic.com/assets/core.js",
    "https://cdn.oaistatic.com/assets/conversation.js",
    "https://cdn.oaistatic.com/assets/upload.js",
    "https://cdn.oaistatic.com/assets/shared.js",
  );

  // builder検出は現行契約どおりcomposerControllerを要求し、変化時はRUNTIME_DRIFTで止まる。
  assert.match(expression, /source\.includes\("composerController"\)/u);
  // 渡す値はWeakMap keyになるため、undefinedでもprimitiveでもないobjectで固定する。
  assert.match(expression, /const composerController = \{\};/u);
  assert.match(expression, /await builder\(\{\s*composerController,/u);
});

test("bridgeは公式upload objectとattachment read-backを一意化する", () => {
  const expression = createBridgeBootstrapExpression(
    "https://cdn.oaistatic.com/assets/core.js",
    "https://cdn.oaistatic.com/assets/conversation.js",
    "https://cdn.oaistatic.com/assets/upload.js",
    "https://cdn.oaistatic.com/assets/shared.js",
  );

  assert.doesNotMatch(expression, /attachments:\s*\[\]/u);
  assert.match(expression, /attachLibraryFile/u);
  assert.match(expression, /createFileCompleted/u);
  assert.match(expression, /uploadCompleted/u);
  assert.match(expression, /uploadFile/u);
  assert.match(expression, /createUpload/u);
  assert.match(expression, /appendUploadChunk/u);
  assert.match(expression, /startUpload/u);
  assert.match(expression, /discardUpload/u);
  assert.match(expression, /attachmentHandles/u);
  assert.match(expression, /ATTACHMENT_READBACK_FAILED/u);
});

test("公式uploadが確定したMIME型を使い、添付identityの食い違いは拒否する", () => {
  const expression = createBridgeBootstrapExpression("core", "conversation", "upload", "shared");
  const start = expression.indexOf("const normalizeUploadedAttachment = ");
  const end = expression.indexOf("const readBackAttachments = ", start);
  const normalize = vm.runInNewContext(`${expression.slice(start, end)}; normalizeUploadedAttachment`);
  const input = { name: "source.ts", size: 42, mimeType: "text/plain" };
  const uploaded = { status: "ready", fileSpec: {
    id: "file-source", name: "source.ts", size: 42, mimeType: "application/javascript",
  } };
  assert.equal(normalize(input, uploaded).mime_type, "application/javascript");
  assert.equal(normalize(input, uploaded).id, "file-source");
  for (const [field, value] of [["id", ""], ["name", "different.ts"], ["size", 43], ["mimeType", ""]] as const) {
    assert.throws(() => normalize(input, { ...uploaded, fileSpec: { ...uploaded.fileSpec, [field]: value } }),
      new RegExp(`RUNTIME_DRIFT:upload_metadata:${field}`));
  }
  assert.throws(() => normalize(input, { ...uploaded, status: "uploading" }), /upload_metadata:status/);
});

test("bridgeは生成画像をcurrent turnとLibraryの二重IDで相関しchunk回収する", () => {
  const expression = createBridgeBootstrapExpression(
    "https://cdn.oaistatic.com/assets/core.js",
    "https://cdn.oaistatic.com/assets/conversation.js",
    "https://cdn.oaistatic.com/assets/upload.js",
    "https://cdn.oaistatic.com/assets/shared.js",
  );

  assert.match(expression, /origination_thread_id/u);
  assert.match(expression, /origination_message_id/u);
  assert.match(expression, /getLastAssistantMessage/u);
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
