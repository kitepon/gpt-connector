import assert from "node:assert/strict";
import test from "node:test";

import { grokChatInputSchema, grokConsultInputSchema } from "../src/contract.js";

test("Grok Chatのmode省略時はauto、指定時はChat modeを保持する", () => {
  assert.equal(grokChatInputSchema.parse({ prompt: "質問" }).mode, "auto");
  assert.equal(grokConsultInputSchema.parse({ prompt: "質問", slug: "mode-test", mode: "heavy" }).mode, "heavy");
});

test("Grok Buildと未知のmodeはChat送信前に拒否する", () => {
  assert.equal(grokChatInputSchema.safeParse({ prompt: "質問", mode: "build" }).success, false);
  assert.equal(grokConsultInputSchema.safeParse({ prompt: "質問", slug: "mode-test", mode: "unknown" }).success, false);
});
