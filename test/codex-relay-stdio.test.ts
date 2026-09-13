import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";

for (const mode of ["eof", "server-close", "binary"]) test(`共通中継: 本文とRPCの往復を保持し、${mode}をMacと同じく扱う`, { timeout: 10_000 }, async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connected = once(server, "connection");
  const child = spawn(process.execPath, ["--import", "tsx", resolve("test/fixtures/codex-relay/stdio.ts"), `ws://127.0.0.1:${address.port}`], { windowsHide: true });
  const exited = once(child, "close");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    lines.close();
  });
  // 接続準備前の入力も、JSONを解釈し直さず同じ本文で渡す。
  const request = '{"id":42, "method":"initialize", "params":{"text":"空白 日本語"}}';
  const response = '{"id":42,"result":{"accepted":true}}';
  const fromDesktop: string[] = [];
  server.on("connection", socket => socket.on("message", data => { fromDesktop.push(data.toString()); socket.send(response); }));
  const first = once(lines, "line");
  child.stdin.write(request + "\n");
  const [socket] = await connected;
  assert.equal((await first)[0], response);
  assert.deepEqual(fromDesktop, [request]);
  // 公式側から来る承認要求も同じ行をそのままDesktopへ返す。
  const approval = '{"id":42,"method":"item/commandExecution/requestApproval","params":{}}';
  const next = once(lines, "line");
  socket.send(approval);
  assert.equal((await next)[0], approval);
  if (mode === "eof") child.stdin.end();
  else if (mode === "server-close") socket.close();
  else socket.send(Buffer.from([0, 1, 2]));
  assert.equal((await exited)[0], mode === "eof" ? 0 : 1, stderr);
  // Mac正本は、サーバーが先に接続を閉じた時には停止APIを呼ばない。
  assert.equal(stderr.split("停止API").length - 1, mode === "server-close" ? 0 : 1);
  if (mode === "server-close") assert.match(stderr, /接続が終了しました/);
  if (mode === "binary") assert.match(stderr, /バイナリ応答/);
});
