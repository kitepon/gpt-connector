import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CdpClient,
  discoverChatGptTarget,
  discoverProviderTarget,
  validateCdpEndpoint,
  type CdpSocket,
} from "../src/cdp.js";
import { ConnectorError } from "../src/errors.js";

class FakeSocket extends EventEmitter implements CdpSocket {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close");
  }

  respond(index: number, result: unknown): void {
    const request = JSON.parse(this.sent[index]!) as { id: number };
    this.emit("message", Buffer.from(JSON.stringify({ id: request.id, result })));
  }
}

test("CDP endpointをloopbackへ限定する", () => {
  assert.equal(validateCdpEndpoint("http://127.0.0.1:9223").port, "9223");
  assert.throws(
    () => validateCdpEndpoint("http://example.com:9223"),
    (error) => error instanceof ConnectorError && error.code === "INVALID_INPUT",
  );
});

test("ChatGPT公式page targetを一意に選ぶ", async () => {
  const target = await discoverChatGptTarget(
    "http://127.0.0.1:9223",
    async () =>
      new Response(
        JSON.stringify([
          {
            id: "page-1",
            type: "page",
            url: "https://chatgpt.com/",
            webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/page-1",
          },
          {
            id: "page-2",
            type: "page",
            url: "https://example.com/",
            webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/page-2",
          },
        ]),
        { status: 200 },
      ),
  );

  assert.equal(target.id, "page-1");
});

function pageList(pages: readonly (readonly [id: string, url: string])[]): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify(pages.map(([id, url]) => ({
        id,
        type: "page",
        url,
        webSocketDebuggerUrl: `ws://127.0.0.1:9223/devtools/page/${id}`,
      }))),
      { status: 200 },
    );
}

test("ChatGPT tabが複数ある時はbridgeを持つtabを選ぶ", async () => {
  const pages = pageList([
    ["A1", "https://chatgpt.com/plugins"],
    ["C3", "https://chatgpt.com/"],
    ["B2", "https://chatgpt.com/c/1"],
    ["D4", "https://example.com/"],
  ]);
  const probed: string[] = [];
  const target = await discoverChatGptTarget("http://127.0.0.1:9223", pages, async (candidate, provider) => {
    probed.push(`${provider}:${candidate.id}`);
    return candidate.id === "C3";
  });

  assert.equal(target.id, "C3");
  assert.deepEqual(probed.sort(), ["chatgpt:A1", "chatgpt:B2", "chatgpt:C3"]);
});

test("どのtabもbridgeを持たない時と複数が持つ時はtarget idの順で1枚に決める", async () => {
  const pages = pageList([
    ["C3", "https://grok.com/"],
    ["A1", "https://grok.com/c/1"],
    ["B2", "https://grok.com/c/2"],
  ]);
  const endpoint = "http://127.0.0.1:9223";

  // 応答しないtabは持たない扱いにして、探索を止めない。
  const none = await discoverProviderTarget(endpoint, "grok", pages, async (candidate) => {
    if (candidate.id === "A1") throw new ConnectorError("CDP_UNAVAILABLE", "CDP呼出しがtimeoutしました。");
    return false;
  });
  const several = await discoverProviderTarget(endpoint, "grok", pages, async (candidate) => candidate.id !== "A1");

  assert.equal(none.id, "A1");
  assert.equal(several.id, "B2");
});

test("tabが1枚の時はbridgeを確かめずにそのtabを返す", async () => {
  const target = await discoverChatGptTarget(
    "http://127.0.0.1:9223",
    pageList([["A1", "https://chatgpt.com/"], ["B2", "https://grok.com/"]]),
    async () => { throw new Error("probeは呼ばれない"); },
  );

  assert.equal(target.id, "A1");
});

test("CDP JSON-RPC responseをcallへ対応付ける", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const resultPromise = client.call<{ value: number }>("Runtime.evaluate", {
    expression: "1 + 1",
  });

  socket.respond(0, { value: 2 });
  assert.deepEqual(await resultPromise, { value: 2 });
  client.close();
});

test("CDP eventを購読解除できる", () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const methods: string[] = [];
  const unsubscribe = client.onEvent((event) => methods.push(event.method));

  socket.emit("message", Buffer.from(JSON.stringify({ method: "Network.loadingFinished" })));
  unsubscribe();
  socket.emit("message", Buffer.from(JSON.stringify({ method: "Network.responseReceived" })));

  assert.deepEqual(methods, ["Network.loadingFinished"]);
  client.close();
});

test("CDP timeoutを明示エラーにする", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, 5);

  await assert.rejects(
    client.call("Runtime.evaluate"),
    (error) => error instanceof ConnectorError && error.code === "CDP_UNAVAILABLE",
  );
  client.close();
});
