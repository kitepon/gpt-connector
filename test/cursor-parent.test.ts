import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cursorParentFromRequest,
  cursorReceiveCommand,
  deliverCursorAnswer,
  isCursorMcpClient,
  receiveCursorAnswer,
  verifyCursorParent,
} from "../src/cursor-parent.js";
import { parentFromRequest } from "../src/codex-parent.js";
import { resolveDeliveryParent } from "../src/mcp-server.js";
import { ConsultJobStore } from "../src/consult-job-store.js";

test("Cursor client名だけをCursor親と判定し、Codex clientは触らない", () => {
  assert.equal(isCursorMcpClient("cursor-vscode"), true);
  assert.equal(isCursorMcpClient("cursor-vscode (via mcp-remote 0.1.29)"), true);
  assert.equal(isCursorMcpClient("codex-mcp-client"), false);
  assert.equal(isCursorMcpClient("claude-code"), false);
  assert.equal(cursorParentFromRequest("codex-mcp-client"), null);
  assert.equal(parentFromRequest("cursor-vscode", {}), null);
});

test("resolveDeliveryParentはCodexを先に、Cursorはclient名だけで返す", () => {
  const threadId = randomUUID();
  const codex = resolveDeliveryParent("codex-mcp-client", { threadId }, "/tmp/state");
  assert.ok(codex && "threadId" in codex);
  assert.equal(codex.threadId, threadId);

  const cursor = resolveDeliveryParent("cursor-vscode", {}, "/tmp/state");
  assert.ok(cursor && "socketRoot" in cursor);
  assert.equal(cursor.socketRoot, join("/tmp/state", "cp"));

  assert.equal(resolveDeliveryParent("claude-code", {}, "/tmp/state"), null);
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

test("Cursor親のreserveだけがreceiveCommandを付け、Codex親には付けない", async t => {
  const root = await mkdtemp(join(tmpdir(), "gpt-cursor-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cursorStore = new ConsultJobStore({ stateDirectory: root });
  await cursorStore.initialize();
  const cursor = await cursorStore.reserve("cursor-slug", "fp-cursor", {
    socketRoot: join(root, "cp"),
  });
  assert.equal(cursor.created, true);
  assert.ok(cursor.snapshot.delivery?.id);
  assert.equal(
    cursor.snapshot.receiveCommand,
    cursorReceiveCommand(cursor.snapshot.delivery!.id, root),
  );
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
  codexStore.close();
});
