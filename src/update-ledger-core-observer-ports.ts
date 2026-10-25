// Proposal only: no implementation, CLI import, helper copy or host activation.
export interface ObserverOriginalRef {
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface CoreRuntimeSelf {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly gid: number;
  readonly cwd: string;
  readonly exec_path: string;
  readonly process_version: string;
  readonly entry_path: string;
}
export interface KernelCoreIdentity {
  readonly boot_id: string;
  readonly pid: number;
  readonly start_ticks: string;
  readonly effective_uid: number;
  readonly effective_gid: number;
  readonly cwd: string;
  readonly executable_realpath: string;
}
// Product-owned run object, never reconstructed from factory JS/environment/plan.
export interface ProductCoreRun {
  readonly token: object;
  readonly mode: "setup" | "check";
  readonly run_id: string;
  readonly started_at_utc_ms: number;
  readonly runtime_self: CoreRuntimeSelf;
  readonly kernel_identity: KernelCoreIdentity;
  readonly launcher_identity: string;
  readonly public_setup_before: ObserverOriginalRef;
  readonly core_started_original: ObserverOriginalRef;
}
export interface CoreCompletionOriginal {
  readonly completed_at_utc_ms: number;
  readonly exit_code: number;
  // Exact ordinary result original. No canonical reserialization in place of emitted bytes.
  readonly result_original: ObserverOriginalRef | null;
  readonly serialized_result_sha256: string;
  readonly serialized_result_bytes: number;
  readonly stdout_write: "callback_completed" | "failed" | "not_written";
}
export type CoreObservationOutcome =
  | { readonly status: "recorded_raw"; readonly original: ObserverOriginalRef;
    readonly normal_job_binding: "unknown_until_dispatcher_source_correlation";
    readonly reporting_allowed: false; readonly resource_read_authorized: false }
  | { readonly status: "unknown"; readonly reason: "observer_disabled" | "original_missing" | "run_mismatch"
    | "runtime_mismatch" | "output_unconfirmed" | "storage_unconfirmed" };

/** Future shared one-owner helper bridge; Dorothy owns helper/storage, Guren owns
 * core call sites, own-process runtime fields and original result binding. */
export interface ProductCoreObserverPorts {
  // Called inside the core which will actually run setup, after npm/re-exec returns null.
  // Reads the exact existing factory before original through the shared helper; validates
  // same launcher, actual process ancestry, source pins and current kernel identity.
  beginOwnCore(mode: "setup" | "check", self: CoreRuntimeSelf): Promise<ProductCoreRun | Extract<CoreObservationOutcome, { status: "unknown" }>>;
  // Same private run token/process/start identity; preserves original partial/failed code.
  // Does not rerun setup, version queries, NVM/npm, or replace the ordinary result.
  completeOwnCore(run: ProductCoreRun, completion: CoreCompletionOriginal): Promise<CoreObservationOutcome>;
}
