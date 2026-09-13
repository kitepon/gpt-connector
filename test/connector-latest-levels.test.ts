import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { CdpClient } from "../src/cdp.js";
import { GptConnector } from "../src/connector.js";
import { normalizeModelCatalog } from "../src/model-catalog.js";
import { bridgeBuildId } from "../src/page-bridge.js";
import { rawCatalog } from "./latest-catalog.fixture.js";

test("通常Chatの5段階を送信し、保存済みconsultは後日の利用可否に依存しない", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gpt-latest-levels-"));
  const sent: Array<{ model: string; effort?: string }> = [];
  let lastResult: unknown;
  let clock = Date.now();
  let proPending = false;
  t.mock.method(Date, "now", () => clock);
  const bridge = {
    version: 1, buildId: bridgeBuildId,
    summary: () => ({ version: 1, buildId: bridgeBuildId, ready: true }),
    startChat: (input: { model: string; effort?: string }) => {
      sent.push(input);
      proPending = input.model === 'gpt-pro';
      lastResult = { text: "確認済み", status: "finished_successfully", endTurn: true,
        resolvedModel: input.model, resolvedEffort: input.effort ?? null,
        attachments: { count: 0, names: [], mimeTypes: [], readBack: "confirmed", retention: "unknown", cleanup: "not_supported" } };
      return { operationId: randomUUID() };
    },
    poll: () => {
      if (proPending) {
        proPending = false;
        clock += 247_000;
        return { state: "pending" };
      }
      return { state: "succeeded", result: lastResult };
    },
  };
  const client = {
    call: async (method: string, params?: { expression: string }) => {
      if (method === "Runtime.enable") return {};
      assert.equal(method, "Runtime.evaluate");
      const expression = params!.expression;
      const value = expression.includes("/api/auth/session")
        ? { status: 200, authenticated: true, officialOrigin: true }
        : vm.runInNewContext(expression, { globalThis: { __gptConnectorBridgeV1: bridge } });
      return { result: { value } };
    },
    close: () => {},
  };
  t.mock.method(CdpClient, "connect", async () => client as unknown as CdpClient);
  const connector = await GptConnector.connect({ stateDirectory, pollIntervalMs: 1, fetch: async () => new Response(JSON.stringify([
    { id: "test", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
  ])) });
  let catalog = normalizeModelCatalog(rawCatalog);
  const models = t.mock.method(connector, "models", async () => catalog);
  try {
    for (const level of catalog.levels) await connector.chat({ prompt: "確認", level: level.level });
    await connector.chat({ prompt: "確認" });
    assert.deepEqual(sent.map(({model, effort}) => ({model, effort})), [
      {model: "gpt-instant", effort: undefined}, {model: "gpt-thinking", effort: "standard"},
      {model: "gpt-thinking", effort: "extended"}, {model: "gpt-thinking", effort: "max"},
      {model: "gpt-pro", effort: undefined}, {model: "gpt-pro", effort: undefined},
    ]);
    const input = { prompt: "確認", slug: "replay-pro" };
    const first = await connector.consult(input);
    assert.ok("state" in first && first.state === "succeeded");
    const changed = structuredClone(rawCatalog);
    changed.versions[0]!.intelligence_presets[4]!.preset_type = "upgrade";
    catalog = normalizeModelCatalog(changed);
    const callsBeforeReplay = models.mock.callCount();
    assert.deepEqual(await connector.consult(input), first);
    assert.equal(models.mock.callCount(), callsBeforeReplay);
    assert.equal(sent.length, 7);
    await assert.rejects(connector.consult({ ...input, level: "高" }), { code: "JOB_CONFLICT" });
    const blocked = await connector.consult({ ...input, slug: "unavailable-pro" });
    assert.ok("state" in blocked && blocked.state === "failed");
    assert.equal(blocked.error?.code, "MODEL_NOT_AVAILABLE");
    assert.equal(sent.length, 7);
  } finally {
    connector.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
