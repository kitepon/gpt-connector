import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cursorReceiveCommand as legacyCursorReceiveCommand,
  deliverCursorAnswer,
  isCursorMcpClient,
  receiveCursorAnswer,
  verifyCursorParent,
} from "../src/cursor-parent.js";
import { parentFromRequest } from "../src/codex-parent.js";
import { resolveDeliveryParent } from "../src/mcp-server.js";
import { ConsultJobStore } from "../src/consult-job-store.js";
import { cursorHookParentFromRequest } from "../src/cursor-parent-receiver.js";

async function registeredHooks(root: string): Promise<string> {
  const file = join(root, "hooks.json");
  const entry = { command: "'node' '/x/gpt-connector-cursor-parent-hook.js'", timeout: 15 };
  await writeFile(file, JSON.stringify({ version: 1, hooks: { afterMCPExecution: [entry], postToolUse: [entry] } }));
  return file;
}

test("Cursor client名だけをCursor親と判定し、Codex clientは触らない", () => {
  assert.equal(isCursorMcpClient("cursor-vscode"), true);
  assert.equal(isCursorMcpClient("cursor-vscode (via mcp-remote 0.1.29)"), true);
  assert.equal(isCursorMcpClient("codex-mcp-client"), false);
  assert.equal(isCursorMcpClient("claude-code"), false);
  assert.equal(cursorHookParentFromRequest("codex-mcp-client"), null);
  assert.equal(parentFromRequest("cursor-vscode", {}), null);
});

test("resolveDeliveryParentはCodexを先に返し、Cursor以外のclientには親を作らない", () => {
  const threadId = randomUUID();
  const codex = resolveDeliveryParent("codex-mcp-client", { threadId });
  assert.ok(codex && "threadId" in codex);
  assert.equal(codex.threadId, threadId);
  assert.equal(resolveDeliveryParent("claude-code", {}), null);
});

test("Cursor親は公式hookの登録を確かめてから共通の受け口を返し、未登録なら送信前に止める", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-parent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooksFile = await registeredHooks(root);
  assert.deepEqual(cursorHookParentFromRequest("cursor-vscode", { hookRoot: join(root, "hooks"), hooksFile }),
    { kind: "cursor", hook_root: join(root, "hooks") });
  // Cursor CLIはclientInfo.nameを"Cursor"と名乗る。
  assert.deepEqual(cursorHookParentFromRequest("Cursor", { hookRoot: join(root, "hooks"), hooksFile }),
    { kind: "cursor", hook_root: join(root, "hooks") });
  assert.equal(cursorHookParentFromRequest("cursor", { hookRoot: join(root, "hooks"), hooksFile }), null);
  assert.throws(() => cursorHookParentFromRequest("cursor-vscode", { hookRoot: join(root, "hooks"), hooksFile: join(root, "missing.json") }),
    { code: "PARENT_DELIVERY_UNAVAILABLE" });
});

test("Cursor配送socketは押し込み側が本文を届け、受け口は一度だけ受け取る", async t => {
  // sun_path上限のため、短い絶対pathを使う。
  const root = join("/tmp", `gc-c-${randomUUID().replaceAll("-", "").slice(0, 12)}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = { socketRoot: root };
  await verifyCursorParent(parent);
  const deliveryId = randomUUID();
  const text = "gpt-connectorから依頼済み相談の完了通知です。";

  const delivering = deliverCursorAnswer(parent, deliveryId, text, { outcome: "succeeded", timeoutMs: 5_000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const message = await receiveCursorAnswer(parent, deliveryId, { timeoutMs: 5_000 });
  await delivering;
  assert.deepEqual(message, { deliveryId, text, outcome: "succeeded" });
});

test("Cursor親のreserveだけが受け口を付け、旧受付は旧受け口、新受付は共通の受け口を指す", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cursorStore = new ConsultJobStore({ stateDirectory: root });
  await cursorStore.initialize();
  const legacy = await cursorStore.reserve("legacy-slug", "fp-legacy", { socketRoot: join(root, "cp") });
  assert.equal(legacy.snapshot.receiveCommand, legacyCursorReceiveCommand(legacy.snapshot.delivery!.id, root));
  assert.equal(legacy.snapshot.parent_delivery, undefined);

  const hookRoot = join(root, "cursor-parent-hooks");
  const current = await cursorStore.reserve("cursor-slug", "fp-cursor", { kind: "cursor", hook_root: hookRoot });
  const deliveryId = current.snapshot.delivery!.id;
  assert.equal(current.snapshot.parent_delivery?.delivery_id, deliveryId);
  assert.match(current.snapshot.parent_delivery!.wait_process.args[0]!, /cursor-parent-receive\.js$/u);
  assert.deepEqual(current.snapshot.parent_delivery!.wait_process.args.slice(1), ["--delivery", deliveryId]);
  assert.match(current.snapshot.receiveCommand!, /cursor-parent-receive\.js' '?--delivery/u);
  assert.equal(existsSync(join(hookRoot, "deliveries", deliveryId)), true);
  cursorStore.close();

  const codexRoot = await mkdtemp(join(tmpdir(), "gpt-codex-jobs-"));
  t.after(() => rm(codexRoot, { recursive: true, force: true }));
  const codexStore = new ConsultJobStore({ stateDirectory: codexRoot });
  await codexStore.initialize();
  const codex = await codexStore.reserve("codex-slug", "fp-codex", {
    threadId: randomUUID(),
    codexHome: join(codexRoot, "codex-home"),
  });
  assert.equal(codex.created, true);
  assert.ok(codex.snapshot.delivery?.id);
  assert.equal(codex.snapshot.receiveCommand, undefined);
  assert.equal(codex.snapshot.parent_delivery, undefined);
  codexStore.close();
});
