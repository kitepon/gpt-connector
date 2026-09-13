#!/usr/bin/env node
// DesktopのJSONLと公式App ServerのUnix WebSocketの中継。RPCの内容は変更しない。
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { preparePosixRelayLaunch } from "./codex-steer-launcher.js";
import { relayCodexStdio } from "./codex-relay-stdio.js";
import { prepareRelayDirectory } from "./codex-steer-config.js";

export async function runCodexStdioRelay(socketPath: string, serverPid: number): Promise<void> {
  await relayCodexStdio({
    alive: () => process.ppid === serverPid,
    socket: () => new WebSocket("ws://localhost/rpc", {
      createConnection: () => createConnection(socketPath), handshakeTimeout: 10_000, perMessageDeflate: false,
    }),
    stop: async () => {
      // 公式Unix受付は1回目でturn完了待ち、2回目で終了する。
      for (let i = 0; i < 2; i++) {
        if (process.ppid !== serverPid) return;
        try { process.kill(serverPid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
        if (i === 0) await delay(100);
      }
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [socket, pid, ...args] = process.argv.slice(2);
  if (socket === "--prepare") {
    // 導入済みのMac launcherが使う入口と動作を維持する。
    try {
      if (process.platform === "win32") throw new Error("WindowsのAF_UNIX中継は未対応です");
      if (!pid || Buffer.byteLength(`${pid}/9999999999.sock`) >= 104) throw new Error("socketのpathが長すぎます");
      prepareRelayDirectory(pid);
    } catch (error) { process.stderr.write(`gpt-connector-relay: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  } else if (socket === "--launch") {
    try {
      if (process.platform === "win32") throw new Error("WindowsのAF_UNIX中継は未対応です");
      if (!pid || args.length < 4) throw new Error("中継の起動指定がありません");
      process.stdout.write(preparePosixRelayLaunch(pid, args[0]!, args[1]!, args[2]!, args[3]!, args.slice(4)));
    } catch (error) { process.stderr.write(`gpt-connector-relay: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  } else if (!socket || !/^\d+$/.test(pid ?? "") || Number(pid) <= 1 || Number(pid) !== process.ppid) {
    process.stderr.write("gpt-connector-relay: 親processの指定が不正です\n"); process.exitCode = 2;
  } else await runCodexStdioRelay(socket, Number(pid));
}
