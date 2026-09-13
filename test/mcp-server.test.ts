import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  chatgptEffortFieldDescription,
  chatgptLevelFieldDescription,
  chatInputSchema,
  chatgptModelFieldDescription,
  chatgptSessionFieldDescription,
  consultInputSchema,
  imageInputSchema,
} from "../src/contract.js";
import { createGptConnectorMcpServer, LazyConnectorHost, mcpServerInstructions, mcpServerVersion, mcpToolDescriptions, mcpToolNames } from "../src/mcp-server.js";
import { packageVersion } from "../src/version.js";

test("MCP tool名を固定する", () => {
  assert.deepEqual(mcpToolNames, [
    "chatgpt_models",
    "chatgpt_chat",
    "chatgpt_image",
    "chatgpt_close",
    "consult",
    "sessions",
    "diagnostics",
  ]);
});

test("MCPから親metadataを受け取り、モデル入力へ宛先パラメータを要求しない", async t => {
  const parent = { threadId: randomUUID(), socketPath: "/tmp/parent.sock" };
  let resolutions = 0;
  let consultations = 0;
  const unused = async (): Promise<never> => { throw new Error("未使用"); };
  const host = new LazyConnectorHost(undefined, undefined, async () => ({
    models: unused, chat: unused, image: unused, diagnostics: unused, closeSession: unused,
    sessions: (): never => { throw new Error("未使用"); }, close: () => {}, shutdown: async () => {},
    consult: async (input, target) => {
      consultations++;
      assert.deepEqual(target, input.dryRun ? undefined : parent);
      return { slug: input.slug, state: "running", result: null, error: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    },
  }));
  const server = createGptConnectorMcpServer(host, (name, meta) => {
    resolutions++;
    assert.equal(name, "codex-mcp-client");
    assert.equal((meta as { threadId: string }).threadId, parent.threadId);
    return parent;
  });
  const client = new Client({ name: "codex-mcp-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const consult = tools.tools.find(tool => tool.name === "consult")!;
  assert.match(consult.description!, /10秒.*自動Steer.*監視ループは不要/u);
  assert.equal("parent" in consult.inputSchema.properties!, false);
  const result = await client.callTool({ name: "consult", arguments: { slug: "mcp-parent", prompt: "相談" }, _meta: { threadId: parent.threadId } });
  assert.equal(result.isError, undefined);
  await client.callTool({ name: "consult", arguments: { slug: "mcp-dryrun", prompt: "確認", dryRun: true } });
  assert.equal(resolutions, 1);
  assert.equal(consultations, 2);
});

test("MCP server versionをpackage公開versionと一致させる", () => {
  assert.equal(mcpServerVersion, packageVersion);
});

test("server instructionsは冒頭でChatGPT専用のprovider境界を宣言する", () => {
  const head = mcpServerInstructions.slice(0, 80);
  assert.match(head, /ChatGPT/u);
  assert.match(head, /専用/u);
  assert.match(mcpServerInstructions, /chatgpt_models/u);
});

test("tool discovery textへ他provider固有名を混入させない", () => {
  const discoveryText = [
    mcpServerInstructions,
    chatgptModelFieldDescription,
    chatgptEffortFieldDescription,
    ...Object.values(mcpToolDescriptions),
  ].join("\n");
  assert.doesNotMatch(discoveryText, /Anthropic|Claude|Fable|Opus|Sonnet|Haiku|Gemini/iu);
});

test("model fieldはChatGPT slug以外を受け付けないとcallerへ明示する", () => {
  assert.match(chatgptModelFieldDescription, /chatgpt_models/u);
  assert.match(chatgptModelFieldDescription, /MODEL_NOT_AVAILABLE/u);

  // callerへ実際に届くJSON Schemaに載ることまで固定する。
  for (const schema of [consultInputSchema, imageInputSchema]) {
    const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as {
      properties: Record<string, { description?: string } | undefined>;
    };
    assert.equal(jsonSchema.properties.model?.description, chatgptModelFieldDescription);
    assert.match(jsonSchema.properties.effort?.description ?? "", /chatgpt_models/u);
  }
});

test("公開MCP schemaは最新の段階と省略時の右端を案内する", () => {
  for (const schema of [chatInputSchema, consultInputSchema]) {
    const json = z.toJSONSchema(schema, { io: "input" }) as { properties: Record<string, { description?: string }> };
    assert.equal(json.properties.level?.description, chatgptLevelFieldDescription);
    assert.match(json.properties.level?.description ?? "", /省略時は最新スライダーの右端/u);
  }
});

test("公開MCP schemaから受付ID・会話の継続・前提の再送省略を認識できる", () => {
  for (const schema of [chatInputSchema, consultInputSchema]) {
    const json = z.toJSONSchema(schema, { io: "input" }) as { properties: Record<string, { description?: string }> };
    assert.equal(json.properties.sessionId?.description, chatgptSessionFieldDescription);
    assert.match(json.properties.sessionId?.description ?? "", /再送は不要/u);
    assert.match(json.properties.keepOpen?.description ?? "", /chatgpt_close/u);
  }
  const json = z.toJSONSchema(consultInputSchema, { io: "input" });
  assert.match(JSON.stringify(json.properties?.wait), /受付/u);
  assert.match(mcpToolDescriptions.consult, /同じsessionId・新しいslug/u);
  assert.match(mcpServerInstructions, /slugは1問い合わせ.*sessionIdは複数問い合わせ/u);
});
