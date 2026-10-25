// Explicit product-owned source composition. No default helper, CLI activation or credential port.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "./update-ledger-contract.js";
import { admitCoreFrame } from "./update-ledger-core-frame.js";
import { readPublicJsonFrame } from "./public-json.js";
import type { PublicJsonFrame } from "./public-json.js";
import type { CoreCompletionOriginal, CoreObservationOutcome, CoreRuntimeSelf, ProductCoreObserverPorts, ProductCoreRun } from "./update-ledger-core-observer-ports.js";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const absolute = z.string().min(1).max(4096).refine(value => value.startsWith("/")); // First scope is Linux.
const ref = z.object({ ref: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: integer }).strict();
const selfSchema = z.object({ pid: integer.positive(), ppid: integer.positive(), uid: integer, gid: integer, cwd: absolute,
  exec_path: absolute, process_version: z.string().regex(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u), entry_path: absolute }).strict();
const kernel = z.object({ boot_id: z.uuid(), pid: integer.positive(), start_ticks: z.string().regex(/^[0-9]+$/u),
  effective_uid: integer, effective_gid: integer, cwd: absolute, executable_realpath: absolute }).strict();
const flags = { normal_job_binding: z.literal("unknown_until_dispatcher_source_correlation"), reporting_allowed: z.literal(false), resource_read_authorized: z.literal(false) };
const kind = z.enum(["fixture_core", "observed_core"]);
const unknown = z.object({ status: z.literal("unknown"), reason: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
  result_original: z.null(), metadata_original: ref.optional(), kind: kind.optional(), ...flags }).strict();
const beginReply = z.object({ status: z.literal("recorded_raw"), kind, original: ref, kernel_identity: kernel,
  launcher_identity: z.string().min(1).max(512), public_setup_before: ref, ...flags }).strict();
const resultReply = z.object({ status: z.literal("recorded_raw"), kind, original: ref, result_original: ref, ...flags }).strict();
type BeginControl = { mode: "setup" | "check"; run_id: string; runtime_self: CoreRuntimeSelf };
export interface CoreHelperBridge {
  // Adapter owns the one helper child/2500ms, existing private activation/expected-pins gate,
  // dedicated stdin and captured fd3. Production adapter is not supplied here.
  exchange(phase: "core_begin" | "core_result", control: BeginControl & {
    core_started_original?: ProductCoreRun["core_started_original"];
    completion?: Omit<CoreCompletionOriginal, "result_original">;
  }, frame: Uint8Array | null): Promise<unknown>;
}
const completions = new WeakMap<CoreCompletionOriginal, { text: string }>();
export function prepareCoreCompletion(frame: PublicJsonFrame, original: {
  completed_at_utc_ms: number; exit_code: number; stdout_write: CoreCompletionOriginal["stdout_write"];
}): CoreCompletionOriginal {
  const values = z.object({ completed_at_utc_ms: integer.positive(), exit_code: integer.max(255),
    stdout_write: z.enum(["callback_completed", "failed", "not_written"]) }).strict().parse(original);
  const admission = admitCoreFrame(frame), { text } = readPublicJsonFrame(frame);
  const completion = Object.freeze({ ...values, result_original: null, serialized_result_sha256: admission.frame_sha256,
    serialized_result_bytes: admission.frame_bytes, frame_admission: admission });
  completions.set(completion, { text });
  return completion;
}
/** Attach to the existing single write callback; never write/serialize the result again. */
export function createCoreWriteObserver(frame: PublicJsonFrame, exitCode: number, now: () => number = Date.now) {
  readPublicJsonFrame(frame); integer.max(255).parse(exitCode);
  const reservation = Promise.withResolvers<CoreCompletionOriginal>();
  let settled = false;
  return Object.freeze({ completed: reservation.promise, callback(error?: Error | null) {
    if (settled) return;
    settled = true;
    try { reservation.resolve(prepareCoreCompletion(frame, { completed_at_utc_ms: now(), exit_code: exitCode,
      stdout_write: error ? "failed" : "callback_completed" })); }
    catch (failure) { reservation.reject(failure); }
  } });
}
type UnknownOutcome = Extract<CoreObservationOutcome, { status: "unknown" }>;
const blocked = (reason: UnknownOutcome["reason"]): UnknownOutcome => ({ status: "unknown", reason });
interface OwnedRun { run: ProductCoreRun; completion?: CoreCompletionOriginal; pending?: Promise<CoreObservationOutcome> }

/** Own-process reader runs only when explicitly called by the real core after re-exec. */
export function readOwnCoreRuntime(): CoreRuntimeSelf {
  if (process.platform !== "linux" || !process.getuid || !process.getgid) throw new Error("core_runtime_unavailable");
  return selfSchema.parse({ pid: process.pid, ppid: process.ppid, uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(),
    exec_path: process.execPath, process_version: process.version, entry_path: process.argv[1] });
}
export function createProductCoreObserver(bridge: CoreHelperBridge, options: {
  ownRuntime?: () => CoreRuntimeSelf; now?: () => number; uuid?: () => string;
} = {}): ProductCoreObserverPorts & { readonly privateHelperReason: string | null } {
  const own = options.ownRuntime ?? readOwnCoreRuntime, now = options.now ?? Date.now, uuid = options.uuid ?? randomUUID;
  const runs = new WeakMap<ProductCoreRun, OwnedRun>(), claims = new WeakMap<CoreCompletionOriginal, ProductCoreRun>();
  let privateReason: string | null = null;
  let began = false; // One activation/core invocation; reserve before injected readers/helper can reenter.
  const note = (reply: z.infer<typeof unknown>) => { privateReason = reply.reason; return blocked("storage_unconfirmed"); };
  return {
    get privateHelperReason() { return privateReason; },
    async beginOwnCore(mode, selfInput) {
      if (began) return blocked("run_mismatch");
      began = true;
      try {
        const self = selfSchema.parse(selfInput), actual = selfSchema.parse(own());
        if (canonical(self) !== canonical(actual) || !["setup", "check"].includes(mode)) return blocked("runtime_mismatch");
        const started = integer.positive().parse(now()), runId = z.uuid().parse(uuid());
        const raw = structuredClone(await bridge.exchange("core_begin", { mode, run_id: runId, runtime_self: self }, null));
        const missing = unknown.safeParse(raw);
        if (missing.success) return note(missing.data);
        const proof = beginReply.parse(raw), observed = proof.kernel_identity;
        if (canonical(own()) !== canonical(actual) || observed.pid !== self.pid || observed.effective_uid !== self.uid
          || observed.effective_gid !== self.gid || observed.cwd !== self.cwd) return blocked("runtime_mismatch");
        const run: ProductCoreRun = Object.freeze({ token: Object.freeze({}), mode, run_id: runId, started_at_utc_ms: started,
          runtime_self: Object.freeze(self), kernel_identity: Object.freeze(observed), launcher_identity: proof.launcher_identity,
          public_setup_before: Object.freeze(proof.public_setup_before), core_started_original: Object.freeze(proof.original), evidence_kind: proof.kind });
        runs.set(run, { run }); return run;
      } catch { return blocked("storage_unconfirmed"); }
    },
    completeOwnCore(run, completion) {
      const owned = runs.get(run), original = completions.get(completion);
      if (!owned || !original || (claims.has(completion) && claims.get(completion) !== run)
        || (owned.completion && owned.completion !== completion)) return Promise.resolve(blocked("run_mismatch"));
      if (owned.pending) return owned.pending;
      const reservation = Promise.withResolvers<CoreObservationOutcome>();
      owned.pending = reservation.promise; owned.completion = completion; claims.set(completion, run);
      void (async (): Promise<CoreObservationOutcome> => {
        try {
          if (canonical(own()) !== canonical(owned.run.runtime_self)) return blocked("runtime_mismatch");
          if (completion.completed_at_utc_ms < run.started_at_utc_ms || completion.completed_at_utc_ms > now()) return blocked("run_mismatch");
          const wireCompletion = { completed_at_utc_ms: completion.completed_at_utc_ms, exit_code: completion.exit_code,
            serialized_result_sha256: completion.serialized_result_sha256, serialized_result_bytes: completion.serialized_result_bytes,
            stdout_write: completion.stdout_write, frame_admission: completion.frame_admission };
          const permitted = completion.frame_admission.decision === "full_frame" && completion.stdout_write === "callback_completed";
          const raw = structuredClone(await bridge.exchange("core_result", {
            mode: run.mode, run_id: run.run_id, runtime_self: structuredClone(run.runtime_self),
            core_started_original: structuredClone(run.core_started_original), completion: structuredClone(wireCompletion),
          }, permitted ? new TextEncoder().encode(original.text) : null));
          const missing = unknown.safeParse(raw);
          if (missing.success) return note(missing.data);
          const saved = resultReply.parse(raw);
          if (!permitted) return blocked(completion.stdout_write === "callback_completed" ? "original_missing" : "output_unconfirmed");
          if (saved.result_original.sha256 !== completion.serialized_result_sha256 || saved.result_original.bytes !== completion.serialized_result_bytes)
            return blocked("storage_unconfirmed");
          if (saved.kind !== run.evidence_kind) return blocked("run_mismatch");
          return { status: "recorded_raw", kind: saved.kind, original: saved.original, normal_job_binding: saved.normal_job_binding,
            reporting_allowed: false, resource_read_authorized: false };
        } catch { return blocked("storage_unconfirmed"); }
      })().then(reservation.resolve, reservation.reject);
      return reservation.promise;
    },
  };
}
