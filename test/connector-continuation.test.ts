import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { CdpClient } from "../src/cdp.js";
import { GptConnector } from "../src/connector.js";
import type { ConsultSnapshot } from "../src/contract.js";
import { ConsultJobStore } from "../src/consult-job-store.js";
import { normalizeModelCatalog } from "../src/model-catalog.js";
import { bridgeBuildId } from "../src/page-bridge.js";
import { rawCatalog } from "./latest-catalog.fixture.js";

async function fixture(t: TestContext) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gpt-continuation-"));
  const conversations = new Map<string, { busy: boolean; prompts: string[] }>();
  const sent: Array<{ sessionId: string; keepOpen: boolean; model: string; effort?: string }> = [];
  const operations = new Map<string, { state: string; result?: unknown; error?: unknown }>();
  let finish = () => {};
  let fail = () => {};
  const bridge = {
    version: 1, buildId: bridgeBuildId,
    summary: () => ({ version: 1, buildId: bridgeBuildId, ready: true }),
    sessionInfo: (sessionId: string) => conversations.has(sessionId) ? { sessionId, busy: conversations.get(sessionId)!.busy } : null,
    startChat: (input: { sessionId?: string; prompt: string; keepOpen: boolean; model: string; effort?: string }) => {
      const operationId = randomUUID();
      const sessionId = input.sessionId ?? randomUUID();
      const existing = conversations.get(sessionId);
      if ((input.sessionId && !existing) || existing?.busy) {
        operations.set(operationId, { state: "failed", error: { code: existing ? "SESSION_BUSY" : "SESSION_NOT_FOUND", message: "会話を利用できません。" } });
        return { operationId };
      }
      const conversation = existing ?? { busy: false, prompts: [] };
      conversation.busy = true;
      conversation.prompts.push(input.prompt);
      conversations.set(sessionId, conversation);
      sent.push({ ...input, sessionId });
      operations.set(operationId, { state: "pending" });
      finish = () => {
        conversation.busy = false;
        if (!input.keepOpen) conversations.delete(sessionId);
        operations.set(operationId, { state: "succeeded", result: {
          text: conversation.prompts.join(" → "), status: "finished_successfully", endTurn: true,
          resolvedModel: input.model, resolvedEffort: input.effort ?? null,
          ...(input.keepOpen ? { sessionId } : {}),
          attachments: { count: 0, names: [], mimeTypes: [], readBack: "confirmed", retention: "unknown", cleanup: "not_supported" },
        } });
      };
      fail = () => {
        conversation.busy = false;
        operations.set(operationId, { state: "failed", error: { code: "CHAT_FAILED", message: "回答生成が失敗しました。" } });
      };
      return { operationId, sessionId };
    },
    startClose: ({ sessionId }: { sessionId: string }) => {
      const operationId = randomUUID();
      conversations.delete(sessionId);
      operations.set(operationId, { state: "succeeded", result: { archived: true } });
      return { operationId };
    },
    poll: (operationId: string, consume: boolean) => {
      const result = operations.get(operationId);
      if (consume) operations.delete(operationId);
      return result;
    },
  };
  t.mock.method(CdpClient, "connect", async () => ({
    call: async (method: string, params?: { expression: string }) => {
      if (method === "Runtime.enable") return {};
      const expression = params!.expression;
      const value = expression.includes("/api/auth/session")
        ? { authenticated: true, officialOrigin: true, status: 200 }
        : vm.runInNewContext(expression, { globalThis: { __gptConnectorBridgeV1: bridge } });
      return { result: { value } };
    }, close: () => {},
  }) as unknown as CdpClient);
  const connectors: GptConnector[] = [];
  const connect = async () => {
    const connector = await GptConnector.connect({ stateDirectory, pollIntervalMs: 1, fetch: async () => new Response(JSON.stringify([
      { id: "test", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
    ])) });
    t.mock.method(connector, "models", async () => normalizeModelCatalog(rawCatalog));
    connectors.push(connector);
    return connector;
  };
  t.after(async () => { finish(); for (const c of connectors) await c.shutdown(); await rm(stateDirectory, { recursive: true, force: true }); });
  return { connect, conversations, sent, finish: () => finish(), fail: () => fail(), stateDirectory };
}

test("受付時のIDを回答前に返し、同じslugの再確認で再送せず、追加質問だけを同じ会話へ送る", async (t) => {
  const f = await fixture(t);
  const connector = await f.connect();
  const input = { prompt: "前提の合言葉は瑠璃", slug: "first-question", keepOpen: true, wait: false };
  const accepted = await connector.consult(input) as ConsultSnapshot;
  assert.equal(accepted.state, "running");
  assert.equal(accepted.result, null);
  assert.match(accepted.sessionId!, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(await connector.consult(input), accepted);
  assert.equal(f.sent.length, 1);
  const busy = await connector.consult({ ...input, sessionId: accepted.sessionId, slug: "too-early" }) as ConsultSnapshot;
  assert.equal(busy.error?.code, "SESSION_BUSY");
  assert.equal(f.sent.length, 1);
  const reader = new ConsultJobStore({ stateDirectory: f.stateDirectory, readOnly: true });
  await reader.initialize();
  assert.equal(reader.get(input.slug).sessionId, accepted.sessionId);
  f.finish();
  const first = await connector.consult({ ...input, wait: true }) as ConsultSnapshot;
  assert.equal(first.state, "succeeded");
  assert.equal(first.result?.sessionId, accepted.sessionId);
  assert.equal(reader.get(input.slug).state, "succeeded");
  reader.close();
  const followup = { ...input, prompt: "合言葉をもう一度", slug: "second-question", sessionId: accepted.sessionId };
  const second = await connector.consult(followup) as ConsultSnapshot;
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(f.conversations.size, 1);
  f.finish();
  const result = await connector.consult({ ...followup, wait: true }) as ConsultSnapshot;
  assert.equal(result.result?.text, "前提の合言葉は瑠璃 → 合言葉をもう一度");
  await assert.rejects(connector.consult({ ...followup, sessionId: randomUUID() }), { code: "JOB_CONFLICT" });
  assert.equal(f.sent.length, 2);
});

test("MCP再接続後も受付IDで継続し、明示closeで会話を閉じる", async (t) => {
  const f = await fixture(t);
  const first = await f.connect();
  const input = { prompt: "背景", slug: "before-reconnect", keepOpen: true, wait: false };
  const accepted = await first.consult(input) as ConsultSnapshot;
  f.finish();
  await first.shutdown();
  assert.equal(f.conversations.size, 1);
  const second = await f.connect();
  assert.equal(second.sessions({ slug: input.slug }).sessionId, accepted.sessionId);
  const continued = await second.consult({ ...input, prompt: "追加", slug: "after-reconnect", sessionId: accepted.sessionId }) as ConsultSnapshot;
  assert.equal(continued.sessionId, accepted.sessionId);
  f.finish();
  await second.shutdown();
  const third = await f.connect();
  assert.deepEqual(await third.closeSession({ sessionId: accepted.sessionId! }), { archived: true });
  assert.equal(f.conversations.size, 0);
  const closed = await third.consult({ ...input, slug: "after-close", sessionId: accepted.sessionId }) as ConsultSnapshot;
  assert.equal(closed.error?.code, "SESSION_NOT_FOUND");
  assert.equal(f.sent.length, 2);
});

test("生成失敗でも受付IDを記録に残し、keepOpen=falseの最終質問はarchiveする", async (t) => {
  const f = await fixture(t);
  const connector = await f.connect();
  const first = { prompt: "背景", slug: "initial-question", keepOpen: true, wait: false };
  const initial = await connector.consult(first) as ConsultSnapshot;
  f.finish();
  await connector.consult({ ...first, wait: true });
  const input = { ...first, slug: "failed-question", sessionId: initial.sessionId };
  const receipt = await connector.consult(input) as ConsultSnapshot;
  f.fail();
  const failed = await connector.consult({ ...input, wait: true }) as ConsultSnapshot;
  assert.equal(failed.state, "failed");
  assert.equal(failed.sessionId, receipt.sessionId);
  const next = { ...input, slug: "final-question", sessionId: receipt.sessionId, keepOpen: false };
  const accepted = await connector.consult(next) as ConsultSnapshot;
  assert.equal(accepted.sessionId, undefined);
  f.finish();
  const done = await connector.consult({ ...next, wait: true }) as ConsultSnapshot;
  assert.equal(done.result?.archived, true);
  assert.equal(f.conversations.size, 0);
  const saved = JSON.parse(await readFile(join(f.stateDirectory, "consult-jobs.json"), "utf8"));
  assert.equal(saved.jobs.find((job: { snapshot: ConsultSnapshot }) => job.snapshot.slug === input.slug).snapshot.sessionId, receipt.sessionId);
});

test("不明な会話IDは新規会話に置き換えず、送信前に拒否する", async (t) => {
  const f = await fixture(t);
  const connector = await f.connect();
  const result = await connector.consult({ prompt: "追加", slug: "unknown-session", sessionId: randomUUID(), keepOpen: true, wait: false }) as ConsultSnapshot;
  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "SESSION_NOT_FOUND");
  assert.equal(f.sent.length, 0);
});
