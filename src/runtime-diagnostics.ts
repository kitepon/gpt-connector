import { randomUUID, X509Certificate } from "node:crypto";
import tls from "node:tls";
import { z } from "zod";
import { packageVersion } from "./version.js";

const caFlags = ["--use-bundled-ca", "--use-openssl-ca", "--use-system-ca", "--no-use-bundled-ca", "--no-use-openssl-ca", "--no-use-system-ca"] as const;
const presence = z.enum(["present", "absent"]);
const selectorsSchema = z.object({
  observedAt: z.literal("module_initialization"),
  flags: z.array(z.enum(caFlags)).max(caFlags.length),
  nodeOptions: presence,
  extraCa: presence,
  systemCa: z.enum(["enabled", "not_enabled"]),
  sslCertFile: presence,
  sslCertDir: presence,
}).strict();

export const runtimeDiagnosticsSchema = z.object({
  schema: z.literal("gpt-connector.runtime-diagnostics.v1"),
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  observedAt: z.iso.datetime(),
  process: z.object({
    source: z.literal("current_process"),
    pid: z.number().int().positive(),
    instanceId: z.uuid(),
    nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/u),
  }).strict(),
  caSelection: selectorsSchema,
  ca: z.object({
    scope: z.literal("node_tls_default_ca_list"),
    targetDerSha256: z.literal("86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b"),
    targetCertificate: z.enum(["present", "absent", "unknown"]),
    reason: z.enum(["target_found", "target_not_found", "selection_unresolved", "api_unavailable", "empty_list", "inspection_failed"]),
    limitation: z.literal("excludes_openssl_default_paths_connection_ca_cached_sessions_other_threads_and_processes"),
  }).strict(),
}).strict();

export type RuntimeDiagnostics = z.infer<typeof runtimeDiagnosticsSchema>;

const instanceId = randomUUID();
const present = (value: string | undefined) => value ? "present" as const : "absent" as const;
const startupSelection: RuntimeDiagnostics["caSelection"] = {
  observedAt: "module_initialization",
  flags: caFlags.filter(flag => process.execArgv.some(arg => arg.replaceAll("_", "-") === flag)),
  nodeOptions: present(process.env.NODE_OPTIONS),
  extraCa: present(process.env.NODE_EXTRA_CA_CERTS),
  systemCa: process.env.NODE_USE_SYSTEM_CA === "1" ? "enabled" : "not_enabled",
  sslCertFile: present(process.env.SSL_CERT_FILE),
  sslCertDir: present(process.env.SSL_CERT_DIR),
};

export function inspectRuntimeCa(getCertificates: typeof tls.getCACertificates | undefined, selection = startupSelection): RuntimeDiagnostics["ca"] {
  const ca: RuntimeDiagnostics["ca"] = {
    scope: "node_tls_default_ca_list",
    targetDerSha256: "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
    targetCertificate: "unknown",
    reason: "api_unavailable",
    limitation: "excludes_openssl_default_paths_connection_ca_cached_sessions_other_threads_and_processes",
  };
  if (typeof getCertificates !== "function") return ca;
  // Node's default-list API does not enumerate OpenSSL default paths; never infer their exclusion.
  if (selection.nodeOptions === "present" || selection.sslCertFile === "present" || selection.sslCertDir === "present" || selection.flags.some(flag => flag === "--use-openssl-ca" || flag.startsWith("--no-"))) {
    return { ...ca, reason: "selection_unresolved" };
  }
  try {
    const certificates = getCertificates("default");
    if (certificates.length === 0) return { ...ca, reason: "empty_list" };
    const fingerprints = certificates.map(certificate => new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase());
    const found = fingerprints.includes(ca.targetDerSha256);
    return { ...ca, targetCertificate: found ? "present" : "absent", reason: found ? "target_found" : "target_not_found" };
  } catch { return { ...ca, reason: "inspection_failed" }; }
}

export function runtimeDiagnostics(): RuntimeDiagnostics {
  return {
    schema: "gpt-connector.runtime-diagnostics.v1",
    packageVersion,
    observedAt: new Date().toISOString(),
    process: { source: "current_process", pid: process.pid, instanceId, nodeVersion: process.version },
    caSelection: { ...startupSelection, flags: [...startupSelection.flags] },
    ca: inspectRuntimeCa(tls.getCACertificates),
  };
}
