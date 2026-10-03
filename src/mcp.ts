#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createGptConnectorMcpServer, LazyConnectorHost, LazyGrokConnectorHost } from "./mcp-server.js";
import { reportRuntimeErrorsBestEffort } from "./runtime-error-reporting.js";

const endpoint = process.env.GPT_CONNECTOR_CDP_ENDPOINT ?? "http://127.0.0.1:9223";
const host = new LazyConnectorHost(
  endpoint,
  process.env.GPT_CONNECTOR_STATE_DIR,
);
const grokHost = new LazyGrokConnectorHost(endpoint, process.env.GPT_CONNECTOR_STATE_DIR);
const server = createGptConnectorMcpServer(host, undefined, grokHost);

async function shutdown(): Promise<void> {
  await Promise.all([host.shutdown(), grokHost.shutdown()]);
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

const transport = new StdioServerTransport();
await server.connect(transport);
// 前の利用で送れなかった記録が残っていれば、起動時に送る。送信が無効な端末では通信しない。
void reportRuntimeErrorsBestEffort();
