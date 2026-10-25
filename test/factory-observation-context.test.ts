import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { encodeGptObservationContext, readGptObservationContext, factoryRuntimeObservationExpression,
  projectFactoryRuntimeObservation } from "../src/factory-observation-context.js";
import type { FactoryRuntimeObservation } from "../src/factory-observation-context.js";

async function evaluate(status: number, user: boolean, bridge: unknown, official = true) {
  let requests = 0, jsonReads = 0;
  const value: FactoryRuntimeObservation = await runInNewContext(factoryRuntimeObservationExpression("fixture-build"), {
    location: { origin: official ? "https://chatgpt.com" : "https://example.invalid" },
    __gptConnectorBridgeV1: bridge,
    fetch: async (path: string, options: unknown) => {
      requests++; assert.equal(path, "/api/auth/session");
      assert.equal(JSON.stringify(options), '{"credentials":"include"}');
      return { status, ok: status >= 200 && status < 300, json: async () => {
        jsonReads++; assert.ok(status >= 200 && status < 300);
        return user ? { user: { privateId: "never-output-user-sentinel" } } : {};
      } };
    },
  });
  return { value, requests, jsonReads };
}
const readyBridge = () => ({ version: 1, buildId: "fixture-build", summary() {} });

test("same single evaluation retains seven scalar values and old checks with output opt-in off", async () => {
  for (const [status, user] of [[200, true], [200, false], [401, true], [403, false], [503, true]] as const) {
    const { value, requests, jsonReads } = await evaluate(status, user, readyBridge());
    assert.equal(requests, 1); assert.equal(jsonReads, status === 200 ? 1 : 0);
    const old = projectFactoryRuntimeObservation(value), detailed = projectFactoryRuntimeObservation(value, true);
    assert.equal("safe_context" in old.auth, false); assert.equal("safe_context" in old.bridge, false);
    const { safe_context: authContext, ...auth } = detailed.auth, { safe_context: bridgeContext, ...bridge } = detailed.bridge;
    assert.deepEqual(auth, old.auth); assert.deepEqual(bridge, old.bridge);
    assert.deepEqual(detailed.cdp, old.cdp); assert.deepEqual(detailed.origin, old.origin);
    assert.equal(old.auth.reason, status === 200 && user ? "authenticated" : "auth_required");
    assert.equal(old.bridge.reason, "existing_bridge_ready");
    assert.ok(authContext); assert.equal(Object.keys(authContext).length, 7);
    assert.deepEqual(readGptObservationContext(authContext), authContext); assert.strictEqual(authContext, bridgeContext);
    assert.equal(authContext.gpt_auth_session_user, status === 200 ? user ? "present" : "absent" : "uninspected");
    assert.equal(JSON.stringify(detailed).includes("sentinel"), false);
  }
});

test("bridge detail preserves original short circuit and retains uninspected later fields", async () => {
  for (const failure of ["absent", "version", "build", "summary"] as const) {
    const reads: string[] = [];
    const bridge = failure === "absent" ? undefined : Object.defineProperties({}, {
      version: { get() { reads.push("version"); return failure === "version" ? 2 : 1; } },
      buildId: { get() { reads.push("build"); assert.notEqual(failure, "version"); return failure === "build" ? "private-build-sentinel" : "fixture-build"; } },
      summary: { get() { reads.push("summary"); assert.equal(failure, "summary"); return null; } },
    });
    const { value, requests } = await evaluate(200, true, bridge);
    const result = projectFactoryRuntimeObservation(value, true), context = result.bridge.safe_context!;
    assert.equal(requests, 1); assert.equal(result.bridge.status, "unverified"); assert.equal(result.bridge.reason, "bridge_not_initialized");
    assert.deepEqual(reads, failure === "absent" ? [] : failure === "version" ? ["version"] : failure === "build" ? ["version", "build"] : ["version", "build", "summary"]);
    assert.equal(context.gpt_bridge_present, failure === "absent" ? "false" : "true");
    assert.equal(context.gpt_bridge_version, failure === "absent" ? "uninspected" : failure === "version" ? "false" : "true");
    assert.equal(context.gpt_bridge_build, ["absent", "version"].includes(failure) ? "uninspected" : failure === "build" ? "false" : "true");
    assert.equal(context.gpt_bridge_summary, failure === "summary" ? "false" : "uninspected");
    assert.equal(JSON.stringify(context).includes("sentinel"), false);
  }
});

test("HTTP class/primitive mapping emits fixed strings only and does not inspect unavailable user/bridge fields", () => {
  const cases: [unknown, string][] = [[100, "other_http"], [199, "other_http"], [200, "2xx"], [299, "2xx"],
    [300, "other_http"], [400, "other_4xx"], [401, "401"], [403, "403"], [499, "other_4xx"], [500, "5xx"], [599, "5xx"],
    [600, "unobserved"], [99, "unobserved"], [200.5, "unobserved"], [NaN, "unobserved"], [Infinity, "unobserved"], ["private-sentinel", "unobserved"]];
  for (const [input, expected] of cases) {
    const context = encodeGptObservationContext({ sessionHttpStatus: input, sessionUserPresent: true,
      bridgePresent: false, bridgeVersionMatches: true, bridgeBuildMatches: false, bridgeSummaryCallable: true });
    assert.equal(context.gpt_auth_session_http, expected);
    assert.equal(context.gpt_auth_session_user, expected === "2xx" ? "present" : "uninspected");
    assert.deepEqual([context.gpt_bridge_version, context.gpt_bridge_build, context.gpt_bridge_summary], ["uninspected", "uninspected", "uninspected"]);
    assert.ok(Object.values(context).every(item => typeof item === "string"));
  }
});

test("group omission/empty object remain compatible and missing observations are not reconstructed", () => {
  assert.equal(readGptObservationContext(undefined), undefined); assert.equal(readGptObservationContext({}), undefined);
  const old = projectFactoryRuntimeObservation({ officialOrigin: true, authenticated: false, bridgeReady: false }, true);
  assert.equal("safe_context" in old.auth, false); assert.equal("safe_context" in old.bridge, false);
  const unknown = encodeGptObservationContext();
  assert.equal(unknown.gpt_auth_session_http, "unobserved");
  for (const [key, value] of Object.entries(unknown)) if (!["gpt_obs_schema", "gpt_auth_session_http"].includes(key)) assert.equal(value, "uninspected");
  assert.deepEqual(readGptObservationContext(unknown), unknown);
});

test("partial groups, extra fields, invalid enums and nonscalar data are rejected with a fixed no-echo error", () => {
  const context = encodeGptObservationContext({ sessionHttpStatus: 200, sessionUserPresent: true, bridgePresent: true });
  for (const key of Object.keys(context)) {
    const partial: Record<string, unknown> = { ...context }; delete partial[key];
    assert.throws(() => readGptObservationContext(partial), /^Error: gpt_observation_context_invalid$/u);
    for (const invalid of ["private-value-sentinel", true, false, null, {}, [], 1]) {
      assert.throws(() => readGptObservationContext({ ...context, [key]: invalid }), /^Error: gpt_observation_context_invalid$/u);
    }
  }
  for (const invalid of [null, [], "private-input-sentinel", { ...context, unknown_key: "private-sentinel" }])
    assert.throws(() => readGptObservationContext(invalid), /^Error: gpt_observation_context_invalid$/u);
});

test("contradictory HTTP/user and bridge groups cannot pass validation", () => {
  const context = encodeGptObservationContext({ sessionHttpStatus: 200, sessionUserPresent: true, bridgePresent: true });
  for (const status of ["401", "403", "other_4xx", "5xx", "other_http", "unobserved"])
    for (const user of ["present", "absent"])
      assert.throws(() => readGptObservationContext({ ...context, gpt_auth_session_http: status, gpt_auth_session_user: user }), /gpt_observation_context_invalid/u);
  for (const present of ["false", "uninspected"])
    for (const key of ["gpt_bridge_version", "gpt_bridge_build", "gpt_bridge_summary"])
      for (const value of ["true", "false"])
        assert.throws(() => readGptObservationContext({ ...context, gpt_bridge_present: present, [key]: value }), /gpt_observation_context_invalid/u);
});

test("scalar outputs are owned frozen snapshots and getters cannot inject late private values", () => {
  const input = { sessionHttpStatus: 200, sessionUserPresent: true, bridgePresent: true };
  const context = encodeGptObservationContext(input); input.sessionUserPresent = false;
  assert.equal(context.gpt_auth_session_user, "present"); assert.equal(Object.isFrozen(context), true);
  const source = { ...context }, read = readGptObservationContext(source)!;
  source.gpt_auth_session_user = "absent"; assert.equal(read.gpt_auth_session_user, "present"); assert.equal(Object.isFrozen(read), true);
  let reads = 0;
  const accessor = Object.defineProperty({ ...context }, "gpt_auth_session_user", { get() { reads++; throw new Error("secret-getter-sentinel"); } });
  assert.throws(() => readGptObservationContext(accessor), /^Error: gpt_observation_context_invalid$/u); assert.equal(reads, 0);
});
