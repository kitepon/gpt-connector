import assert from "node:assert/strict";
import test from "node:test";

import { discoverRuntimeAssets } from "../src/asset-discovery.js";
import { ConnectorError } from "../src/errors.js";

const origin = "https://cdn.oaistatic.com";
const rootUrl = `${origin}/assets/bootstrap.js`;
const coreUrl = `${origin}/assets/core.js`;
const conversationUrl = `${origin}/cdn/assets/conversation.js`;
const uploadUrl = `${origin}/assets/upload.js`;
const sharedUrl = `${origin}/assets/shared.js`;

const coreSource = [
  'import "./upload.js";',
  'import "./shared.js";',
  "/f/conversation/prepare conduit_token completion.submit.request",
].join(" ");
const conversationSource = "contentToSend allSystemHints selectedSkillIds build_request_params.prompt_message";
const uploadSource = "process_upload_stream attachLibraryFile uploadFile:async";
const sharedSource = "setServerIdForNewThread initThread getLastAssistantMessage";

function fetchFrom(sources: ReadonlyMap<string, string>): typeof fetch {
  return async (input) => {
    const source = sources.get(String(input));
    return new Response(source ?? "", { status: source === undefined ? 404 : 200 });
  };
}

function baseSources(): Map<string, string> {
  return new Map([
    [rootUrl, 'import "./core.js"; import "/cdn/assets/conversation.js";'],
    [coreUrl, coreSource],
    [conversationUrl, conversationSource],
    [uploadUrl, uploadSource],
    [sharedUrl, sharedSource],
  ]);
}

test("初期rootから相対・root-relative importを再帰探索して3 roleを一意に分類する", async () => {
  const result = await discoverRuntimeAssets([rootUrl], fetchFrom(baseSources()));

  assert.equal(result.coreUrl, coreUrl);
  assert.equal(result.conversationUrl, conversationUrl);
  assert.equal(result.uploadUrl, uploadUrl);
  assert.equal(result.sharedUrl, sharedUrl);
  assert.match(result.coreFingerprint, /^[0-9a-f]{16}$/u);
  assert.match(result.conversationFingerprint, /^[0-9a-f]{16}$/u);
  assert.match(result.uploadFingerprint, /^[0-9a-f]{16}$/u);
  assert.match(result.sharedFingerprint, /^[0-9a-f]{16}$/u);
});

test("coreとuploadが同一assetでも一意なら許可する", async () => {
  const sources = baseSources();
  sources.set(coreUrl, `${coreSource} ${uploadSource}`);
  sources.delete(uploadUrl);

  const result = await discoverRuntimeAssets([rootUrl], fetchFrom(sources));
  assert.equal(result.coreUrl, coreUrl);
  assert.equal(result.uploadUrl, coreUrl);
});

test("各roleの候補が0件または複数ならruntime driftで止める", async () => {
  const zeroUpload = baseSources();
  zeroUpload.delete(uploadUrl);
  await assert.rejects(
    discoverRuntimeAssets([rootUrl], fetchFrom(zeroUpload)),
    (error) => error instanceof ConnectorError && error.code === "RUNTIME_DRIFT",
  );

  const duplicateCoreUrl = `${origin}/assets/core-copy.js`;
  const duplicateCore = baseSources();
  duplicateCore.set(rootUrl, `${duplicateCore.get(rootUrl)!} import "./core-copy.js";`);
  duplicateCore.set(duplicateCoreUrl, coreSource);
  await assert.rejects(
    discoverRuntimeAssets([rootUrl], fetchFrom(duplicateCore)),
    (error) => error instanceof ConnectorError && error.code === "RUNTIME_DRIFT",
  );

  const duplicateConversationUrl = `${origin}/assets/conversation-copy.js`;
  const duplicateConversation = baseSources();
  duplicateConversation.set(
    rootUrl,
    `${duplicateConversation.get(rootUrl)!} import "./conversation-copy.js";`,
  );
  duplicateConversation.set(duplicateConversationUrl, conversationSource);
  await assert.rejects(
    discoverRuntimeAssets([rootUrl], fetchFrom(duplicateConversation)),
    (error) => error instanceof ConnectorError && error.code === "RUNTIME_DRIFT",
  );

  const duplicateUploadUrl = `${origin}/assets/upload-copy.js`;
  const duplicateUpload = baseSources();
  duplicateUpload.set(coreUrl, `${coreSource} import "./upload-copy.js";`);
  duplicateUpload.set(duplicateUploadUrl, uploadSource);
  await assert.rejects(
    discoverRuntimeAssets([rootUrl], fetchFrom(duplicateUpload)),
    (error) => error instanceof ConnectorError && error.code === "RUNTIME_DRIFT",
  );
});
