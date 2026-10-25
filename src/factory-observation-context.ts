// Pure primitive capture/scalar projection. No browser, transport, store or reporter operations.
export interface FactoryObservationPrimitives {
  readonly sessionHttpStatus?: unknown;
  readonly sessionUserPresent?: unknown;
  readonly bridgePresent?: unknown;
  readonly bridgeVersionMatches?: unknown;
  readonly bridgeBuildMatches?: unknown;
  readonly bridgeSummaryCallable?: unknown;
}
const httpValues = ["2xx", "401", "403", "other_4xx", "5xx", "other_http", "unobserved"] as const;
const userValues = ["present", "absent", "uninspected"] as const;
const booleanValues = ["true", "false", "uninspected"] as const;
export interface GptObservationContext {
  readonly gpt_obs_schema: "v1";
  readonly gpt_auth_session_http: typeof httpValues[number];
  readonly gpt_auth_session_user: typeof userValues[number];
  readonly gpt_bridge_present: typeof booleanValues[number];
  readonly gpt_bridge_version: typeof booleanValues[number];
  readonly gpt_bridge_build: typeof booleanValues[number];
  readonly gpt_bridge_summary: typeof booleanValues[number];
}
const keys = ["gpt_obs_schema", "gpt_auth_session_http", "gpt_auth_session_user", "gpt_bridge_present",
  "gpt_bridge_version", "gpt_bridge_build", "gpt_bridge_summary"] as const;
const boolean = (value: unknown): typeof booleanValues[number] =>
  typeof value === "boolean" ? value ? "true" : "false" : "uninspected";
function http(value: unknown): typeof httpValues[number] {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return "unobserved";
  return value >= 200 && value < 300 ? "2xx" : value === 401 ? "401" : value === 403 ? "403"
    : value >= 400 && value < 500 ? "other_4xx" : value >= 500 ? "5xx" : "other_http";
}
export function encodeGptObservationContext(input: FactoryObservationPrimitives = {}): GptObservationContext {
  // Only primitive data properties from the original by-value result; never invoke getters.
  const values = Object.getOwnPropertyDescriptors(input);
  const read = (key: keyof FactoryObservationPrimitives): unknown => values[key]?.value;
  const status = http(read("sessionHttpStatus")), present = boolean(read("bridgePresent"));
  const user = read("sessionUserPresent");
  return Object.freeze({ gpt_obs_schema: "v1", gpt_auth_session_http: status,
    gpt_auth_session_user: status !== "2xx" || typeof user !== "boolean" ? "uninspected" : user ? "present" : "absent",
    gpt_bridge_present: present,
    gpt_bridge_version: present === "true" ? boolean(read("bridgeVersionMatches")) : "uninspected",
    gpt_bridge_build: present === "true" ? boolean(read("bridgeBuildMatches")) : "uninspected",
    gpt_bridge_summary: present === "true" ? boolean(read("bridgeSummaryCallable")) : "uninspected" });
}
/** Whole optional group only. Failures never echo private input values or thrown getter text. */
export function readGptObservationContext(value: unknown): GptObservationContext | undefined {
  try {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const entries = Reflect.ownKeys(value);
    if (!entries.length) return undefined;
    if (entries.length !== keys.length || entries.some(key => typeof key !== "string" || !keys.includes(key as typeof keys[number]))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => !("value" in descriptors[key]!))) throw new Error();
    const v = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
    if (v.gpt_obs_schema !== "v1" || !httpValues.includes(v.gpt_auth_session_http as typeof httpValues[number])
      || !userValues.includes(v.gpt_auth_session_user as typeof userValues[number])
      || [v.gpt_bridge_present, v.gpt_bridge_version, v.gpt_bridge_build, v.gpt_bridge_summary]
        .some(item => !booleanValues.includes(item as typeof booleanValues[number]))) throw new Error();
    if ((v.gpt_auth_session_http !== "2xx" && v.gpt_auth_session_user !== "uninspected")
      || (v.gpt_bridge_present !== "true" && [v.gpt_bridge_version, v.gpt_bridge_build, v.gpt_bridge_summary]
        .some(item => item !== "uninspected"))) throw new Error();
    return Object.freeze(Object.fromEntries(keys.map(key => [key, v[key]]))) as unknown as GptObservationContext;
  } catch { throw new Error("gpt_observation_context_invalid"); }
}

export interface FactoryRuntimeObservation {
  readonly officialOrigin: boolean;
  readonly authenticated: boolean;
  readonly bridgeReady: boolean;
  readonly observation?: FactoryObservationPrimitives;
}
/** The original single evaluation/session fetch, with only already-read primitive results retained. */
export function factoryRuntimeObservationExpression(expectedBuild: string): string {
  return String.raw`(async () => {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    let authenticated = false, sessionUserPresent = null;
    if (response.ok) {
      const data = await response.json();
      authenticated = Boolean(data?.user);
      sessionUserPresent = authenticated;
    }
    const bridge = globalThis.__gptConnectorBridgeV1;
    let bridgeVersionMatches = null, bridgeBuildMatches = null, bridgeSummaryCallable = null;
    const bridgeReady = (bridgeVersionMatches = bridge?.version === 1) &&
      (bridgeBuildMatches = bridge?.buildId === ${JSON.stringify(expectedBuild)}) &&
      (bridgeSummaryCallable = typeof bridge.summary === "function");
    return {
      officialOrigin: location.origin === "https://chatgpt.com", authenticated, bridgeReady,
      observation: { sessionHttpStatus: response.status, sessionUserPresent,
        bridgePresent: bridge !== null && bridge !== undefined,
        bridgeVersionMatches, bridgeBuildMatches, bridgeSummaryCallable }
    };
  })()`;
}
/** Preserve the old checks. Optional groups belong only to this one observation. */
export function projectFactoryRuntimeObservation(result: FactoryRuntimeObservation, includeContext = false) {
  const context = includeContext && result.observation !== undefined
    ? { safe_context: encodeGptObservationContext(result.observation) } : {};
  return {
    cdp: { id: "cdp", status: "ready" as const, reason: "connected" },
    origin: { id: "official_origin", status: result.officialOrigin ? "ready" as const : "not_ready" as const,
      reason: result.officialOrigin ? "official" : "not_official" },
    auth: { id: "auth", status: result.authenticated ? "ready" as const : "not_ready" as const,
      reason: result.authenticated ? "authenticated" : "auth_required", ...context },
    bridge: { id: "runtime_bridge", status: result.bridgeReady ? "ready" as const : "unverified" as const,
      reason: result.bridgeReady ? "existing_bridge_ready" : "bridge_not_initialized", ...context },
  };
}
