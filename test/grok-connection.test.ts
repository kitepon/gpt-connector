import assert from "node:assert/strict";
import test from "node:test";

import { connectGrokWithBrowser } from "../src/grok-connection.js";
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
