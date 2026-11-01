import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { CdpClient } from "../src/cdp.js";
import { GptConnector, authProbeExpression } from "../src/connector.js";
import { ConnectorError } from "../src/errors.js";

async function probe(fetch: () => Promise<unknown>, origin = "https://chatgpt.com"): Promise<unknown> {
  // vmの別contextのObject prototypeを外して値だけ比べる。
  return JSON.parse(JSON.stringify(await vm.runInNewContext(authProbeExpression, { fetch, location: { origin } })));
}

test("認証確認fetchの網の失敗はunreachableとして返し、応答が得られた時は従来の認証結果を返す", async () => {
  assert.deepEqual(await probe(async () => { throw new TypeError("Failed to fetch"); }), { status: 0, authenticated: false, officialOrigin: true, unreachable: true });
  assert.deepEqual(await probe(async () => { throw new TypeError("Failed to fetch"); }, "chrome-error://chromewebdata"), { status: 0, authenticated: false, officialOrigin: false, unreachable: true });
  assert.deepEqual(await probe(async () => ({ ok: true, status: 200, json: async () => ({ user: { id: "u" } }) })), { status: 200, authenticated: true, officialOrigin: true });
  assert.deepEqual(await probe(async () => ({ ok: false, status: 401, json: async () => ({}) })), { status: 401, authenticated: false, officialOrigin: true });
});

test("connectはpageの到達不能をCDP_UNAVAILABLE(unreachable)で返し、RUNTIME_DRIFTにもAUTH_REQUIREDにもしない", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gpt-auth-probe-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const client = {
    call: async (method: string, params?: { expression: string }) => {
      if (method === "Runtime.enable") return {};
      assert.equal(method, "Runtime.evaluate");
      assert.ok(params!.expression.includes("/api/auth/session"));
      return { result: { value: { status: 0, authenticated: false, officialOrigin: false, unreachable: true } } };
    },
    close: () => {},
  };
  t.mock.method(CdpClient, "connect", async () => client as unknown as CdpClient);
  await assert.rejects(GptConnector.connect({ stateDirectory, pollIntervalMs: 1, fetch: async () => new Response(JSON.stringify([
    { id: "test", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://127.0.0.1/test" },
  ])) }), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "CDP_UNAVAILABLE");
    assert.deepEqual(error.details, { unreachable: true, cdpStage: "protocol_call", cdpReason: "connection_failed" });
    return true;
  });
});
