import { z } from "zod";
import { ConnectorError } from "./errors.js";

export const runtimeFailureSchema = z.object({
  stage: z.enum(["authentication", "existing_bridge", "runtime_discovery", "bridge_bootstrap", "evaluation", "browser_preparation", "unknown"]),
  tag: z.enum(["entry_imports", "native_auth", "rspack_runtime", "sender", "uploader", "appScope", "scopeWrapper", "atomModule", "atom", "createStore", "scheduler", "queryClient", "apiClient", "upload_metadata", "sender_result", "official_origin", "bridge_summary", "unknown"]),
}).strict();
export type RuntimeFailure = z.output<typeof runtimeFailureSchema>;
export type RuntimeFailureStage = RuntimeFailure["stage"];

const discoveryTags = new Set(["entry_imports", "native_auth", "rspack_runtime"]);
const bootstrapTags = new Set(["rspack_runtime", "sender", "uploader", "appScope", "scopeWrapper", "atomModule", "atom", "createStore", "scheduler", "queryClient", "apiClient"]);
const evaluationTags = new Set(["upload_metadata", "sender_result"]);

/** Only our complete first-line tags, at the relevant call site; never a raw exception or count. */
export function runtimeFailureFromException(description: unknown, stage: RuntimeFailureStage): RuntimeFailure {
  const match = typeof description === "string"
    ? /^Error: RUNTIME_DRIFT:([A-Za-z_]+)(?::[0-9]{1,6})?(?:\n|$)/u.exec(description) : null;
  const tag = match?.[1];
  const allowed = stage === "runtime_discovery" ? discoveryTags : stage === "bridge_bootstrap" ? bootstrapTags : stage === "evaluation" ? evaluationTags : new Set<string>();
  const parsed = runtimeFailureSchema.safeParse({ stage, tag: tag && allowed.has(tag) ? tag : "unknown" });
  return parsed.success ? parsed.data : { stage: "unknown", tag: "unknown" };
}

export function runtimeFailureFromError(error: unknown, fallbackStage: RuntimeFailureStage = "unknown"): RuntimeFailure {
  const details = error instanceof ConnectorError && error.code === "RUNTIME_DRIFT" ? error.details : undefined;
  const parsed = runtimeFailureSchema.safeParse({ stage: details?.runtimeStage, tag: details?.runtimeTag });
  return parsed.success ? parsed.data : { stage: fallbackStage, tag: "unknown" };
}

export function runtimeFailureDetails(failure: RuntimeFailure) {
  return { runtimeStage: failure.stage, runtimeTag: failure.tag };
}
