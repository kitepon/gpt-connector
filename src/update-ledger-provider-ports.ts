import { posix, win32 } from "node:path";
import { z } from "zod";
import { identitySchema, planSchema, utcMillis, type LedgerPlan, type RuntimeMeasurement, type SetupRunResult } from "./update-ledger-contract.js";
import type { readInstalledMeasurement } from "./update-ledger-collector.js";
import type { SetupOptions } from "./setup.js";
import type { SenderPorts } from "./update-ledger-sender.js";

const text = z.string().min(1).max(1024);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const resourcePath = text.refine(path => path.startsWith("/") ? posix.normalize(path) === path : win32.isAbsolute(path) && win32.normalize(path) === path);
export const resourcesSchema = z.array(resourcePath).min(1).refine(paths => new Set(paths).size === paths.length && paths.every((path, i) => path === [...paths].sort()[i]));
export const providerScopeSchema = z.object({ execution_package_root: resourcePath, mutation_resources: resourcesSchema.nullable(),
  expectedGeneration: z.uuid().nullable(), coverage_ref: text.nullable(), deadline: z.number().int().positive() }).strict();
export type ProviderScope = z.infer<typeof providerScopeSchema>;
const nodeRuntimeSchema = z.object({ executable: resourcePath, installed: text, sha256: digest, owner_evidence_ref: text }).strict();
export const installedStateSchema = z.object({ identity: identitySchema, execution_package_root: resourcePath, mutation_resources: resourcesSchema,
  generation: z.uuid(), manifest_sha256: digest, tree_sha256: digest, artifact_source_sha256: digest, target_adoption_sha256: digest, target_projection_sha256: digest,
  node_runtime: nodeRuntimeSchema.nullable() }).strict();
export const deploymentPayloadSchema = installedStateSchema.extend({ schema: z.literal("gpt-connector.deployment-receipt.v1"),
  state: z.enum(["mutating", "committed", "incomplete"]), deployment_revision: text, issuer: text, evidence_ref: text, coverage_ref: text }).strict();
export type DeploymentPayload = z.infer<typeof deploymentPayloadSchema>;
export const acceptancePayloadSchema = z.object({ schema: z.literal("gpt-connector.normal-acceptance.v1"), identity: identitySchema,
  generation: z.uuid(), deployment_revision: text, run_id: z.uuid(), mode: z.enum(["setup", "check"]), observed_at: utcMillis,
  result_sha256: digest, required_clients: planSchema.shape.required_clients, raw_health: z.boolean().nullable(),
  normal_path: z.literal(true), passed: z.boolean().nullable(), issuer: text, evidence_ref: text }).strict();
export type AcceptancePayload = z.infer<typeof acceptancePayloadSchema>;
export interface OriginalPacket { payload: unknown; provenance: unknown; }
export interface Verification {
  status: "verified" | "unknown" | "rejected";
  subject_sha256: string;
  issuer: string;
  trust_ref: string | null;
}
export interface ReadLease {
  mode: "SH";
  resources: readonly string[];
  generation: string;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface ProviderContext {
  identity: LedgerPlan["identity"];
  execution_package_root: string;
  mutation_resources: readonly string[];
  expectedGeneration: string;
  coverage_ref: string;
  target_adoptions: LedgerPlan["targets"];
  deadline: number;
}
export interface RunContext extends ProviderContext {
  run_id: string;
  started_at: string;
  mode: "setup" | "check";
  result_sha256: string;
}
export interface ProviderPorts {
  /** The writer releases EX before this call; lease stays held until fn settles, even if abort/deadline fires. */
  withReadLease<T>(resources: readonly string[], expectedGeneration: string, deadline: number, fn: (lease: ReadLease) => Promise<T>): Promise<T>;
  readDeploymentReceipt(context: ProviderContext, signal: AbortSignal): Promise<OriginalPacket>;
  /** Verify original artifact/source and adoption hashes against existing trusted originals, including their plan projection. */
  verifyDeployment(packet: OriginalPacket, context: ProviderContext, signal: AbortSignal): Promise<Verification>;
  inspectInstalled(context: ProviderContext, signal: AbortSignal): Promise<unknown>;
  /** Read-only existing same-run evidence. Never starts native acceptance, creates a receipt, or signs during check. */
  readAcceptance(context: RunContext, result: SetupRunResult, signal: AbortSignal): Promise<OriginalPacket | null>;
  verifyAcceptance(packet: OriginalPacket, context: RunContext, signal: AbortSignal): Promise<Verification>;
  /** Already-installed core setup() only. CLI installSetupPackage/npm/re-exec must finish in writer scope before SH. */
  publicSetup(options: SetupOptions, signal: AbortSignal): Promise<SetupRunResult & { updateLedger?: unknown }>;
  sampleInstalled?: typeof readInstalledMeasurement;
  senderForLease?(context: ProviderContext, lease: ReadLease): SenderPorts;
  clock?: () => string;
  now?: () => number;
  uuid?: () => string;
}
export interface ProviderProof {
  scope: ProviderContext;
  deployment_sha256: string;
  deployment_trust_ref: string;
  acceptance_sha256: string | null;
  acceptance_trust_ref: string | null;
  result_sha256: string;
  raw_health: RuntimeMeasurement["health"];
}
