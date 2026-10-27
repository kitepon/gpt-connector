import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setup, verifyMcp } from "../src/setup.js";
import { setupTools } from "../src/setup-registration.js";
import { packageVersion } from "../src/version.js";
import { runtimeDiagnostics } from "../src/runtime-diagnostics.js";

for (const substep of ["connect", "version", "tools", "diagnostics", "stderr", "close", "tools_with_close"] as const) {
  test(`setup MCP ${substep}: 固定substepを返し、先行失敗をcloseで失わない`, async (t) => {
    t.mock.method(Client.prototype, "connect", async (transport: StdioClientTransport) => {
      if (substep === "connect") throw new Error("private-connect-token");
      if (substep === "stderr") transport.stderr?.emit("data", Buffer.from("private-stderr-token"));
    });
    t.mock.method(Client.prototype, "getServerVersion", () => ({ name: "fixture", version: substep === "version" ? "0.0.0" : packageVersion }));
    t.mock.method(Client.prototype, "listTools", async () => {
      if (substep === "tools" || substep === "tools_with_close") throw new Error("private-tools-token");
      return { tools: setupTools.map(name => ({ name, inputSchema: { type: "object" as const } })) };
    });
    t.mock.method(Client.prototype, "callTool", async () => ({ isError: substep === "diagnostics", content: [{ type: "text", text: JSON.stringify(runtimeDiagnostics()) }] }));
    t.mock.method(Client.prototype, "close", async () => {
      if (substep === "close" || substep === "tools_with_close") throw new Error("private-close-token");
    });
    const unexpected = async (): Promise<never> => { throw new Error("unexpected browser/hook/read"); };
    const result = await setup({ clients: ["claude"] }, {
      platform: "linux",
      register: async (client, command, args, path) => ({ client, path, backup: null, status: "unchanged", server: { command, args, env: {} } }),
      read: unexpected, verify: verifyMcp, state: async () => "ready", browser: unexpected, steer: unexpected,
      cursorHooks: (): never => { throw new Error("unexpected hook"); },
    });
    const expectedStep = substep === "tools_with_close" ? "tools" : substep;
    assert.equal(result.overall, "failed");
    assert.deepEqual(result.registrations[0]?.failure, { stage: "mcp", code: "SETUP_MCP_FAILED", substep: expectedStep,
      reason_code: `MCP_${expectedStep.toUpperCase()}_FAILED`, close_failed: substep === "close" || substep === "tools_with_close" });
    assert.doesNotMatch(JSON.stringify(result), /private-|token|stderr-token/u);
    console.log("SAFE_SETUP_FAILURE_JSON", JSON.stringify(result));
  });
}
