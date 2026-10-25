import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().min(1).max(160).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
export const utcMillis = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const version = z.string().max(200).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
export const ownerSchema = z.object({ system: z.literal("bellteam"), id: z.literal("bot-7696018a") }).strict();
export const hosts = ["mac-kite", "main-server", "rabbit", "windows-workstation"] as const;
export const hostSchema = z.enum(hosts);
export const productSchema = z.enum(hosts.map(host => `gpt-connector-${host}`) as [string, ...string[]]);
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), series: z.string().regex(/^\d+(?:\.\d+){0,2}$/u) }).strict(),
  z.object({ kind: z.literal("npm"), name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u), series: z.string().regex(/^\d+(?:\.\d+){0,2}$/u) }).strict(),
]);
export const bindingSchema = z.object({ component: id, target: targetSchema, installed: version.nullable(), status: z.literal("active") }).strict();
export const identitySchema = z.object({ product_id: productSchema, host_id: hostSchema, owner: ownerSchema, execution_prefix: text }).strict()
  .refine(value => value.product_id === `gpt-connector-${value.host_id}`, "product_host_mismatch");
export const runSchema = z.object({ run_id: z.uuid(), started_at: utcMillis, completed_at: utcMillis, mode: z.enum(["setup", "check"]) }).strict()
  .refine(run => run.started_at <= run.completed_at, "invalid_run_window");
export type SetupRun = z.infer<typeof runSchema>;
export interface SetupRunResult {
  schema: string;
  version: string;
  overall: string;
  registrations: Record<string, unknown>[];
}
export interface SetupCompletion { run: SetupRun; result: SetupRunResult; }
export interface SetupCompletionHook {
  begin(mode: "setup" | "check"): { run_id: string; started_at: string };
  complete(start: { run_id: string; started_at: string }, mode: "setup" | "check", result: SetupRunResult): Promise<unknown>;
}
export const planSchema = z.object({
  identity: identitySchema,
  source_wire_agreement_ref: text,
  health_agreement_ref: text,
  required_clients: z.array(z.enum(["claude", "codex", "grok", "cursor"])).min(1).max(4).refine(clients => new Set(clients).size === clients.length),
  targets: z.array(z.object({ component: id, target: targetSchema, adoption_ref: text }).strict()).min(1).max(4096),
}).strict();
export type LedgerPlan = z.infer<typeof planSchema>;
export const measurementSchema = z.object({
  identity: identitySchema,
  run_id: z.uuid(), observed_at: utcMillis,
  source: z.object({ kind: z.literal("installed-package"), name: z.literal("gpt-connector"), installed: version,
    deployment_revision: text, manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u), deployment_evidence_ref: text }).strict(),
  bindings: z.array(bindingSchema).min(1).max(4096),
  health: z.object({ run_id: z.uuid(), observed_at: utcMillis, raw: z.boolean().nullable(),
    acceptance: z.object({ run_id: z.uuid(), observed_at: utcMillis, source_revision: text,
      execution_prefix: text, normal_path: z.literal(true), passed: z.boolean(), evidence_ref: text }).strict().nullable() }).strict(),
}).strict();
export type RuntimeMeasurement = z.infer<typeof measurementSchema>;
export const collectedEvidenceSchema = z.object({ run: runSchema, measurement: measurementSchema,
  source_wire_agreement_ref: text, health_agreement_ref: text, target_adoptions: planSchema.shape.targets,
  result_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const snapshotSchema = z.object({ request_id: z.uuid(), expected_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observed_at: utcMillis, deployment_revision: text, healthy: z.boolean(), bindings: z.array(bindingSchema).min(1).max(4096) }).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
const storedBinding = bindingSchema.extend({ status: z.enum(["active", "removed"]), reported: z.boolean(), observed_at: utcMillis }).strict();
export const currentProductSchema = z.object({ product_id: productSchema, app: z.literal("GPT"), owner: ownerSchema,
  version: z.number().int().positive(), inventory_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  inventory_max_age_hours: z.number().int().positive().max(8760), bindings: z.array(storedBinding),
  observed_at: utcMillis.optional(), deployment_revision: text.optional(), healthy: z.boolean().optional(),
  created_at: utcMillis, updated_at: utcMillis }).strict();
export type CurrentProduct = z.infer<typeof currentProductSchema>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value);
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const bindingKey = (value: { component: string; target: unknown }) => `${value.component}:${canonical(value.target)}`;
export function sameIdentity(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
export function productAfterSnapshot(before: CurrentProduct, body: Snapshot, updatedAt: string): CurrentProduct {
  const keys = new Set(body.bindings.map(bindingKey));
  return { ...before, inventory_version: before.inventory_version + 1, observed_at: body.observed_at,
    deployment_revision: body.deployment_revision, healthy: body.healthy, updated_at: updatedAt,
    bindings: [...body.bindings.map(binding => ({ ...binding, reported: true, observed_at: body.observed_at })),
      ...before.bindings.filter(binding => !keys.has(bindingKey(binding))).map(binding => ({ ...binding, reported: false }))] };
}

/** The collector never derives deployment provenance, adopted series or health from a version range. */
export function collectSnapshot(planInput: unknown, completion: SetupCompletion, measurementInput: unknown) {
  const plan = planSchema.parse(planInput), run = runSchema.parse(completion.run), measured = measurementSchema.parse(measurementInput);
  if (!sameIdentity(plan.identity, measured.identity)) throw new Error("ledger_identity_mismatch");
  const within = (at: string) => at >= run.started_at && at <= run.completed_at;
  const health = measured.health, acceptance = health.acceptance;
  if (measured.run_id !== run.run_id || health.run_id !== run.run_id || !within(measured.observed_at) || !within(health.observed_at) || health.observed_at > measured.observed_at) throw new Error("ledger_run_mismatch");
  if (completion.result.schema !== "gpt-connector.setup.v1" || completion.result.version !== measured.source.installed ||
      !["ready", "failed", "partial", "action_required"].includes(completion.result.overall)) throw new Error("ledger_source_mismatch");
  if (!acceptance || health.raw === null) throw new Error("ledger_health_unknown");
  if (acceptance.run_id !== run.run_id || !within(acceptance.observed_at) || acceptance.observed_at > measured.observed_at || acceptance.source_revision !== measured.source.deployment_revision ||
      acceptance.execution_prefix !== measured.identity.execution_prefix) throw new Error("ledger_acceptance_mismatch");
  const actual = measured.bindings.map(bindingKey), intended = plan.targets.map(bindingKey);
  if (new Set(actual).size !== actual.length || new Set(intended).size !== intended.length || canonical([...actual].sort()) !== canonical([...intended].sort())) throw new Error("ledger_targets_mismatch");
  if (measured.bindings.some(binding => binding.installed === null)) throw new Error("ledger_installed_unknown");
  const connector = measured.bindings.find(binding => binding.component === "connector" && binding.target.kind === "npm" && binding.target.name === "gpt-connector");
  if (!connector || connector.installed !== measured.source.installed) throw new Error("ledger_source_binding_missing");
  const clients = completion.result.registrations;
  const ready = completion.result.overall === "ready" && plan.required_clients.every(client => {
    const entries = clients.filter(row => row.client === client);
    if (entries.length !== 1) return false;
    const row = entries[0]!, mcp = row.mcp as { status?: string } | undefined, live = row.live as { status?: string } | undefined;
    return !row.failure && row.stateRead === "ready" && mcp?.status === "ready" && live?.status === "ready" && row.clientActivation !== "disabled_by_user";
  });
  if (health.raw !== acceptance.passed || (acceptance.passed && !ready) || (!acceptance.passed && ready)) throw new Error("ledger_health_contradiction");
  return { observation: { observed_at: measured.observed_at, deployment_revision: measured.source.deployment_revision,
    healthy: acceptance.passed, bindings: measured.bindings }, evidence: { run, measurement: measured, source_wire_agreement_ref: plan.source_wire_agreement_ref,
    health_agreement_ref: plan.health_agreement_ref, target_adoptions: plan.targets, result_sha256: sha256(canonical(completion.result)) } };
}
export type CollectedSnapshot = ReturnType<typeof collectSnapshot>;
