import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  chatgptModelFieldDescription,
  consultInputSchema,
  imageInputSchema,
} from "../src/contract.js";
import { mcpServerInstructions, mcpServerVersion, mcpToolNames } from "../src/mcp-server.js";
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

test("MCP server versionをpackage公開versionと一致させる", () => {
  assert.equal(mcpServerVersion, packageVersion);
});

test("server instructionsは冒頭でChatGPT専用のprovider境界を宣言する", () => {
  // 中立名のconsult／sessions／diagnosticsが他providerの用途を吸い込まないよう、
  // scope宣言を先頭に置き、代表的な誤爆先を名指しで除外する。
  const head = mcpServerInstructions.slice(0, 80);
  assert.match(head, /ChatGPT/u);
  assert.match(head, /専用/u);
  assert.match(mcpServerInstructions, /Claude/u);
  assert.match(mcpServerInstructions, /Fable/u);
  assert.match(mcpServerInstructions, /Gemini/u);
  assert.match(mcpServerInstructions, /本serverのtoolを呼ばず/u);
});

test("model fieldはChatGPT slug以外を受け付けないとcallerへ明示する", () => {
  assert.match(chatgptModelFieldDescription, /chatgpt_models/u);
  assert.match(chatgptModelFieldDescription, /claude-\*/u);
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
