import assert from "node:assert/strict";
import test from "node:test";
import { createLedgerHttpTransport } from "../src/update-ledger-http.js";
import { ledgerOrigin, productPaths } from "../src/update-ledger-sender.js";

for (const kind of ["non-JSON", "oversized Content-Length"] as const) {
  test(`GPT-HTTP-CLEANUP-1: unfinished 200 ${kind} is safely rejected and disposed within the original deadline`, async () => {
    const identity = { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner: { system: "bellteam", id: "bot-7696018a" }, execution_prefix: "/synthetic/install" };
    const path = productPaths(identity.product_id).get;
    let cancelled = 0, requests = 0;
    let requestSignal: AbortSignal | undefined;
    const transport = createLedgerHttpTransport(identity, { timeout_ms: 100, assertActive: async () => {},
      credential: async () => ({ product_id: identity.product_id, owner: identity.owner as { system: "bellteam"; id: "bot-7696018a" }, bearer: "SYNTHETIC_CREDENTIAL_NOT_REAL" }),
      fetch: async (_url, options) => {
        requests++; requestSignal = options!.signal!;
        const headers: Record<string, string> = kind === "non-JSON" ? { "content-type": "text/html" } : { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) };
        // No chunks and no close: neither header rejection can rely on the server finishing the response.
        const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200, headers });
        Object.defineProperty(response, "url", { value: ledgerOrigin + path }); return response;
      } });
    await assert.rejects(transport.get(path, new AbortController().signal), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, "ledger_http_response");
      assert.equal(error.cause, undefined); assert.equal(String(error.stack).includes("SYNTHETIC_CREDENTIAL"), false); return true;
    });
    assert.equal(requests, 1);
    assert.ok(cancelled > 0 || requestSignal?.aborted, `body not disposed: cancel=${cancelled}, signalAbort=${requestSignal?.aborted}`);
    console.log(JSON.stringify({ case: kind, safe_error: "ledger_http_response", body_cancel_calls: cancelled, request_signal_aborted: requestSignal?.aborted,
      deadline_ms_unchanged: 100, one_request: requests, unfinished_stream: true }));
  });
}
