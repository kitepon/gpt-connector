import { z } from "zod";
import { canonical, identitySchema, planSchema, sha256 } from "./update-ledger-contract.js";
import { deploymentPayloadSchema, resourcePath, resourcesSchema, type OriginalPacket, type ProviderContext,
  type ProviderPorts, type ReadLease, type Verification } from "./update-ledger-provider-ports.js";
import { runSetupWithBorrowedLedgerLease, type ProviderResult } from "./update-ledger-provider.js";
import type { SetupOptions } from "./setup.js";

// Match the fixed factory writer's JSON bytes, not the ledger's locale-sorted projection.
export function factoryCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(factoryCanonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${factoryCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("factory_noncanonical_value");
}
const text = z.string().min(1).max(1024), digest = z.string().regex(/^[a-f0-9]{64}$/u);
const factoryIdentity = z.object({ product_id: identitySchema.shape.product_id, host_id: identitySchema.shape.host_id, owner: identitySchema.shape.owner }).strict()
  .refine(value => value.product_id === `gpt-connector-${value.host_id}`);
const factoryPayload = z.object({ schema: z.literal("factory.deployment-receipt.v1"), identity: factoryIdentity,
  execution_package_root: resourcePath, mutation_resources: resourcesSchema, deployment_generation: z.uuid(),
  manifest_sha256: digest, artifact_or_tree_sha256: digest, deployment_revision: text, provenance_evidence_ref: text,
  adopted_targets_sha256: digest, issued_at: z.iso.datetime({ precision: 3 }) }).strict();
export const factoryReceipt = z.object({ payload: factoryPayload, issuer_id: text, evidence_ref: text, proof: z.unknown() }).strict();
const factoryState = z.object({ schema: z.literal("factory.deployment-state.v1"), identity: factoryIdentity,
  execution_package_root: resourcePath, mutation_resources: resourcesSchema, generation: z.uuid(),
  phase: z.literal("committed"), receipt: factoryReceipt }).strict();
// These are reader views of existing originals, not a demand for new signatures/keys or a new writer receipt.
const provenanceView = z.object({ factory_payload_sha256: digest, provenance_evidence_ref: text,
  artifact_or_tree_kind: z.enum(["tree", "artifact"]), tree_sha256: digest, artifact_sha256: digest.nullable(), artifact_source_sha256: digest,
  node_runtime: deploymentPayloadSchema.shape.node_runtime }).strict();
const coverageView = z.object({ mutation_resources: resourcesSchema, coverage_ref: text, all_writers: z.literal(true) }).strict();
const adoptionView = z.object({ targets: planSchema.shape.targets }).strict();
export interface SourceView {
  original: OriginalPacket;
  view: unknown;
  issuer: string;
  /** Exact retained bundle/original lineage consumed by verifySource; never an authority by itself. */
  lineage?: unknown;
}
export interface ViewVerification extends Verification { view_sha256: string; }
export interface FactorySources { provenance: SourceView | null; adoption: SourceView | null; coverage: SourceView | null; }
export interface FactoryBridgePorts {
  /** The same committed store that the writer read under this borrowed SH. */
  readState(context: ProviderContext, signal: AbortSignal): Promise<unknown>;
  verifyReceipt(original: unknown, context: ProviderContext, signal: AbortSignal): Promise<Verification>;
  readSources(original: unknown, context: ProviderContext, signal: AbortSignal): Promise<FactorySources>;
  /** Validate existing originals and their projection; subject=factoryCanonical(original.payload), view=ledger canonical(view). */
  verifySource(kind: keyof FactorySources, source: SourceView, context: ProviderContext, signal: AbortSignal): Promise<ViewVerification>;
  provider: Omit<ProviderPorts, "withReadLease" | "readDeploymentReceipt" | "verifyDeployment">;
}
export interface FactoryViewProof {
  factory_payload_sha256: string;
  factory_receipt_sha256: string;
  factory_trust_ref: string;
  view_sha256: string;
  source_subjects: Record<keyof FactorySources, { original_sha256: string; view_sha256: string; trust_ref: string }>;
}
class BridgeBlocked extends Error { constructor(readonly code: string) { super(code); } }
function block(code: string): never { throw new BridgeBlocked(code); }
function verifySubject(result: Verification, subject: string, issuer: string): string {
  if (result.status !== "verified" || result.subject_sha256 !== subject || result.issuer !== issuer || !result.trust_ref) block("factory_original_unverified");
  return result.trust_ref;
}

/** Source-only composition at writer readDeployment's callback. Missing OS lease metadata or originals stay unknown. */
export async function runSetupWithFactoryReceipt(plan: unknown, scope: unknown, lease: ReadLease, original: unknown,
  ports: FactoryBridgePorts, options: Omit<SetupOptions, "updateLedger"> = {}): Promise<ProviderResult & {
    bridge: { status: "blocked" | "verified-view"; reason: string | null; proof: FactoryViewProof | null };
  }> {
  const fixedOriginal = structuredClone(original);
  let proof: FactoryViewProof | null = null, reason: string | null = null;
  let lastPacket: OriginalPacket | null = null, lastTrust: string | null = null;
  const project = async (context: ProviderContext, signal: AbortSignal): Promise<OriginalPacket> => {
    try {
      const raw = structuredClone(fixedOriginal), receiptHash = sha256(factoryCanonical(raw));
      const receipt = factoryReceipt.parse(raw), payload = receipt.payload;
      const subject = sha256(factoryCanonical(payload));
      const state = factoryState.parse(await ports.readState(context, signal));
      if (state.generation !== context.expectedGeneration || state.generation !== payload.deployment_generation ||
          state.execution_package_root !== payload.execution_package_root ||
          factoryCanonical(state.identity) !== factoryCanonical(payload.identity) ||
          factoryCanonical(state.mutation_resources) !== factoryCanonical(payload.mutation_resources) ||
          factoryCanonical(state.receipt) !== factoryCanonical(raw)) block("factory_state_mismatch");
      const trust = verifySubject(await ports.verifyReceipt(structuredClone(raw), context, signal), subject, receipt.issuer_id);
      const sources = await ports.readSources(structuredClone(raw), context, signal);
      const subjects = {} as FactoryViewProof["source_subjects"];
      for (const kind of ["provenance", "adoption", "coverage"] as const) {
        const source = sources[kind];
        if (!source) block("factory_source_unknown");
        const hash = sha256(factoryCanonical(source.original.payload)), viewHash = sha256(canonical(source.view));
        const verification = await ports.verifySource(kind, structuredClone(source), context, signal);
        const trustRef = verifySubject(verification, hash, source.issuer);
        if (verification.view_sha256 !== viewHash) block("factory_source_projection_unverified");
        subjects[kind] = { original_sha256: hash, view_sha256: viewHash, trust_ref: trustRef };
      }
      const provenance = provenanceView.parse(sources.provenance!.view), coverage = coverageView.parse(sources.coverage!.view), adoption = adoptionView.parse(sources.adoption!.view);
      if (provenance.factory_payload_sha256 !== subject || provenance.provenance_evidence_ref !== payload.provenance_evidence_ref ||
          provenance.artifact_source_sha256 !== subjects.provenance.original_sha256 ||
          payload.artifact_or_tree_sha256 !== (provenance.artifact_or_tree_kind === "tree" ? provenance.tree_sha256 : provenance.artifact_sha256)) block("factory_provenance_mismatch");
      // Writer hashes the whole adoption original (including evidence_ref), never just targets or plan.
      if (subjects.adoption.original_sha256 !== payload.adopted_targets_sha256 ||
          canonical((sources.adoption!.original.payload as { targets?: unknown }).targets) !== canonical(adoption.targets)) block("factory_adoption_mismatch");
      if (canonical(coverage.mutation_resources) !== canonical(payload.mutation_resources) || coverage.coverage_ref !== context.coverage_ref) block("factory_coverage_mismatch");
      const view = deploymentPayloadSchema.parse({ schema: "gpt-connector.deployment-receipt.v1", state: state.phase,
        identity: { ...payload.identity, execution_prefix: payload.execution_package_root }, execution_package_root: payload.execution_package_root,
        mutation_resources: payload.mutation_resources, generation: payload.deployment_generation, manifest_sha256: payload.manifest_sha256,
        tree_sha256: provenance.tree_sha256, artifact_source_sha256: provenance.artifact_source_sha256,
        target_adoption_sha256: payload.adopted_targets_sha256, target_projection_sha256: sha256(canonical(adoption.targets)),
        node_runtime: provenance.node_runtime, deployment_revision: payload.deployment_revision,
        issuer: receipt.issuer_id, evidence_ref: receipt.evidence_ref, coverage_ref: coverage.coverage_ref });
      const viewHash = sha256(canonical(view));
      proof = { factory_payload_sha256: subject, factory_receipt_sha256: receiptHash, factory_trust_ref: trust, view_sha256: viewHash, source_subjects: subjects };
      lastPacket = { payload: view, provenance: { factory_original: raw, mapping: proof } }; lastTrust = trust;
      return structuredClone(lastPacket);
    } catch (error) {
      reason = error instanceof BridgeBlocked ? error.code : "factory_source_invalid";
      throw error;
    }
  };
  const result = await runSetupWithBorrowedLedgerLease(plan, scope, lease, { ...ports.provider, readDeploymentReceipt: project,
    verifyDeployment: async packet => {
      if (!lastPacket || !lastTrust || canonical(packet) !== canonical(lastPacket)) block("factory_view_changed");
      return { status: "verified", subject_sha256: sha256(canonical(packet.payload)), issuer: factoryReceipt.parse(fixedOriginal).issuer_id, trust_ref: lastTrust };
    } }, options);
  return { ...result, bridge: { status: reason || !proof ? "blocked" as const : "verified-view" as const, reason: reason ?? (result.provider.status === "blocked" && !proof ? result.provider.reason : null), proof } };
}
