import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import tls from "node:tls";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGptConnectorMcpServer, LazyConnectorHost } from "../src/mcp-server.js";
import { inspectRuntimeCa, runtimeDiagnostics, runtimeDiagnosticsSchema, type RuntimeDiagnostics } from "../src/runtime-diagnostics.js";
import { verifyMcp } from "../src/setup.js";

const selection: RuntimeDiagnostics["caSelection"] = { ...runtimeDiagnostics().caSelection, flags: [], nodeOptions: "absent", sslCertFile: "absent", sslCertDir: "absent" };
// Public fixture from Node v24.20.0 src/node_root_certs.h; never installed in a trust store.
const target = readFileSync(new URL("./fixtures/sec021-target-ca.pem", import.meta.url), "utf8");

test("CA検査は固定DERの有無を判別し、他の証明書と解析失敗を混同しない", () => {
  assert.equal(inspectRuntimeCa(() => [target], selection).targetCertificate, "present");
  assert.equal(inspectRuntimeCa(() => [tls.rootCertificates[0]!], selection).targetCertificate, "absent");
  for (const [getCertificates, reason] of [
    [undefined, "api_unavailable"],
    [() => [], "empty_list"],
    [() => [target, "private-invalid-cert"], "inspection_failed"],
    [() => { throw new Error("private-api-error"); }, "inspection_failed"],
  ] as const) {
    const result = inspectRuntimeCa(getCertificates, selection);
    assert.equal(result.targetCertificate, "unknown");
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /private-|BEGIN CERTIFICATE/u);
  }
});

test("不明なCA選択・OpenSSL既定storeはAPI一覧の不在で排除済みにしない", () => {
  for (const patch of [
    { nodeOptions: "present" as const }, { sslCertFile: "present" as const }, { sslCertDir: "present" as const },
    { flags: ["--use-openssl-ca" as const] }, { flags: ["--no-use-bundled-ca" as const] },
  ]) {
    const result = inspectRuntimeCa(() => { throw new Error("must not inspect"); }, { ...selection, ...patch });
    assert.equal(result.targetCertificate, "unknown");
    assert.equal(result.reason, "selection_unresolved");
  }
});

test("MCP runtimeOnlyは同serverで応答し、通常diagnosticsだけが既doctorを呼ぶ", async t => {
  let normalCalls = 0;
  const normal = { schema: "gpt-connector.diagnostics.v1", marker: "normal-diagnostic-unchanged" };
  const host = new LazyConnectorHost(undefined, undefined, async () => { throw new Error("unexpected browser connection"); }, async () => {
    normalCalls++;
    return normal as unknown as Awaited<ReturnType<LazyConnectorHost["diagnostics"]>>;
  });
  const server = createGptConnectorMcpServer(host);
  const client = new Client({ name: "isolated-runtime-fixture", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(right);
  await client.connect(left);
  assert.equal((await client.listTools()).tools.length, 13);
  const result = await client.callTool({ name: "diagnostics", arguments: { runtimeOnly: true } });
  const runtime = runtimeDiagnosticsSchema.parse(JSON.parse((result.content as { text: string }[])[0]!.text));
  assert.equal(runtime.process.pid, process.pid);
  assert.equal(runtime.process.instanceId, runtimeDiagnostics().process.instanceId);
  assert.equal(normalCalls, 0);
  const legacy = await client.callTool({ name: "diagnostics", arguments: {} });
  assert.deepEqual(JSON.parse((legacy.content as { text: string }[])[0]!.text), normal);
  assert.equal(normalCalls, 1);
});

test("CLI runtime-onlyは秘密・pathを公開せずCDP/stateを使わずに固定証跡を返す", () => {
  const result = spawnSync(process.execPath, ["--use-bundled-ca", "--import", "tsx", "src/cli.ts", "doctor", "--runtime-only"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: "--title=private-runtime-secret", SSL_CERT_FILE: "private-ca-path", GPT_CONNECTOR_CDP_ENDPOINT: "private-unreachable-endpoint", GPT_CONNECTOR_STATE_DIR: "private-state-path" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const runtime = runtimeDiagnosticsSchema.parse(JSON.parse(result.stdout));
  assert.notEqual(runtime.process.pid, process.pid);
  assert.deepEqual(runtime.caSelection.flags, ["--use-bundled-ca"]);
  assert.equal(runtime.caSelection.nodeOptions, "present");
  assert.equal(runtime.ca.targetCertificate, "unknown");
  assert.doesNotMatch(result.stdout, /private-|BEGIN CERTIFICATE|execPath|argv/u);
  for (const args of [["doctor", "--runtime-only", "true"], ["models", "--runtime-only"]]) {
    const invalid = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(invalid.status, 1);
  }
});

test("setupは子のruntime応答の未知field/版不一致を拒否しraw本文を返さない", async t => {
  const evidence = runtimeDiagnostics();
  const call = t.mock.method(Client.prototype, "callTool", async () => ({ content: [{ type: "text", text: JSON.stringify({ ...evidence, secret: "private-child-output" }) }] }));
  await assert.rejects(verifyMcp(process.execPath, ["--import", "tsx", "src/mcp.ts"], {}, undefined, false), error => {
    assert.equal((error as { substep: string }).substep, "diagnostics");
    assert.doesNotMatch(String(error), /private-child-output/u);
    return true;
  });
  call.mock.mockImplementation(async () => ({ content: [{ type: "text", text: JSON.stringify({ ...evidence, packageVersion: "0.0.0" }) }] }));
  await assert.rejects(verifyMcp(process.execPath, ["--import", "tsx", "src/mcp.ts"], {}, undefined, false), { substep: "diagnostics" });
});
