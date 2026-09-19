import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { CdpClient } from "../src/cdp.js";
import { GptConnector, type ConnectorOptions } from "../src/connector.js";
import { CodexDeliveryError } from "../src/codex-parent.js";
import type { ConsultSnapshot } from "../src/contract.js";
import { ConsultJobStore } from "../src/consult-job-store.js";
import { normalizeModelCatalog } from "../src/model-catalog.js";
import { bridgeBuildId } from "../src/page-bridge.js";
import { rawCatalog } from "./latest-catalog.fixture.js";
import { ConnectorError } from "../src/errors.js";
import { LazyConnectorHost } from "../src/mcp-server.js";

async function fixture(t: TestContext) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gpt-continuation-"));
  const conversations = new Map<string, { busy: boolean; prompts: string[] }>();
  const sent: Array<{ sessionId: string; keepOpen: boolean; model: string; effort?: string }> = [];
  const operations = new Map<string, { state: string; result?: unknown; error?: unknown }>();
  const polls: number[] = [];
  let finish = () => {};
  let fail: (code?: string) => void = () => {};
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
      fail = (code = "CHAT_FAILED") => {
        conversation.busy = false;
        operations.set(operationId, { state: "failed", error: { code, message: "回答生成が失敗しました。" } });
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
      if (!consume) polls.push(Date.now());
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
  const connect = async (options: Partial<ConnectorOptions> = {}) => {
    const connector = await GptConnector.connect({ stateDirectory, pollIntervalMs: 1, ...options, fetch: async () => new Response(JSON.stringify([
      { id: "test", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
    ])) });
    t.mock.method(connector, "models", async () => normalizeModelCatalog(rawCatalog));
    connectors.push(connector);
    return connector;
  };
  t.after(async () => { finish(); for (const c of connectors) await c.shutdown(); await rm(stateDirectory, { recursive: true, force: true }); });
  return { connect, conversations, sent, polls, finish: () => finish(), fail: (code?: string) => fail(code), stateDirectory };
}

for (const timing of ["受付前", "受付後"] as const) test(`${timing}の非同期相談がCDP失敗した後は、結果を保持して次の要求だけ再接続する`, async t => {
  const f = await fixture(t);
  let connections = 0;
  let first!: GptConnector;
  const host = new LazyConnectorHost(undefined, f.stateDirectory, async () => {
    const connector = await f.connect();
    connections++;
    if (connections === 1) {
      first = connector;
      if (timing === "受付前") t.mock.method(connector, "models", async () => {
        throw new ConnectorError("CDP_UNAVAILABLE", "閉じたCDP接続は利用できません。");
      });
    }
    return connector;
  });
  const input = { prompt: "切断される相談", slug: "disconnected-consult", keepOpen: true, wait: false };
  const accepted = await host.run(c => c.consult(input)) as ConsultSnapshot;
  if (timing === "受付後") {
    assert.equal(accepted.state, "running");
    f.fail("CDP_UNAVAILABLE");
  }
  const failed = await first.consult({ ...input, wait: true }) as ConsultSnapshot;
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "CDP_UNAVAILABLE");
  assert.equal(connections, 1);

  await Promise.all([host.run(c => c.models()), host.run(c => c.models())]);
  assert.equal(connections, 2);
  assert.equal((await host.sessions({ slug: input.slug })).error?.code, "CDP_UNAVAILABLE");
  const nextInput = { prompt: "復旧後の新しい相談", slug: "after-reconnect", keepOpen: true, wait: false };
  const next = await host.run(c => c.consult(nextInput)) as ConsultSnapshot;
  assert.equal(next.state, "running");
  f.finish();
  const done = await host.run(c => c.consult({ ...nextInput, wait: true })) as ConsultSnapshot;
  assert.equal(done.state, "succeeded");
  assert.equal(f.sent.length, timing === "受付前" ? 1 : 2);
});

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

test("通常Chatは10分を超えても明示完了まで待ち、完了後の後続turnを受け付ける", async (t) => {
  const f = await fixture(t);
  const connector = await f.connect();
  let virtualNow = 0;
  t.mock.method(Date, "now", () => {
    return virtualNow;
  });

  const firstInput = { prompt: "長い推論", slug: "long-running", keepOpen: true, wait: false };
  const accepted = await connector.consult(firstInput) as ConsultSnapshot;
  assert.equal(accepted.state, "running");
  assert.ok(accepted.sessionId);

  virtualNow = 600_001;
  await new Promise(resolve => setTimeout(resolve, 10));
  f.finish();
  const first = await connector.consult({ ...firstInput, wait: true }) as ConsultSnapshot;
  assert.equal(first.state, "succeeded");
  assert.equal(first.sessionId, accepted.sessionId);

  const followupInput = { ...firstInput, prompt: "後続turn", slug: "after-long-running", sessionId: first.sessionId, wait: false };
  const followup = await connector.consult(followupInput) as ConsultSnapshot;
  assert.equal(followup.state, "running");
  f.finish();
  const done = await connector.consult({ ...followupInput, wait: true }) as ConsultSnapshot;
  assert.equal(done.state, "succeeded");
  assert.equal(done.result?.text, "長い推論 → 後続turn");
});

for (const outcome of ["succeeded", "failed", "unknown"] as const) test(`Codex相談は受付後に監視し${outcome}を一度だけ配送記録する`, async t => {
  const f = await fixture(t);
  const parent = { threadId: randomUUID(), socketPath: "/tmp/fixture-parent.sock" };
  const deliveries: string[] = [];
  const connector = await f.connect({ parentDelivery: {
    verify: async target => { assert.deepEqual(target, parent); },
    submit: async (target, id, text) => {
      assert.deepEqual(target, parent); assert.match(id, /^[0-9a-f-]{36}$/u); deliveries.push(text);
      if (outcome === "unknown") throw new CodexDeliveryError("受付後に切断", true);
    },
  } });
  const input = { prompt: "背景の合言葉", slug: "parent-question", keepOpen: true };
  const receipt = await connector.consult(input, parent) as ConsultSnapshot;
  assert.equal(receipt.state, "running");
  assert.equal(receipt.delivery?.state, "waiting");
  assert.ok(receipt.sessionId);
  assert.equal(deliveries.length, 0);
  if (outcome === "failed") f.fail(); else f.finish();
  // 試験だけが完了を待つ。利用AIは受付後にポーリングしない。
  await connector.shutdown();
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]!, new RegExp(receipt.sessionId!));
  const again = await f.connect({ parentDelivery: {
    verify: async () => {}, submit: async () => { throw new Error("二重配送"); },
  } });
  const saved = await again.consult(input, parent) as ConsultSnapshot;
  assert.equal(saved.state, outcome === "failed" ? "failed" : "succeeded");
  assert.equal(saved.delivery?.state, outcome === "unknown" ? "unknown" : "submitted");
  assert.equal(f.sent.length, 1);
});

test("配送準備が失敗した相談はChatGPTへ送信しない", async t => {
  const f = await fixture(t);
  const connector = await f.connect({ parentDelivery: {
    verify: async () => { throw new CodexDeliveryError("未設定"); },
    submit: async () => { throw new Error("未到達"); },
  } });
  await assert.rejects(connector.consult({ prompt: "本文", slug: "no-delivery" },
    { threadId: randomUUID(), socketPath: "/tmp/fixture.sock" }), { code: "PARENT_DELIVERY_UNAVAILABLE" });
  assert.equal(f.sent.length, 0);
});

test("Codexの既定監視頻度は10秒で、受付後に利用AIの呼出しなしで配送する", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  let delivered = false;
  const connector = await f.connect({ pollIntervalMs: undefined, parentDelivery: {
    verify: async () => {}, submit: async () => { delivered = true; },
  } });
  await connector.consult({ prompt: "10秒監視", slug: "ten-second-monitor" }, { threadId: randomUUID(), socketPath: "/tmp/parent.sock" });
  f.finish();
  await connector.shutdown();
  assert.equal(delivered, true);
  assert.equal(f.polls.length, 2);
  assert.ok(f.polls[1]! - f.polls[0]! >= 9_900);
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
