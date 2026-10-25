import { posix, win32 } from "node:path";
import { canonical, identitySchema, measurementSchema, planSchema, sameIdentity, sha256, type RuntimeMeasurement, type SetupRunResult } from "./update-ledger-contract.js";
import { readInstalledMeasurement } from "./update-ledger-collector.js";
import { createLedgerCompletionHook } from "./update-ledger-hook.js";
import { acceptancePayloadSchema, deploymentPayloadSchema, installedStateSchema, providerScopeSchema,
  type DeploymentPayload, type OriginalPacket, type ProviderContext, type ProviderPorts, type ProviderProof, type ReadLease, type RunContext, type Verification } from "./update-ledger-provider-ports.js";
import type { SetupOptions } from "./setup.js";
import type { SenderPorts } from "./update-ledger-sender.js";

class ProviderBlocked extends Error {
  constructor(readonly code: string) { super(code); }
}
function block(code: string): never { throw new ProviderBlocked(code); }
function covers(root: string, path: string) {
  const platform = path.startsWith("/") ? posix : win32, relative = platform.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${platform.sep}`) && !platform.isAbsolute(relative));
}
function verified(packet: OriginalPacket, result: Verification, issuer: string): string {
  if (result.status !== "verified" || result.subject_sha256 !== sha256(canonical(packet.payload)) || result.issuer !== issuer || !result.trust_ref) block("ledger_provider_trust_unverified");
  return result.trust_ref;
}
async function assertLease(context: ProviderContext, lease: ReadLease, now: () => number) {
  if (lease.mode !== "SH" || canonical(lease.resources) !== canonical(context.mutation_resources) || lease.generation !== context.expectedGeneration) block("ledger_provider_lease_mismatch");
  if (lease.signal.aborted || now() >= context.deadline) block("ledger_provider_aborted");
  await lease.assertCurrent();
  if (lease.signal.aborted || now() >= context.deadline || lease.generation !== context.expectedGeneration) block("ledger_provider_aborted");
}
function checkReceipt(receipt: DeploymentPayload, context: ProviderContext, adoptionHash: string) {
  if (receipt.state !== "committed" || receipt.generation !== context.expectedGeneration || !sameIdentity(receipt.identity, context.identity) ||
      receipt.execution_package_root !== context.execution_package_root || canonical(receipt.mutation_resources) !== canonical(context.mutation_resources) ||
      receipt.coverage_ref !== context.coverage_ref || receipt.target_projection_sha256 !== adoptionHash) block("ledger_provider_receipt_mismatch");
}
async function checkInstalled(receipt: DeploymentPayload, context: ProviderContext, ports: ProviderPorts, lease: ReadLease, now: () => number) {
  await assertLease(context, lease, now);
  const actual = installedStateSchema.parse(await ports.inspectInstalled(context, lease.signal));
  const expected = { identity: receipt.identity, execution_package_root: receipt.execution_package_root, mutation_resources: receipt.mutation_resources,
    generation: receipt.generation, manifest_sha256: receipt.manifest_sha256, tree_sha256: receipt.tree_sha256,
    artifact_source_sha256: receipt.artifact_source_sha256, target_adoption_sha256: receipt.target_adoption_sha256,
    target_projection_sha256: receipt.target_projection_sha256, node_runtime: receipt.node_runtime };
  if (canonical(actual) !== canonical(expected)) block("ledger_provider_installed_mismatch");
  await assertLease(context, lease, now);
}

export interface ProviderResult {
  result: (SetupRunResult & { updateLedger?: unknown }) | null;
  provider: { status: "verified-source"; proof: ProviderProof } | { status: "blocked"; reason: string; proof: ProviderProof | null };
}

/** Explicit composition only. No default ports, CLI activation, native locks, trust issuer or credential loading. */
export async function runSetupWithVerifiedLedger(planInput: unknown, scopeInput: unknown, ports: ProviderPorts,
  options: Omit<SetupOptions, "updateLedger"> = {}): Promise<ProviderResult> {
  let normal: ProviderResult["result"] = null, proof: ProviderProof | null = null, blockedReason: string | null = null;
  try {
    const plan = planSchema.parse(planInput), scope = providerScopeSchema.parse(scopeInput), now = ports.now ?? Date.now;
    if (scope.mutation_resources === null || scope.expectedGeneration === null || scope.coverage_ref === null) block("ledger_provider_resources_unknown");
    if (now() >= scope.deadline) block("ledger_provider_aborted");
    if (plan.identity.execution_prefix !== scope.execution_package_root || !scope.mutation_resources.some(root => covers(root, scope.execution_package_root))) block("ledger_provider_resource_mismatch");
    const context: ProviderContext = { identity: identitySchema.parse(plan.identity), execution_package_root: scope.execution_package_root,
      mutation_resources: scope.mutation_resources, expectedGeneration: scope.expectedGeneration, coverage_ref: scope.coverage_ref,
      target_adoptions: plan.targets, deadline: scope.deadline };
    Object.freeze(context.identity.owner); Object.freeze(context.identity); Object.freeze(context.mutation_resources);
    for (const entry of context.target_adoptions) { Object.freeze(entry.target); Object.freeze(entry); }
    Object.freeze(context.target_adoptions); Object.freeze(context);
    const adoptionHash = sha256(canonical(plan.targets));
    const result = await ports.withReadLease(context.mutation_resources, context.expectedGeneration, context.deadline, async lease => {
      await assertLease(context, lease, now);
      const packet = structuredClone(await ports.readDeploymentReceipt(context, lease.signal)), receipt = deploymentPayloadSchema.parse(packet.payload);
      checkReceipt(receipt, context, adoptionHash);
      const deploymentTrust = verified(packet, await ports.verifyDeployment(structuredClone(packet), context, lease.signal), receipt.issuer);
      if (plan.targets.some(entry => entry.target.kind === "node") && !receipt.node_runtime) block("ledger_provider_node_unknown");
      await checkInstalled(receipt, context, ports, lease, now); // SH acquired, generation and real tree verified before public setup.
      const sourceSender = !options.check ? ports.senderForLease?.(context, lease) : undefined;
      const sender: SenderPorts | undefined = sourceSender ? { ...sourceSender, transport: {
        identity: structuredClone(sourceSender.transport.identity),
        get: async (path, signal) => { await assertLease(context, lease, now); return sourceSender.transport.get(path, AbortSignal.any([signal, lease.signal])); },
        post: async (path, body, signal) => { await assertLease(context, lease, now); return sourceSender.transport.post(path, body, AbortSignal.any([signal, lease.signal])); },
      } } : undefined;
      const hook = createLedgerCompletionHook(plan, { clock: ports.clock, uuid: ports.uuid, sender,
        measure: async (start, originalResult) => {
          try {
            await assertLease(context, lease, now);
            const current = await ports.readDeploymentReceipt(context, lease.signal);
            if (canonical(current.payload) !== canonical(packet.payload)) block("ledger_provider_receipt_changed");
            verified(current, await ports.verifyDeployment(structuredClone(current), context, lease.signal), receipt.issuer);
            const run: RunContext = { ...context, ...start, mode: options.check ? "check" : "setup", result_sha256: sha256(canonical(originalResult)) };
            const original = await ports.readAcceptance(run, structuredClone(originalResult), lease.signal);
            let health: RuntimeMeasurement["health"] = { run_id: start.run_id, observed_at: (ports.clock ?? (() => new Date().toISOString()))(), raw: null, acceptance: null };
            let acceptanceHash: string | null = null, acceptanceTrust: string | null = null;
            if (original !== null) {
              const accepted = acceptancePayloadSchema.parse(original.payload);
              if (!sameIdentity(accepted.identity, context.identity) || accepted.generation !== context.expectedGeneration || accepted.deployment_revision !== receipt.deployment_revision ||
                  accepted.run_id !== start.run_id || accepted.mode !== run.mode || accepted.result_sha256 !== run.result_sha256 ||
                  canonical(accepted.required_clients) !== canonical(plan.required_clients)) block("ledger_provider_acceptance_mismatch");
              acceptanceTrust = verified(original, await ports.verifyAcceptance(structuredClone(original), run, lease.signal), accepted.issuer);
              acceptanceHash = sha256(canonical(original.payload));
              health = { run_id: start.run_id, observed_at: accepted.observed_at, raw: accepted.raw_health,
                acceptance: accepted.passed === null ? null : { run_id: start.run_id, observed_at: accepted.observed_at, source_revision: receipt.deployment_revision,
                  execution_prefix: context.execution_package_root, normal_path: true, passed: accepted.passed, evidence_ref: accepted.evidence_ref } };
            }
            await checkInstalled(receipt, context, ports, lease, now);
            const measured = measurementSchema.parse(await (ports.sampleInstalled ?? readInstalledMeasurement)(plan, start.run_id, {
              execution_prefix: context.execution_package_root, manifest_sha256: receipt.manifest_sha256,
              deployment_revision: receipt.deployment_revision, evidence_ref: receipt.evidence_ref }, health, { clock: ports.clock }));
            if (!sameIdentity(measured.identity, context.identity) || measured.run_id !== start.run_id || measured.source.manifest_sha256 !== receipt.manifest_sha256 ||
                measured.source.deployment_revision !== receipt.deployment_revision || measured.source.deployment_evidence_ref !== receipt.evidence_ref ||
                canonical(measured.health) !== canonical(health)) block("ledger_provider_projection_mismatch");
            if (receipt.node_runtime && measured.bindings.some(binding => binding.target.kind === "node" && binding.installed !== receipt.node_runtime!.installed)) block("ledger_provider_node_mismatch");
            await checkInstalled(receipt, context, ports, lease, now);
            proof = { scope: context, deployment_sha256: sha256(canonical(packet.payload)), deployment_trust_ref: deploymentTrust,
              acceptance_sha256: acceptanceHash, acceptance_trust_ref: acceptanceTrust, result_sha256: run.result_sha256, raw_health: health };
            return measured;
          } catch (error) { blockedReason = error instanceof ProviderBlocked ? error.code : "ledger_provider_failed"; throw error; }
        } });
      normal = structuredClone(await ports.publicSetup({ ...options, updateLedger: hook }, lease.signal));
      await assertLease(context, lease, now);
      const outcome = normal.updateLedger as { status?: string } | undefined;
      if (!proof || !outcome || !["collected", "confirmed", "observed", "unknown", "previous_operation"].includes(outcome.status ?? "") ||
          (options.check && outcome.status !== "collected")) block(blockedReason ?? "ledger_provider_evidence_incomplete");
      return { result: normal, provider: { status: "verified-source" as const, proof } };
    });
    return result;
  } catch (error) { return { result: normal, provider: { status: "blocked", reason: error instanceof ProviderBlocked ? error.code : "ledger_provider_failed", proof } }; }
}
