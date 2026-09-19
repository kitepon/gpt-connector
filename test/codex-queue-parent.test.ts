import assert from "node:assert/strict";
import test from "node:test";
import { parentFromRequest } from "../src/codex-parent.js";

test("通常stdioで起動したCodexの要求は中継socketなしで宛先を決める", () => {
  const threadId = "11111111-2222-4333-8444-555555555555";
  const parent = parentFromRequest("codex-mcp-client", { threadId });
  assert.equal(parent?.threadId, threadId);
  assert.equal(parent && "socketPath" in parent, false);
});
