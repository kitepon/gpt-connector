import assert from "node:assert/strict";
import test from "node:test";

import { connectChatGptWithBrowser, connectGrokWithBrowser } from "../src/browser-connection.js";
import type { GptConnector } from "../src/connector.js";
import type { GrokConnector } from "../src/grok-connector.js";
import { ConnectorError } from "../src/errors.js";

const connector = {} as GrokConnector;

test("転送された9223にGrok targetが既にあればローカルChromeを起動しない", async () => {
  let starts = 0;
  const connected = await connectGrokWithBrowser({ endpoint: "http://127.0.0.1:9223" }, {
    connect: async () => connector,
    start: async () => { starts++; },
  });
  assert.equal(connected, connector);
  assert.equal(starts, 0);
});

test("専用ChromeのGrok targetが無い時だけ準備して接続し直す", async () => {
  const events: string[] = [];
  const connected = await connectGrokWithBrowser({ stateDirectory: "/state" }, {
    connect: async () => {
      events.push("connect");
      if (events.length === 1) throw new ConnectorError("CDP_UNAVAILABLE", "Grok targetがありません。");
      return connector;
    },
    start: async (options) => {
      assert.deepEqual(options, { provider: "grok", stateDirectory: "/state" });
      events.push("start");
    },
  });
  assert.equal(connected, connector);
  assert.deepEqual(events, ["connect", "start", "connect"]);
});

test("別endpointの接続失敗はローカルChromeへ切り替えない", async () => {
  const failure = new ConnectorError("AUTH_REQUIRED", "Grokへログインしてください。");
  await assert.rejects(connectGrokWithBrowser({ endpoint: "http://127.0.0.1:9333" }, {
    connect: async () => { throw failure; },
    start: async () => { throw new Error("ローカルChromeを起動しました"); },
  }), (error) => error === failure);
});

const chatGpt = {} as GptConnector;

test("ChatGPT tabが無い時は専用Chromeを準備して接続し直す", async () => {
  const events: string[] = [];
  const connected = await connectChatGptWithBrowser({ stateDirectory: "/state" }, {
    connect: async () => {
      events.push("connect");
      if (events.length === 1) throw new ConnectorError("CDP_UNAVAILABLE", "ChatGPT targetがありません。", { targetMissing: true });
      return chatGpt;
    },
    start: async (options) => {
      assert.deepEqual(options, { provider: "chatgpt", stateDirectory: "/state" });
      events.push("start");
    },
  });
  assert.equal(connected, chatGpt);
  assert.deepEqual(events, ["connect", "start", "connect"]);
});

test("ChatGPTの認証切れやruntime driftでは専用Chromeを準備し直さない", async () => {
  for (const code of ["AUTH_REQUIRED", "RUNTIME_DRIFT"] as const) {
    const failure = new ConnectorError(code, "失敗");
    await assert.rejects(connectChatGptWithBrowser({}, {
      connect: async () => { throw failure; },
      start: async () => { throw new Error("準備しました"); },
    }), (error) => error === failure);
  }
});

test("9223が転送などで専用Chromeの物でなければ、ポート衝突でなく元の接続失敗を返す", async () => {
  const failure = new ConnectorError("CDP_UNAVAILABLE", "ChatGPT targetがありません。", { targetMissing: true });
  let connects = 0;
  await assert.rejects(connectChatGptWithBrowser({ endpoint: "http://127.0.0.1:9223" }, {
    connect: async () => { connects++; throw failure; },
    start: async () => { throw new ConnectorError("RUNTIME_DRIFT", "ポート衝突", { portConflict: true }); },
  }), (error) => error === failure);
  assert.equal(connects, 1);
});

test("準備そのものの失敗（認証が必要など）はそのまま返す", async () => {
  const startFailure = new ConnectorError("AUTH_REQUIRED", "ChatGPTへログインしてください。");
  await assert.rejects(connectChatGptWithBrowser({}, {
    connect: async () => { throw new ConnectorError("CDP_UNAVAILABLE", "接続できません。", { unreachable: true }); },
    start: async () => { throw startFailure; },
  }), (error) => error === startFailure);
});
