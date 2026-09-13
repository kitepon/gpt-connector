// MacのJSONL中継を共通化する。OS差は接続・生存確認・終了APIだけ。
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import type WebSocket from "ws";

export async function relayCodexStdio(adapter: {
  socket: () => WebSocket; alive: () => boolean; stop: () => Promise<void>; connected?: () => void;
}): Promise<void> {
  let socket: WebSocket | undefined;
  let ending = false;
  let stopping: Promise<void> | undefined;
  function stopServer(): Promise<void> {
    return stopping ??= adapter.stop();
  }
  async function connectDuringStartup(): Promise<WebSocket> {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (!adapter.alive()) throw new Error("公式App Serverが起動中に終了しました");
      const candidate = adapter.socket();
      try { await once(candidate, "open"); return candidate; }
      catch (error) {
        candidate.on("error", () => {});
        candidate.terminate();
        // exec直後のsocket作成だけを待つ。送信済みRPCは再送しない。
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
        await delay(25);
      }
    }
  }
  try {
    socket = await connectDuringStartup();
    const connected = socket;
    connected.on("message", (data, binary) => {
      if (binary) {
        process.stderr.write("gpt-connector-relay: 予期しないバイナリ応答\n"); process.exitCode = 1;
        void stopServer(); connected.terminate(); return;
      }
      if (!process.stdout.write(`${data.toString()}\n`)) connected.pause();
    });
    process.stdout.on("drain", () => connected.resume());
    connected.on("error", () => {
      process.stderr.write("gpt-connector-relay: 通信に失敗しました\n"); process.exitCode = 1; void stopServer();
    });
    connected.on("close", () => {
      if (!ending) { process.stderr.write("gpt-connector-relay: 公式App Serverとの接続が終了しました\n"); process.exitCode = 1; }
      process.stdin.destroy();
    });
    process.stdout.on("error", () => { ending = true; void stopServer(); connected.terminate(); process.stdin.destroy(); });
    adapter.connected?.();
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      await new Promise<void>((resolve, reject) => connected.send(line, error => error ? reject(error) : resolve()));
    }
    ending = true;
    await stopServer();
    connected.terminate();
  } catch (error) {
    process.stderr.write(`gpt-connector-relay: 中継失敗: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    await stopServer();
    socket?.terminate();
    process.stdin.destroy();
  }
}
