import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { planSchema, sha256, type LedgerPlan, type RuntimeMeasurement } from "./update-ledger-contract.js";

export interface DeploymentReceipt {
  execution_prefix: string;
  manifest_sha256: string;
  deployment_revision: string;
  evidence_ref: string;
}
const manifestSchema = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string(), z.string()).optional() });

/** Resolve the package actually loaded by this installation, including packages hiding package.json in exports. */
async function installedVersion(name: string, manifestPath: string): Promise<string> {
  const require = createRequire(manifestPath);
  let directory = dirname(require.resolve(name));
  for (;;) {
    const path = join(directory, "package.json");
    let bytes: string | undefined;
    try { bytes = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (bytes !== undefined) {
      const manifest = manifestSchema.parse(JSON.parse(bytes));
      if (manifest.name === name) return manifest.version;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("ledger_dependency_manifest_missing");
    directory = parent;
  }
}

/** Invoked only by an explicitly installed completion hook. No lockfile/range/main checkout fallback. */
export async function readInstalledMeasurement(planInput: LedgerPlan, runId: string, deployment: DeploymentReceipt,
  health: RuntimeMeasurement["health"], ports: { clock?: () => string; nodeVersion?: () => string } = {}): Promise<RuntimeMeasurement> {
  const plan = planSchema.parse(planInput), prefix = await realpath(plan.identity.execution_prefix);
  if (prefix !== resolve(deployment.execution_prefix) || prefix !== resolve(plan.identity.execution_prefix)) throw new Error("ledger_prefix_mismatch");
  const manifestPath = join(prefix, "package.json"), bytes = await readFile(manifestPath);
  if (sha256(bytes) !== deployment.manifest_sha256) throw new Error("ledger_deployment_receipt_mismatch");
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.name !== "gpt-connector") throw new Error("ledger_package_mismatch");
  const bindings: RuntimeMeasurement["bindings"] = [];
  for (const entry of plan.targets) {
    const target = entry.target;
    if (target.kind === "npm" && target.name !== "gpt-connector" && !Object.hasOwn(manifest.dependencies ?? {}, target.name)) throw new Error("ledger_not_runtime_dependency");
    const installed = target.kind === "node" ? (ports.nodeVersion ?? (() => process.versions.node))() : target.name === "gpt-connector" ? manifest.version : await installedVersion(target.name, manifestPath);
    bindings.push({ component: entry.component, target, installed, status: "active" });
  }
  if (sha256(await readFile(manifestPath)) !== deployment.manifest_sha256 || await realpath(plan.identity.execution_prefix) !== prefix) throw new Error("ledger_deployment_changed");
  return { identity: plan.identity, run_id: runId, observed_at: (ports.clock ?? (() => new Date().toISOString()))(), source: { kind: "installed-package", name: "gpt-connector",
    installed: manifest.version, deployment_revision: deployment.deployment_revision, manifest_sha256: sha256(bytes), deployment_evidence_ref: deployment.evidence_ref }, bindings, health };
}
