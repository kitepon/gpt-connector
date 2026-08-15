import assert from "node:assert/strict";
import test from "node:test";

import { ConnectorError } from "../src/errors.js";
import { LazyConnectorHost } from "../src/mcp-server.js";

function fakeConnector(close: () => void) {
  return {
    models: async () => { throw new Error("unused"); },
    diagnostics: async () => { throw new Error("unused"); },
    chat: async () => { throw new Error("unused"); },
    consult: async () => { throw new Error("unused"); },
    image: async () => { throw new Error("unused"); },
    sessions: () => { throw new Error("unused"); },
    closeSession: async () => { throw new Error("unused"); },
    close,
    shutdown: async () => {},
  };
}

test("CDP失敗後は同じ呼出しを再送せず、次回にfresh connectorへ接続する", async () => {
  let connectCount = 0;
  let firstCloseCount = 0;
  const host = new LazyConnectorHost("http://127.0.0.1:9223", undefined, async () => {
    connectCount += 1;
    if (connectCount === 1) {
      return fakeConnector(() => { firstCloseCount += 1; });
    }
    return fakeConnector(() => {});
  });

  await assert.rejects(
    host.run(async () => {
      throw new ConnectorError("CDP_UNAVAILABLE", "CDP呼出しがtimeoutしました。");
    }),
    { code: "CDP_UNAVAILABLE", message: "CDP呼出しがtimeoutしました。" },
  );
  assert.equal(connectCount, 1);
  assert.equal(firstCloseCount, 1);

  assert.deepEqual(
    await host.run(async () => ({ overall: "ready" })),
    { overall: "ready" },
  );
  assert.equal(connectCount, 2);
});

test("CDP以外の失敗ではconnectorを入れ替えない", async () => {
  let connectCount = 0;
  let closeCount = 0;
  const connector = fakeConnector(() => { closeCount += 1; });
  const host = new LazyConnectorHost(
    "http://127.0.0.1:9223",
    undefined,
    async () => { connectCount += 1; return connector; },
  );

  const failAuth = async () => { throw new ConnectorError("AUTH_REQUIRED", "login required"); };
  await assert.rejects(host.run(failAuth), { code: "AUTH_REQUIRED" });
  await assert.rejects(host.run(failAuth), { code: "AUTH_REQUIRED" });
  assert.equal(connectCount, 1);
  assert.equal(closeCount, 0);
});

test("diagnosticsは未知の実装errorをdoctor fallbackで隠さない", async () => {
  let doctorCount = 0;
  const connector = {
    ...fakeConnector(() => {}),
    diagnostics: async () => { throw new Error("diagnostics bug"); },
  };
  const host = new LazyConnectorHost(
    "http://127.0.0.1:9223",
    undefined,
    async () => connector,
    async () => { doctorCount += 1; throw new Error("unexpected doctor call"); },
  );

  await host.get();
  await assert.rejects(host.diagnostics(), /diagnostics bug/u);
  assert.equal(doctorCount, 0);
});

test("diagnosticsは本物のruntime driftをdoctor fallbackで隠さない", async () => {
  let doctorCount = 0;
  const connector = {
    ...fakeConnector(() => {}),
    diagnostics: async () => { throw new ConnectorError("RUNTIME_DRIFT", "bridge drift"); },
  };
  const host = new LazyConnectorHost(
    "http://127.0.0.1:9223",
    undefined,
    async () => connector,
    async () => { doctorCount += 1; throw new Error("unexpected doctor call"); },
  );

  await host.get();
  await assert.rejects(host.diagnostics(), { code: "RUNTIME_DRIFT", message: "bridge drift" });
  assert.equal(doctorCount, 0);
});
