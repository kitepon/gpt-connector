import WebSocket from "ws";
import { relayCodexStdio } from "../../../src/codex-relay-stdio.js";

await relayCodexStdio({
  alive: () => true,
  socket: () => new WebSocket(process.argv[2]!, { perMessageDeflate: false }),
  stop: async () => { process.stderr.write("停止API\n"); },
});
