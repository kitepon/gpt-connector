import { posix, win32 } from "node:path";
import { z } from "zod";
import { connectorErrorCodes } from "./errors.js";
import { setupClients, setupTools } from "./setup-registration.js";
import { setupNext, loginNext, externalBrowserNext } from "./setup-public-text.js";
import { readPublicJsonFrame } from "./public-json.js";
import type { PublicJsonFrame } from "./public-json.js";
import { sha256 } from "./update-ledger-contract.js";
import type { CoreFrameAdmission } from "./update-ledger-core-observer-ports.js";

const privatePath = z.string().refine(value => Buffer.byteLength(value, "utf8") <= 4096
  && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  && (posix.isAbsolute(value) || win32.isAbsolute(value)));
const stages = ["registration", "state", "mcp", "codex_steer", "cursor_hooks", "browser"] as const;
const publicReasons = z.enum(["codex_restart_required", "codex_steer_migration_required", "codex_steer_platform_unsupported",
  "codex_steer_configuration_changed", "codex_steer_setup_failed", "codex_steer_config_invalid", "codex_steer_path_invalid",
  "codex_relay_probe_failed", "codex_version_unsupported", "codex_desktop_not_identified"]);
const toolNames = z.array(z.enum(setupTools)).max(setupTools.length).refine(values => new Set(values).size === values.length);
const registration = z.object({
  client: z.enum(setupClients), path: privatePath, backup: privatePath.nullable().optional(),
  status: z.enum(["registered", "unchanged", "existing"]).optional(), stateRead: z.literal("ready").optional(),
  clientActivation: z.enum(["disabled_by_user", "new_client_session_required"]).optional(),
  mcp: z.union([z.literal("not_checked"), z.object({ status: z.literal("ready"), tools: toolNames, diagnostics: z.literal("responded") }).strict()]).optional(),
  enabledTools: toolNames.optional(),
  codexSteer: z.object({ status: z.enum(["ready", "disabled", "restart_required", "unsupported", "failed"]),
    reason_code: publicReasons.optional(), connection: z.literal("existing").optional() }).strict().optional(),
  cursorHooks: z.object({ status: z.enum(["ready", "unchanged", "disabled"]), path: privatePath, changed: z.boolean() }).strict().optional(),
  live: z.object({ status: z.enum(["ready", "not_ready", "failed", "action_required", "external", "unsupported"]),
    reason: z.enum(["ready", "auth_required", "cdp_unavailable", "runtime_drift", "state_unavailable", "connector_error", "cdp_endpoint_not_owned", "live_browser_host_unsupported"]),
    next: z.enum([loginNext, externalBrowserNext]).optional() }).strict().optional(),
  failure: z.object({ stage: z.enum(stages), code: z.enum([...connectorErrorCodes, ...stages.map(stage => `SETUP_${stage.toUpperCase()}_FAILED`)]),
    reason_code: publicReasons.optional() }).strict().optional(),
}).strict();
const frameSchema = z.object({ schema: z.literal("gpt-connector.setup.v1"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u).max(200),
  overall: z.enum(["ready", "partial", "action_required", "failed"]), package: z.literal("ready"),
  registrations: z.array(registration).min(1).max(4).refine(items => new Set(items.map(item => item.client)).size === items.length),
  live: z.object({ supported: z.boolean() }).strict(), next: z.literal(setupNext),
}).strict();

/** Parses nothing and serializes nothing: consumes a frame issued by the one serializer/parse owner. */
export function admitCoreFrame(frame: PublicJsonFrame): CoreFrameAdmission {
  const { text, parsed } = readPublicJsonFrame(frame);
  const bytes = Buffer.byteLength(text, "utf8");
  const reason = bytes > 65536 ? "frame_too_large" : parsed === undefined ? "invalid_frame"
    : frameSchema.safeParse(parsed).success ? "accepted" : "unsupported_fields";
  return Object.freeze({ schema: "gpt-connector.core-frame-admission.v1", policy: "setup_v1_private_metadata_v1",
    decision: reason === "accepted" ? "full_frame" : "metadata_only", frame_sha256: sha256(text), frame_bytes: bytes, reason });
}
