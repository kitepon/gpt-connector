import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindCursorConversation,
  claimCursorInbox,
  readCursorBinding,
  writeCursorInbox,
} from "../src/cursor-inbox.js";
import * as steer from "aiterm-steer-delivery";
import { handleCursorHookInput, handleCursorParentHook } from "../src/cursor-hook.js";
import { prepareCursorHookDelivery, submitCursorHookAnswer } from "../src/cursor-parent-receiver.js";
import { configureCursorHooks } from "../src/setup-cursor-hooks.js";

function consultResult(deliveryId: string, slug: string) {
  return { content: [{ type: "text", text: JSON.stringify({
    slug, state: "running", delivery: { id: deliveryId, mode: "steer", state: "waiting", error: null },
    parent_delivery: { delivery_id: deliveryId, wait_process: { executable: "node", args: ["/x/cursor-parent-receive.js", "--delivery", deliveryId], windows_start_process_argument_list: null } },
  }) }] };
}

function postToolUse(conversationId: string, toolName = "Read") {
  return JSON.stringify({ hook_event_name: "postToolUse", conversation_id: conversationId, tool_name: toolName, tool_input: {}, tool_output: "{}", duration: 1 });
}

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

test("新しい受付はhookが会話へ結び、作業中は次のツール返りへ一度だけ差し込む", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-hook-new-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = { kind: "cursor" as const, hook_root: join(root, "hooks") };
  const legacyState = join(root, "legacy");
  const deliveryId = randomUUID();
  const conversationId = "conv-new-1";
  prepareCursorHookDelivery(parent, deliveryId);

  // WindowsのCursorはBOM付きJSONを渡す。
  const bound = await handleCursorParentHook("\uFEFF" + JSON.stringify({
    hook_event_name: "afterMCPExecution", conversation_id: conversationId, tool_name: "consult",
    mcp_server_name: "gpt_connector", tool_input: {}, result_json: consultResult(deliveryId, "slug-new"), duration: 5,
  }), { hookRoot: parent.hook_root, legacyStateDirectory: legacyState });
  assert.deepEqual(bound, {});
  // 新しい受付は旧方式の受信箱へ結ばない。
  assert.equal(await readCursorBinding(deliveryId, legacyState), null);

  const submitted = submitCursorHookAnswer(parent, deliveryId, "gpt-connectorから依頼済み相談の完了通知です。新");
  await new Promise(resolve => setTimeout(resolve, 50));
  const injected = await handleCursorParentHook("\uFEFF" + postToolUse(conversationId), { hookRoot: parent.hook_root, legacyStateDirectory: legacyState });
  assert.equal(injected.additional_context, "gpt-connectorから依頼済み相談の完了通知です。新");
  await submitted;
  assert.deepEqual(await handleCursorParentHook(postToolUse(conversationId), { hookRoot: parent.hook_root, legacyStateDirectory: legacyState }), {});
});

test("idle中は背景の受信processが回答を受け取り、hookは同じ回答を重ねない", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-hook-idle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = { kind: "cursor" as const, hook_root: join(root, "hooks") };
  const deliveryId = randomUUID();
  prepareCursorHookDelivery(parent, deliveryId);
  await handleCursorParentHook(JSON.stringify({
    hook_event_name: "afterMCPExecution", conversation_id: "conv-idle", tool_name: "grok_consult",
    tool_input: {}, result_json: consultResult(deliveryId, "slug-idle"), duration: 5,
  }), { hookRoot: parent.hook_root, legacyStateDirectory: join(root, "legacy") });
  const receiving = steer.receiveCursorAnswer(parent.hook_root, deliveryId, 5_000);
  await submitCursorHookAnswer(parent, deliveryId, "idle中の回答");
  assert.deepEqual(await receiving, { outcome: "delivered", text: "idle中の回答" });
  assert.deepEqual(await handleCursorParentHook(postToolUse("conv-idle"), { hookRoot: parent.hook_root, legacyStateDirectory: join(root, "legacy") }), {});
});

test("旧方式で受け付けた回答と新しい受付の回答を、同じツール返りへ並べて差し込む", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-hook-mixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = { kind: "cursor" as const, hook_root: join(root, "hooks") };
  const legacyState = join(root, "legacy");
  const conversationId = "conv-mixed";
  const legacyId = randomUUID();
  await bindCursorConversation(legacyId, conversationId, "slug-old", legacyState);
  await writeCursorInbox({ deliveryId: legacyId, conversationId, slug: "slug-old", text: "旧受付の回答", outcome: "succeeded", createdAt: "2026-09-29T00:00:00.000Z" }, legacyState);
  const deliveryId = randomUUID();
  prepareCursorHookDelivery(parent, deliveryId);
  await handleCursorParentHook(JSON.stringify({
    hook_event_name: "afterMCPExecution", conversation_id: conversationId, tool_name: "consult",
    tool_input: {}, result_json: consultResult(deliveryId, "slug-mixed"), duration: 5,
  }), { hookRoot: parent.hook_root, legacyStateDirectory: legacyState });
  const submitted = submitCursorHookAnswer(parent, deliveryId, "新受付の回答");
  await new Promise(resolve => setTimeout(resolve, 50));
  const injected = await handleCursorParentHook(postToolUse(conversationId), { hookRoot: parent.hook_root, legacyStateDirectory: legacyState });
  assert.equal(injected.additional_context, "新受付の回答\n\n旧受付の回答");
  await submitted;
});

test("Cursor hooks登録は旧い登録を同じ位置で置き換え、他製品のhookと再実行時の位置を保つ", async t => {
  const home = await mkdtemp(join(tmpdir(), "gpt-cursor-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "hooks.json");
  const legacyCommand = "'gpt-connector' cursor-hook";
  await writeFile(file, `${JSON.stringify({
    version: 1,
    hooks: {
      postToolUse: [{ command: legacyCommand, timeout: 5 }, { command: "foreign-post", timeout: 10 }],
      afterMCPExecution: [{ command: legacyCommand, timeout: 5, matcher: "consult" }],
      beforeShellExecution: [{ command: "foreign-shell", timeout: 5 }],
    },
  }, null, 2)}\n`);
  const runtime = { command: process.execPath, script: "/opt/gpt-connector/dist/src/gpt-connector-cursor-parent-hook.js" };
  const options = { home, env: { CURSOR_HOME: home }, runtime };
  assert.equal(configureCursorHooks({ ...options, check: true }).status, "disabled");

  assert.deepEqual(configureCursorHooks(options), { status: "ready", path: file, changed: true });
  const once = JSON.parse(await readFile(file, "utf8")) as { hooks: Record<string, Array<{ command: string }>> };
  const command = steer.cursorParentHookCommand(runtime);
  assert.deepEqual(once.hooks.postToolUse, [{ command, timeout: 15 }, { command: "foreign-post", timeout: 10 }]);
  assert.deepEqual(once.hooks.afterMCPExecution, [{ command, timeout: 15 }]);
  assert.deepEqual(once.hooks.beforeShellExecution, [{ command: "foreign-shell", timeout: 5 }]);
  assert.equal(configureCursorHooks({ ...options, check: true }).status, "ready");

  assert.deepEqual(configureCursorHooks(options), { status: "unchanged", path: file, changed: false });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), once);

  assert.equal(configureCursorHooks({ ...options, disable: true }).changed, true);
  const removed = JSON.parse(await readFile(file, "utf8")) as { hooks: Record<string, unknown> };
  assert.deepEqual(removed.hooks.postToolUse, [{ command: "foreign-post", timeout: 10 }]);
  assert.equal(removed.hooks.afterMCPExecution, undefined);
});
