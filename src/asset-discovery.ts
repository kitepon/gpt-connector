import { createHash } from "node:crypto";

import { ConnectorError } from "./errors.js";
import { evaluateByValue } from "./runtime-evaluate.js";
import type { CdpClient } from "./cdp.js";

export interface RuntimeAssets {
  readonly coreUrl: string;
  readonly conversationUrl: string;
  readonly uploadUrl: string;
  readonly sharedUrl: string;
  readonly coreFingerprint: string;
  readonly conversationFingerprint: string;
  readonly uploadFingerprint: string;
  readonly sharedFingerprint: string;
}

interface AssetCandidate {
  readonly url: string;
  readonly source: string;
}

const coreMarkers = [
  "/f/conversation/prepare",
  "conduit_token",
  "completion.submit.request",
] as const;

const conversationMarkers = [
  "contentToSend",
  "allSystemHints",
  "selectedSkillIds",
  "build_request_params.prompt_message",
] as const;

const uploadMarkers = [
  "process_upload_stream",
  "attachLibraryFile",
  "uploadFile:async",
] as const;

// thread/tree/apiClient等のstore群はcore chunkから共有chunkへ移動した。
// setServerIdForNewThreadは現行bundleでその共有chunkだけが持つ。
const sharedMarkers = [
  "setServerIdForNewThread",
  "initThread",
  "getLastAssistantMessage",
] as const;

const maxAssetCount = 800;
const assetBatchSize = 12;

function allowedAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" || url.hostname.endsWith(".oaistatic.com")) &&
      url.pathname.endsWith(".js")
    );
  } catch {
    return false;
  }
}

function fingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function importedAssetUrls(baseUrl: string, source: string): readonly string[] {
  const matches = source.matchAll(
    /(?:https:\/\/(?:chatgpt\.com|[a-z0-9.-]+\.oaistatic\.com))?\/(?:cdn\/assets|assets|_next\/static\/chunks)\/[a-zA-Z0-9_-]+\.js|(?:\.\.?\/)[a-zA-Z0-9_-]+\.js/gu,
  );
  const urls: string[] = [];
  for (const match of matches) {
    try {
      const url = new URL(match[0], baseUrl).href;
      if (allowedAssetUrl(url)) urls.push(url);
    } catch {
      // 不正なimport-like文字列はasset候補にしない。
    }
  }
  return [...new Set(urls)];
}

function findUnique(
  role: string,
  candidates: readonly AssetCandidate[],
  markers: readonly string[],
): AssetCandidate {
  const matches = candidates.filter(({ source }) =>
    markers.every((marker) => source.includes(marker)),
  );

  if (matches.length !== 1) {
    throw new ConnectorError(
      "RUNTIME_DRIFT",
      `${role} assetを一意に検出できませんでした。`,
      { count: matches.length },
    );
  }

  return matches[0]!;
}

export async function listLoadedAssetUrls(client: CdpClient): Promise<readonly string[]> {
  const expression = String.raw`(() => Array.from(new Set([
    ...Array.from(document.scripts, (element) => element.src),
    ...Array.from(document.scripts)
      .filter((element) => !element.src && element.type === "module")
      .flatMap((element) => element.textContent?.match(/\/(?:cdn\/assets|_next\/static\/chunks)\/[a-zA-Z0-9_-]+\.js/g) ?? [])
      .map((path) => new URL(path, location.origin).href),
    ...Array.from(document.head.children)
      .filter((element) => element.tagName === "LINK" && element.rel === "modulepreload")
      .map((element) => element.href),
    ...performance.getEntriesByType("resource").map((entry) => entry.name)
  ])).filter(Boolean))()`;

  const raw = await evaluateByValue<unknown>(client, expression);
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new ConnectorError("RUNTIME_DRIFT", "loaded asset URL一覧の形式が不正です。");
  }

  return [...new Set(raw.filter(allowedAssetUrl))];
}

export async function discoverRuntimeAssets(
  urls: readonly string[],
  fetchImplementation: typeof fetch = fetch,
): Promise<RuntimeAssets> {
  const queue = [...new Set(urls.filter(allowedAssetUrl))];
  const queued = new Set(queue);
  const fetched: AssetCandidate[] = [];

  while (queue.length > 0 && fetched.length < maxAssetCount) {
    const remaining = maxAssetCount - fetched.length;
    const batch = queue.splice(0, Math.min(assetBatchSize, remaining));
    const candidates = await Promise.all(
      batch.map(async (url): Promise<AssetCandidate | null> => {
        let response: Response;
        try {
          response = await fetchImplementation(url);
        } catch {
          return null;
        }
        if (!response.ok) return null;
        return { url, source: await response.text() };
      }),
    );

    for (const candidate of candidates) {
      if (candidate === null) continue;
      fetched.push(candidate);
      for (const importedUrl of importedAssetUrls(candidate.url, candidate.source)) {
        if (queued.has(importedUrl)) continue;
        queued.add(importedUrl);
        queue.push(importedUrl);
      }
    }
  }

  const core = findUnique("core", fetched, coreMarkers);
  const conversation = findUnique("conversation", fetched, conversationMarkers);
  const upload = findUnique("upload", fetched, uploadMarkers);
  const shared = findUnique("shared", fetched, sharedMarkers);

  return {
    coreUrl: core.url,
    conversationUrl: conversation.url,
    uploadUrl: upload.url,
    sharedUrl: shared.url,
    coreFingerprint: fingerprint(core.source),
    conversationFingerprint: fingerprint(conversation.source),
    uploadFingerprint: fingerprint(upload.source),
    sharedFingerprint: fingerprint(shared.source),
  };
}
