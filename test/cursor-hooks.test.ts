import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindCursorConversation,
  claimCursorInbox,
  readCursorBinding,
  writeCursorInbox,
} from "../src/cursor-inbox.js";
import { handleCursorHookInput } from "../src/cursor-hook.js";
import {
  configureCursorHooks,
  cursorHookCommand,
  mergeCursorParentHooks,
} from "../src/setup-cursor-hooks.js";

test("Cursor受信箱はhookが原子的に奪い、二度目は空", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const conversationId = "conv-1";
  const deliveryId = randomUUID();
  await bindCursorConversation(deliveryId, conversationId, "slug-a", root);
  assert.deepEqual(await readCursorBinding(deliveryId, root), {
    conversationId,
    slug: "slug-a",
  });
  await writeCursorInbox({
    deliveryId,
    conversationId,
    slug: "slug-a",
    text: "本文A",
    outcome: "succeeded",
    createdAt: "2026-09-22T00:00:00.000Z",
  }, root);
  const first = await claimCursorInbox(conversationId, "hook", root);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.text, "本文A");
  assert.equal((await claimCursorInbox(conversationId, "hook", root)).length, 0);
});

test("afterMCPExecutionはconsult結果からconversationを結び、postToolUseは本文を返す", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deliveryId = randomUUID();
  const conversationId = "conv-hook-1";
  const bind = await handleCursorHookInput(JSON.stringify({
    hook_event_name: "afterMCPExecution",
    conversation_id: conversationId,
    tool_name: "consult",
    mcp_server_name: "gpt_connector",
    tool_input: { prompt: "x", slug: "slug-b" },
    result_json: {
      content: [{
        type: "text",
        text: JSON.stringify({
          slug: "slug-b",
          state: "running",
          delivery: { id: deliveryId, mode: "steer", state: "waiting", error: null },
          receiveCommand: "gpt-connector cursor-receive --delivery x",
        }),
      }],
    },
    duration: 10,
  }), root);
  assert.deepEqual(bind, {});
  assert.deepEqual(await readCursorBinding(deliveryId, root), {
    conversationId,
    slug: "slug-b",
  });

  await writeCursorInbox({
    deliveryId,
    conversationId,
    slug: "slug-b",
    text: "gpt-connectorから依頼済み相談の完了通知です。",
    outcome: "succeeded",
    createdAt: "2026-09-22T00:00:01.000Z",
  }, root);

  const injected = await handleCursorHookInput(JSON.stringify({
    hook_event_name: "postToolUse",
    conversation_id: conversationId,
    tool_name: "Read",
    tool_input: { path: "/tmp/x" },
    tool_output: "{}",
    duration: 1,
  }), root);
  assert.equal(
    injected.additional_context,
    "gpt-connectorから依頼済み相談の完了通知です。",
  );

  const receive = await handleCursorHookInput(JSON.stringify({
    hook_event_name: "postToolUse",
    conversation_id: conversationId,
    tool_name: "Shell",
    tool_input: { command: "gpt-connector cursor-receive --delivery x" },
    tool_output: "{}",
    duration: 1,
  }), root);
  assert.deepEqual(receive, {});
});

test("Cursor hooks登録は自分の2本だけを末尾へ足し、再実行で位置を動かさない", async t => {
  const home = await mkdtemp(join(tmpdir(), "gpt-cursor-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "hooks.json");
  const foreign = {
    version: 1,
    hooks: {
      postToolUse: [{ command: "foreign-post", timeout: 10 }],
      beforeShellExecution: [{ command: "foreign-shell", timeout: 5 }],
    },
  };
  await import("node:fs/promises").then(fs =>
    fs.writeFile(file, `${JSON.stringify(foreign, null, 2)}\n`));

  const command = cursorHookCommand("gpt-connector");
  assert.equal(mergeCursorParentHooks(file, command), true);
  const once = JSON.parse(await readFile(file, "utf8")) as {
    hooks: Record<string, Array<{ command: string }>>;
  };
  assert.equal(once.hooks.postToolUse?.length, 2);
  assert.equal(once.hooks.postToolUse?.[0]?.command, "foreign-post");
  assert.equal(once.hooks.postToolUse?.[1]?.command, command);
  assert.equal(once.hooks.afterMCPExecution?.length, 1);
  assert.equal(once.hooks.afterMCPExecution?.[0]?.command, command);
  assert.equal(once.hooks.beforeShellExecution?.[0]?.command, "foreign-shell");

  assert.equal(mergeCursorParentHooks(file, command), false);
  const twice = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(twice, once);

  const status = configureCursorHooks({
    check: true,
    home,
    env: { CURSOR_HOME: home },
    bin: "gpt-connector",
  });
  assert.equal(status.status, "ready");
});
