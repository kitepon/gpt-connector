import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { deliverCodexAnswer, findParentSocket, parentFromRequest, verifyCodexParent, withCodexParent } from "../src/codex-parent.js";

async function fixture(t: TestContext, mode = "ready") {
  const root = await mkdtemp(join(tmpdir(), "gpt-parent-"));
  await chmod(root, 0o700);
  const parent = { threadId: randomUUID(), socketPath: join(root, "rpc.sock") };
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  ws.on("connection", socket => socket.on("message", bytes => {
    const value = JSON.parse(bytes.toString());
    if (!value.id) return;
    calls.push(value);
    // 親用の承認要求はIDが文字列でも無視し、応答と取り違えない。
    socket.send(JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: {} }));
    const respond = (result: unknown) => socket.send(JSON.stringify({ id: value.id, result }));
    switch (value.method) {
      case "initialize": respond({}); break;
      case "thread/loaded/list": respond({ data: mode === "unloaded" ? [] : [parent.threadId] }); break;
      case "thread/read": respond({ thread: { id: parent.threadId, source: mode === "native" ? { subAgent: { thread_spawn: {} } } : "vscode" } }); break;
      case "turn/start":
        if (mode === "disconnect") socket.terminate();
        else if (mode === "reject") socket.send(JSON.stringify({ id: value.id, error: { code: -1, message: "拒否" } }));
        else if (mode === "bad-result") respond({});
        else if (mode !== "timeout") respond({ turn: { id: randomUUID() } });
    }
  }));
  http.listen(parent.socketPath);
  await once(http, "listening");
  await chmod(parent.socketPath, 0o600);
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => http.close(() => resolve())));
    await rm(root, { recursive: true, force: true });
  });
  return { parent, calls };
}

test("宛先を要求metadataと同じ親のsocketに限定する", async t => {
  assert.equal(parentFromRequest("other-client", { threadId: randomUUID() }), null);
  assert.throws(() => parentFromRequest("codex-mcp-client", {}), { code: "PARENT_DELIVERY_UNAVAILABLE" });
  if (process.platform === "win32") return;
  const f = await fixture(t);
  assert.equal(findParentSocket([
    { pid: 3, parent_pid: 2, command: "node gpt-connector-mcp" },
    { pid: 2, parent_pid: 1, command: `codex app-server --listen unix://${f.parent.socketPath}` },
  ], 3), f.parent.socketPath);
  assert.throws(() => findParentSocket([{ pid: 3, parent_pid: 1, command: "node" }], 3), /gpt-connector setup/u);
});

test("公式受付へ一度だけturn/startを送り、モデルや権限を変更しない", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await verifyCodexParent(f.parent);
  const text = "日本語の回答\n".repeat(20_000);
  const id = randomUUID();
  await deliverCodexAnswer(f.parent, id, text);
  const writes = f.calls.filter(call => call.method === "turn/start");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.params, { threadId: f.parent.threadId, clientUserMessageId: id, input: [{ type: "text", text, text_elements: [] }] });
  assert.ok(f.calls.every(call => ["initialize", "thread/loaded/list", "thread/read", "turn/start"].includes(call.method)));
});

for (const mode of ["unloaded", "native", "reject", "disconnect", "bad-result"]) test(`親配送の${mode}を明示し再送しない`, { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, mode);
  await assert.rejects(deliverCodexAnswer(f.parent, randomUUID(), "結果"), {
    code: ["disconnect", "bad-result"].includes(mode) ? "PARENT_DELIVERY_UNKNOWN" : "PARENT_DELIVERY_UNAVAILABLE",
  });
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, ["unloaded", "native"].includes(mode) ? 0 : 1);
});

test("書込み後の受付timeoutはunknownにする", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, "timeout");
  await assert.rejects(withCodexParent(f.parent, request => request("turn/start", {}), 50), { code: "PARENT_DELIVERY_UNKNOWN" });
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 1);
});
