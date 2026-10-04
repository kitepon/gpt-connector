import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createRuntimeDiscoveryExpression } from "../src/runtime-discovery.js";

async function discover(modules: Record<string, object>, entryImports = Object.keys(modules)) {
  const imported: string[] = [];
  const expression = createRuntimeDiscoveryExpression().replace("await import(url.href)", "await importModule(url.href)");
  const result = await vm.runInNewContext(expression, {
    location: { origin: "https://chatgpt.com" }, URL,
    __reactRouterManifest: { entry: { imports: entryImports } },
    importModule: async (url: string) => { imported.push(url); return modules[new URL(url).pathname] ?? {}; },
  });
  return { result, imported };
}
const core = "/cdn/assets/core.js";
const shared = "/cdn/assets/shared.js";
const runtime = Object.assign(() => {}, { m: {}, c: {} });

function authProbe(authenticated: boolean) {
  const AuthStatus = { LoggedIn: "logged_in" };
  const bootstrap = () => ({ authStatus: authenticated ? "logged_in" : "logged_out" });
  function nativeAuth() { return bootstrap().authStatus === AuthStatus.LoggedIn; }
  return nativeAuth;
}

test("Signed-in Rspack remains supported", async () => {
  const { result } = await discover({ [core]: { __webpack_require__: runtime }, [shared]: { probe: authProbe(true) } });
  assert.equal(result, "https://chatgpt.com" + core);
});

test("Logged-out native page is classified as authentication required before runtime detection", async () => {
  await assert.rejects(discover({ [core]: {}, [shared]: { probe: authProbe(false) } }), /AUTH_REQUIRED:native_runtime_logged_out/u);
  await assert.rejects(discover({ [core]: { __webpack_require__: runtime }, [shared]: { probe: authProbe(false) } }), /AUTH_REQUIRED:native_runtime_logged_out/u);
});

test("Missing and ambiguous runtimes remain drift failures", async () => {
  await assert.rejects(discover({ [core]: {}, [shared]: {} }), /RUNTIME_DRIFT:rspack_runtime:0/u);
  await assert.rejects(discover({ [core]: { __webpack_require__: runtime }, [shared]: { __webpack_require__: runtime } }), /RUNTIME_DRIFT:rspack_runtime:2/u);
});

test("Duplicate references to the same native probe are allowed, conflicting probes fail", async () => {
  const probe = authProbe(true);
  assert.equal((await discover({ [core]: { __webpack_require__: runtime, probe }, [shared]: { probe } })).result, "https://chatgpt.com" + core);
  await assert.rejects(discover({ [core]: { __webpack_require__: runtime, probe }, [shared]: { probe: authProbe(false) } }), /RUNTIME_DRIFT:native_auth:2/u);
});

test("External assets do not become runtime candidates", async () => {
  const { imported } = await discover({ [core]: { __webpack_require__: runtime } }, [core, "https://example.com/cdn/assets/other.js", "/settings/private.js"]);
  assert.equal(imported.length, 1);
});
