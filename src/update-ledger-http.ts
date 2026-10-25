import { canonical, identitySchema, sameIdentity, snapshotSchema, type LedgerPlan } from "./update-ledger-contract.js";
import { ledgerOrigin, productPaths, type ProductTransport } from "./update-ledger-sender.js";

type Identity = LedgerPlan["identity"];
export interface ScopedCredential {
  product_id: string;
  owner: Identity["owner"];
  bearer: string;
}
export interface LedgerHttpOptions {
  timeout_ms: number;
  credential(identity: Identity, signal: AbortSignal): Promise<ScopedCredential>;
  /** Future deployment-lease/activation guard. Called at execution, never at construction/import/check. */
  assertActive(identity: Identity, signal: AbortSignal): Promise<void>;
  fetch?: typeof globalThis.fetch;
}
const responseLimit = 1024 * 1024;
type HttpFailure = "ledger_http_input" | "ledger_http_aborted" | "ledger_http_timeout" | "ledger_http_scope" |
  "ledger_http_guard" | "ledger_http_credential" | "ledger_http_redirect" | "ledger_http_response" | "ledger_http_status" | "ledger_http_transport";
class LedgerHttpError extends Error {
  constructor(code: HttpFailure) { super(code); this.name = "LedgerHttpError"; }
}
function fail(code: HttpFailure): never { throw new LedgerHttpError(code); }

async function consumeResponse(response: Response, expectedUrl: string, signal: AbortSignal): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = []; let total = 0;
  const cancelBody = () => reader ? reader.cancel() : response.body?.cancel();
  const cancelOnAbort = () => { void cancelBody()?.catch(() => {}); };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    // Own disposal before any status/header rejection, including unfinished 200 bodies.
    reader = response.body?.getReader();
    signal.throwIfAborted();
    if (response.redirected || (response.status >= 300 && response.status < 400) || response.url !== expectedUrl) fail("ledger_http_redirect");
    if (!response.ok) fail("ledger_http_status");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > responseLimit)) fail("ledger_http_response");
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") || !reader) fail("ledger_http_response");
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > responseLimit) fail("ledger_http_response");
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener("abort", cancelOnAbort); await cancelBody()?.catch(() => {}); reader?.releaseLock(); }
}

/** Pure construction. There is no credential reference loader, environment lookup, retry or journal access. */
export function createLedgerHttpTransport(identityInput: unknown, options: LedgerHttpOptions): ProductTransport {
  const identity = identitySchema.parse(identityInput), paths = productPaths(identity.product_id);
  const { timeout_ms: timeout, credential: resolveCredential, assertActive, fetch: fetchImpl } = options;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 15000) fail("ledger_http_input");
  const request = async (method: "GET" | "POST", path: string, body: string | undefined, parent: AbortSignal): Promise<unknown> => {
    if (path !== (method === "GET" ? paths.get : paths.post)) fail("ledger_http_input");
    if (body !== undefined) {
      try { if (Buffer.byteLength(body) > responseLimit || canonical(snapshotSchema.parse(JSON.parse(body))) !== body) fail("ledger_http_input"); }
      catch { fail("ledger_http_input"); }
    }
    if (parent.aborted) fail("ledger_http_aborted");
    const controller = new AbortController(); let timedOut = false;
    const onParentAbort = () => controller.abort();
    parent.addEventListener("abort", onParentAbort, { once: true });
    let onAbort: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new LedgerHttpError(timedOut ? "ledger_http_timeout" : "ledger_http_aborted"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const execute = async (): Promise<unknown> => {
      try { await assertActive(structuredClone(identity), controller.signal); }
      catch { fail("ledger_http_guard"); }
      controller.signal.throwIfAborted();
      const credential = await resolveCredential(structuredClone(identity), controller.signal).catch(() => fail("ledger_http_credential"));
      controller.signal.throwIfAborted();
      if (credential.product_id !== identity.product_id || !sameIdentity(credential.owner, identity.owner) ||
          typeof credential.bearer !== "string" || !/^[A-Za-z0-9_-]{20,4096}$/u.test(credential.bearer)) fail("ledger_http_scope");
      // A retained read lease must still be current after secret resolution and before the one request.
      try { await assertActive(structuredClone(identity), controller.signal); }
      catch { fail("ledger_http_guard"); }
      controller.signal.throwIfAborted();
      const url = ledgerOrigin + path;
      const response = await (fetchImpl ?? globalThis.fetch)(url, { method, body, signal: controller.signal,
        redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { accept: "application/json", authorization: `Bearer ${credential.bearer}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) } });
      return consumeResponse(response, url, controller.signal);
    };
    try { return await Promise.race([execute(), interrupted]); }
    catch (error) {
      if (error instanceof LedgerHttpError) throw error;
      fail(timedOut ? "ledger_http_timeout" : controller.signal.aborted ? "ledger_http_aborted" : "ledger_http_transport");
    } finally {
      // Abort any response/fetch still owned by this request before retiring its deadline.
      controller.abort();
      clearTimeout(timer); parent.removeEventListener("abort", onParentAbort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
  return { identity: structuredClone(identity), get: (path, signal) => request("GET", path, undefined, signal),
    post: (path, body, signal) => request("POST", path, body, signal) };
}
