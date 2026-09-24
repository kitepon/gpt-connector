import { ConnectorError } from "./errors.js";
import { evaluateByValue } from "./runtime-evaluate.js";
import type { CdpClient } from "./cdp.js";

export interface GrokModules {
  readonly api: number;
  readonly responseStore: number;
  readonly conversationStore: number;
  readonly modesStore: number;
  readonly chatPageStore: number;
}

const signatures = {
  api: /"chatApi",0,[\w$]+,[\s\S]{0,1500}?\],(\d+)\)/gu,
  responseStore: /(\d+),e=>\{"use strict";e\.s\(\[[^\]]*"useResponseStore"/gu,
  conversationStore: /"useConversationStore",\(\)=>[\w$]+\],(\d+)\)/gu,
  modesStore: /"useModesStore",0,[\w$]+\],(\d+)\)/gu,
  chatPageStore: /"useChatPageStore",\(\)=>[\w$]+,[\s\S]{0,200}?\],(\d+)\)/gu,
} as const;

export function identifyGrokModules(sources: readonly string[]): GrokModules {
  const ids = Object.fromEntries(Object.entries(signatures).map(([role, signature]) => {
    const found = new Set(sources.flatMap((source) => [...source.matchAll(signature)].map((match) => Number(match[1]))));
    if (found.size !== 1) {
      throw new ConnectorError("RUNTIME_DRIFT", `Grok ${role} moduleを一意に検出できませんでした。`, { count: found.size });
    }
    return [role, [...found][0]!];
  }));
  return ids as unknown as GrokModules;
}

export async function discoverGrokModules(
  client: CdpClient,
  fetchImplementation: typeof fetch = fetch,
): Promise<GrokModules> {
  const raw = await evaluateByValue<unknown>(client, String.raw`(() => Array.from(new Set([
    ...Array.from(document.scripts, (script) => script.src),
    ...performance.getEntriesByType("resource").map((entry) => entry.name)
  ])).filter(Boolean))()`);
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    throw new ConnectorError("RUNTIME_DRIFT", "Grok asset一覧の形式が不正です。");
  }
  const urls = [...new Set(raw)].filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        (url.hostname === "grok.com" || url.hostname === "cdn.grok.com") &&
        url.pathname.startsWith("/_next/static/chunks/") && url.pathname.endsWith(".js");
    } catch { return false; }
  });
  if (urls.length === 0 || urls.length > 400) {
    throw new ConnectorError("RUNTIME_DRIFT", "Grok runtime asset件数が想定外です。", { count: urls.length });
  }
  const sources: string[] = [];
  for (let index = 0; index < urls.length; index += 12) {
    const batch = await Promise.all(urls.slice(index, index + 12).map(async (url) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetchImplementation(url, {
            headers: { "user-agent": "Mozilla/5.0", referer: "https://grok.com/" },
          });
          if (response.ok) return await response.text();
        } catch { /* 次の試行で同じ公式assetを確認する。 */ }
      }
      return null;
    }));
    sources.push(...batch.filter((source): source is string => source !== null));
    try { return identifyGrokModules(sources); } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "RUNTIME_DRIFT") throw error;
    }
  }
  return identifyGrokModules(sources);
}
