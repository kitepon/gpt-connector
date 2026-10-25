import { z } from "zod";
import { planSchema, sha256 } from "./update-ledger-contract.js";
import { factoryCanonical, factoryReceipt, type FactoryBridgePorts, type SourceView } from "./update-ledger-factory-bridge.js";
import { resourcePath, type OriginalPacket, type ProviderContext } from "./update-ledger-provider-ports.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u), text = z.string().min(1).max(1024);
const packet = z.object({ payload: z.unknown(), provenance: z.unknown() }).passthrough().refine(value => value.payload != null && value.provenance != null);
const captureSchema = z.object({ execution_package_root: resourcePath, manifest_sha256: digest, manifest_bytes_base64: z.string().min(1),
  artifact_or_tree_kind: z.enum(["tree", "artifact"]), artifact_or_tree_sha256: digest, tree_sha256: digest,
  tree_original: packet, artifact_sha256: digest.nullable() }).strict();
const provenanceSchema = z.object({ deployment_revision: text, evidence_ref: text, artifact_or_tree_kind: captureSchema.shape.artifact_or_tree_kind,
  artifact_or_tree_sha256: digest, tree_sha256: digest, tree_original: packet, artifact_sha256: digest.nullable(),
  artifact_source_original: packet, artifact_source_sha256: digest }).passthrough();
const adoptionSchema = z.object({ evidence_ref: text, targets: planSchema.shape.targets }).passthrough();
const bundleSchema = z.object({ schema: z.literal("factory.deployment-sources.v1"), factory_payload_sha256: digest, capture: captureSchema,
  provenance: z.object({ input: z.unknown().refine(value => value != null), subject: provenanceSchema }).strict(),
  adoption: z.object({ input: z.unknown().refine(value => value != null), subject: adoptionSchema }).strict() }).strict();

export interface FactoryBundleReaderPorts {
  /** Read the exact issueReceipt evidence_ref while the writer's SH callback is held. */
  readSourceEvidence(evidenceRef: string, context: ProviderContext, signal: AbortSignal): Promise<unknown>;
  /** Existing trusted issuer resolution only. Missing/unaccepted issuer returns null; no bundle self-authority. */
  issuerForSource(kind: "provenance" | "adoption", original: OriginalPacket, context: ProviderContext, signal: AbortSignal): Promise<string | null>;
  readCoverage(context: ProviderContext, signal: AbortSignal): Promise<SourceView | null>;
}

/** Read-only projection, not trust verification. verifySource must still verify originals, tree/source binding and lineage. */
export function createFactoryBundleReader(ports: FactoryBundleReaderPorts): FactoryBridgePorts["readSources"] {
  return async (original, context, signal) => {
    if (signal.aborted) throw new Error("factory_sources_aborted");
    const receipt = factoryReceipt.parse(original), raw = structuredClone(await ports.readSourceEvidence(receipt.evidence_ref, context, signal));
    if (signal.aborted) throw new Error("factory_sources_aborted");
    factoryCanonical(raw); // Reject non-JSON values before parsing/projecting.
    const bundle = bundleSchema.parse(raw), capture = bundle.capture, provenance = bundle.provenance.subject;
    const manifest = Buffer.from(capture.manifest_bytes_base64, "base64"), payloadHash = sha256(factoryCanonical(receipt.payload));
    if (capture.manifest_bytes_base64 !== manifest.toString("base64") || sha256(manifest) !== receipt.payload.manifest_sha256 ||
        bundle.factory_payload_sha256 !== payloadHash || capture.manifest_sha256 !== receipt.payload.manifest_sha256 ||
        capture.execution_package_root !== receipt.payload.execution_package_root || capture.artifact_or_tree_sha256 !== receipt.payload.artifact_or_tree_sha256 ||
        capture.artifact_or_tree_sha256 !== (capture.artifact_or_tree_kind === "tree" ? capture.tree_sha256 : capture.artifact_sha256) ||
        provenance.deployment_revision !== receipt.payload.deployment_revision || provenance.evidence_ref !== receipt.payload.provenance_evidence_ref ||
        provenance.artifact_or_tree_kind !== capture.artifact_or_tree_kind || provenance.artifact_or_tree_sha256 !== capture.artifact_or_tree_sha256 ||
        provenance.tree_sha256 !== capture.tree_sha256 || factoryCanonical(provenance.tree_original) !== factoryCanonical(capture.tree_original) ||
        provenance.artifact_sha256 !== capture.artifact_sha256 || provenance.artifact_source_sha256 !== sha256(factoryCanonical(provenance.artifact_source_original.payload)) ||
        sha256(factoryCanonical(bundle.adoption.subject)) !== receipt.payload.adopted_targets_sha256) throw new Error("factory_sources_binding_mismatch");
    // Keep exact originals and verifier outputs (including extra fields), rather than their parsed subset.
    const exact = raw as { provenance: { input: unknown; subject: { artifact_source_original: OriginalPacket } }; adoption: { input: unknown; subject: unknown } };
    const sourceOriginal = structuredClone(exact.provenance.subject.artifact_source_original);
    const bundleHash = sha256(factoryCanonical(raw));
    const adoptionOriginal: OriginalPacket = { payload: structuredClone(exact.adoption.subject), provenance: {
      factory_evidence_ref: receipt.evidence_ref, source_evidence_sha256: bundleHash, input: structuredClone(exact.adoption.input) } };
    const provenanceIssuer = await ports.issuerForSource("provenance", structuredClone(sourceOriginal), context, signal);
    if (signal.aborted) throw new Error("factory_sources_aborted");
    const adoptionIssuer = await ports.issuerForSource("adoption", structuredClone(adoptionOriginal), context, signal);
    const lineage = { factory_evidence_ref: receipt.evidence_ref, source_evidence_sha256: bundleHash, source_evidence: raw };
    if (signal.aborted) throw new Error("factory_sources_aborted");
    const coverage = await ports.readCoverage(context, signal);
    if (signal.aborted) throw new Error("factory_sources_aborted");
    return { provenance: provenanceIssuer ? { original: sourceOriginal, issuer: provenanceIssuer, lineage: structuredClone(lineage), view: {
      factory_payload_sha256: payloadHash, provenance_evidence_ref: provenance.evidence_ref, artifact_or_tree_kind: capture.artifact_or_tree_kind,
      tree_sha256: capture.tree_sha256, artifact_sha256: capture.artifact_sha256, artifact_source_sha256: provenance.artifact_source_sha256,
      node_runtime: null } } : null,
    adoption: adoptionIssuer ? { original: adoptionOriginal, issuer: adoptionIssuer, lineage: structuredClone(lineage),
      view: { targets: structuredClone(bundle.adoption.subject.targets) } } : null, coverage };
  };
}
