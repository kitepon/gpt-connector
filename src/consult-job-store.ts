import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  consultSlugSchema,
  type ConsultJobState,
  type ConsultSnapshot,
} from "./contract.js";
import { ConnectorError, connectorErrorCodes } from "./errors.js";
import { codexParentSchema, type CodexParent } from "./codex-parent.js";
import { cursorParentSchema, cursorReceiveCommand, type CursorParent } from "./cursor-parent.js";
import { codexHookDeliveryState } from "./codex-hook-state.js";
import { chmodPrivateIfPosix, defaultConsultStateDirectory, posixModeExposesOthers } from "./platform/state.js";

export type DeliveryParent = CodexParent | CursorParent;
const deliveryParentSchema = z.union([cursorParentSchema, codexParentSchema]);

const retrySchema = z.enum([
  "never",
  "after_input_change",
  "after_auth",
  "after_runtime_update",
  "status_first",
]);

const attachmentSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  names: z.array(z.string()),
  mimeTypes: z.array(z.string().nullable()),
  readBack: z.literal("confirmed"),
  retention: z.literal("unknown"),
  cleanup: z.enum(["not_supported", "failed", "deleted"]),
}).strict();

const generatedImageSummarySchema = z.object({
  count: z.number().int().positive(),
  files: z.array(z.object({
    relativePath: z.string().min(1),
    mimeType: z.string().startsWith("image/"),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }).strict()).min(1),
  readBack: z.literal("confirmed"),
  retention: z.enum(["library", "recently_deleted", "mixed"]),
  cleanup: z.enum(["not_supported", "soft_deleted", "failed", "partial"]),
}).strict().superRefine((value, context) => {
  if (value.count !== value.files.length) {
    context.addIssue({ code: "custom", message: "image count mismatch" });
  }
});

const successResultSchema = z.object({
  text: z.string(),
  status: z.string(),
  endTurn: z.literal(true),
  resolvedModel: z.string().nullable(),
  resolvedEffort: z.string().nullable(),
  requestedMode: z.literal("auto").optional(),
  reportedModel: z.string().nullable().optional(),
  sessionId: z.string().uuid().optional(),
  attachments: attachmentSummarySchema,
  images: generatedImageSummarySchema.optional(),
  archived: z.boolean(),
}).strict();

const failureSchema = z.object({
  code: z.enum(connectorErrorCodes),
  message: z.string(),
  retry: retrySchema,
  partialUpload: z.object({
    count: z.number().int().positive(),
    cleanup: z.enum(["not_supported", "failed"]),
  }).strict().optional(),
}).strict();

const snapshotSchema = z.object({
  slug: consultSlugSchema,
  sessionId: z.string().uuid().optional(),
  delivery: z.object({
    id: z.string().uuid(), mode: z.literal("steer"),
    state: z.enum(["waiting", "sending", "submitted", "failed", "unknown"]), error: z.string().nullable(),
  }).strict().optional(),
  receiveCommand: z.string().min(1).optional(),
  state: z.enum(["queued", "uploading", "submitted", "running", "succeeded", "failed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  result: successResultSchema.nullable(),
  error: failureSchema.nullable(),
}).strict();

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
}).strict();

const persistedSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  jobs: z.array(z.object({
    fingerprint: z.string().min(1),
    parent: deliveryParentSchema.optional(),
    snapshot: snapshotSchema,
    owner: ownerSchema.optional(),
    deliveryOwner: ownerSchema.optional(),
  }).strict()),
}).strict();

const writerLockSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
}).strict();

interface StoredJob {
  readonly fingerprint: string;
  readonly parent?: DeliveryParent;
  readonly snapshot: ConsultSnapshot;
  readonly owner?: z.output<typeof ownerSchema>;
  readonly deliveryOwner?: z.output<typeof ownerSchema>;
}

function visibleSnapshot(job: StoredJob): ConsultSnapshot {
  const snapshot = structuredClone(job.snapshot);
  if (job.parent && "codexHome" in job.parent && snapshot.delivery?.state === "submitted") {
    const state = codexHookDeliveryState(job.parent.codexHome, job.parent.threadId, snapshot.delivery.id);
    if (state) return { ...snapshot, delivery: { ...snapshot.delivery, state,
      error: state === "unknown" ? "PARENT_DELIVERY_UNKNOWN" : null } };
  }
  return snapshot;
}

export interface ConsultJobStoreOptions {
  readonly stateDirectory?: string;
  readonly readOnly?: boolean;
}

export interface ReserveResult {
  readonly created: boolean;
  readonly snapshot: ConsultSnapshot;
}

export interface ConsultJobStoreDiagnostics {
  readonly jobCount: number;
  readonly activeJobCount: number;
  readonly terminalJobCount: number;
}

export interface ConsultJobTransitionUpdate {
  readonly sessionId?: string;
  readonly result?: ConsultSnapshot["result"];
  readonly error?: null | {
    readonly code: string;
    readonly message: string;
    readonly retry: string;
    readonly partialUpload?: {
      readonly count: number;
      readonly cleanup: string;
    };
  };
}

const allowedTransitions = new Map<ConsultJobState, readonly ConsultJobState[]>([
  ["queued", ["uploading", "submitted", "failed"]],
  ["uploading", ["submitted", "failed"]],
  ["submitted", ["running", "failed"]],
  ["running", ["succeeded", "failed"]],
  ["succeeded", []],
  ["failed", []],
]);

export { defaultConsultStateDirectory } from "./platform/state.js";

export class ConsultJobStore {
  readonly #stateDirectory: string;
  readonly #statePath: string;
  readonly #legacyLockPath: string;
  readonly #transactionLockPath: string;
  readonly #ownerPath: string;
  readonly #readOnly: boolean;
  readonly #instanceId = randomUUID();
  readonly #owner = { pid: process.pid, instanceId: this.#instanceId };
  #jobs = new Map<string, StoredJob>();
  #initialized = false;
  #closed = false;
  #ownsTransactionLock = false;
  #ownsOwnerLease = false;
  #exclusiveTail: Promise<void> = Promise.resolve();
  #readOnlyRecoveries = new Map<string, { source: string; job: StoredJob }>();

  constructor(options: ConsultJobStoreOptions = {}) {
    this.#stateDirectory = options.stateDirectory ?? defaultConsultStateDirectory();
    this.#statePath = join(this.#stateDirectory, "consult-jobs.json");
    this.#legacyLockPath = join(this.#stateDirectory, "consult-jobs.lock");
    this.#transactionLockPath = join(this.#stateDirectory, "consult-jobs.transaction.lock");
    this.#ownerPath = join(this.#stateDirectory, `consult-owner-${this.#instanceId}.json`);
    this.#readOnly = options.readOnly ?? false;
  }

  get stateDirectory(): string {
    return this.#stateDirectory;
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#initialized) return;
      this.#assertOpen();
      await this.#prepareStateDirectory();
      if (this.#readOnly) {
        this.#jobs = this.#readJobsSync();
      } else {
        await writeFile(this.#ownerPath, JSON.stringify(this.#owner), { mode: 0o600, flag: "wx" });
        this.#ownsOwnerLease = true;
        try {
          await this.#withTransaction(async () => {
            await this.#loadCurrent();
            await this.#pruneDeadOwnerLeases();
          });
        } catch (error) {
          this.#releaseOwnerLease();
          throw error;
        }
      }
      this.#initialized = true;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#releaseOwnerLease();
    this.#closed = true;
  }

  async reserve(slug: string, fingerprint: string, parent?: DeliveryParent): Promise<ReserveResult> {
    return this.#exclusive(async () => {
      this.#assertInitialized();
      this.#assertWritable();
      if (!consultSlugSchema.safeParse(slug).success || fingerprint.length === 0) {
        throw new ConnectorError("INVALID_INPUT", "consult job keyが不正です。");
      }
      return this.#withTransaction(async () => {
        const current = await this.#loadCurrent();
        const existing = current.get(slug);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new ConnectorError(
              "JOB_CONFLICT",
              "同じslugへ異なるconsult inputは送信できません。",
            );
          }
          return { created: false, snapshot: visibleSnapshot(existing) };
        }

        const now = new Date().toISOString();
        const deliveryId = parent ? randomUUID() : undefined;
        const parsedParent = parent ? deliveryParentSchema.parse(parent) : undefined;
        const job: StoredJob = {
          fingerprint,
          owner: this.#owner,
          ...(parsedParent ? { parent: parsedParent } : {}),
          snapshot: {
            slug,
            state: "queued",
            createdAt: now,
            updatedAt: now,
            result: null,
            error: null,
            ...(deliveryId !== undefined ? {
              delivery: { id: deliveryId, mode: "steer" as const, state: "waiting" as const, error: null },
              ...("socketRoot" in (parsedParent ?? {}) ? {
                receiveCommand: cursorReceiveCommand(deliveryId, this.#stateDirectory),
              } : {}),
            } : {}),
          },
        };
        const next = new Map(current);
        next.set(slug, job);
        await this.#persist(next);
        this.#jobs = next;
        return { created: true, snapshot: structuredClone(job.snapshot) };
      });
    });
  }

  async transition(
    slug: string,
    state: ConsultJobState,
    update: ConsultJobTransitionUpdate = {},
  ): Promise<ConsultSnapshot> {
    return this.#exclusive(async () => {
      this.#assertInitialized();
      this.#assertWritable();
      return this.#withTransaction(async () => {
        const jobs = await this.#loadCurrent();
        const current = jobs.get(slug);
        if (current === undefined) {
          throw new ConnectorError("JOB_NOT_FOUND", "指定slugのconsult jobは存在しません。");
        }
        if (current.owner?.instanceId !== this.#instanceId) {
          throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "このprocessはconsult jobの実行元ではありません。");
        }
        if (!allowedTransitions.get(current.snapshot.state)?.includes(state)) {
          throw new ConnectorError("RUNTIME_DRIFT", "consult job state transitionが不正です。");
        }
        const candidate = snapshotSchema.safeParse({
          ...current.snapshot,
          ...(update.sessionId === undefined ? {} : { sessionId: update.sessionId }),
          state,
          updatedAt: new Date().toISOString(),
          result: state === "succeeded" ? (update.result ?? null) : null,
          error: state === "failed" ? (update.error ?? null) : null,
        });
        if (
          !candidate.success ||
          (state === "succeeded" && candidate.data.result === null) ||
          (state === "failed" && candidate.data.error === null)
        ) {
          throw new ConnectorError("RUNTIME_DRIFT", "consult job terminal payloadが不正です。");
        }
        const next = new Map(jobs);
        next.set(slug, {
          ...current,
          owner: (state === "succeeded" || state === "failed") && current.snapshot.delivery?.state !== "waiting"
            ? undefined : current.owner,
          snapshot: candidate.data,
        });
        await this.#persist(next);
        this.#jobs = next;
        return structuredClone(candidate.data);
      });
    });
  }

  get(slug: string): ConsultSnapshot {
    this.#assertInitialized();
    this.#refreshJobsForRead();
    const job = this.#jobs.get(slug);
    if (job === undefined) {
      throw new ConnectorError("JOB_NOT_FOUND", "指定slugのconsult jobは存在しません。");
    }
    return visibleSnapshot(job);
  }

  /** 短期transaction lockと永続化したsendingで配送を一つに決め、受付不明時の再送を防ぐ。 */
  async claimDeliveries(): Promise<Array<{ parent: DeliveryParent; snapshot: ConsultSnapshot }>> {
    return this.#exclusive(async () => {
      this.#assertInitialized();
      this.#assertWritable();
      return this.#withTransaction(async () => {
        const next = new Map(await this.#loadCurrent());
        const claimed: Array<{ parent: DeliveryParent; snapshot: ConsultSnapshot }> = [];
        for (const [slug, job] of next) {
          if (job.snapshot.delivery?.state !== "waiting" || !job.parent ||
              (job.snapshot.state !== "succeeded" && job.snapshot.state !== "failed")) continue;
          if (job.owner?.instanceId !== this.#instanceId && job.owner && this.#ownerLive(job.owner)) continue;
          const snapshot: ConsultSnapshot = { ...job.snapshot, updatedAt: new Date().toISOString(),
            delivery: { ...job.snapshot.delivery, state: "sending" } };
          next.set(slug, { ...job, owner: undefined, snapshot, deliveryOwner: this.#owner });
          claimed.push({ parent: job.parent, snapshot: structuredClone(snapshot) });
        }
        if (claimed.length > 0) {
          await this.#persist(next);
          this.#jobs = next;
        }
        return claimed;
      });
    });
  }

  async finishDelivery(slug: string, state: "submitted" | "failed" | "unknown", error: string | null): Promise<void> {
    await this.#exclusive(async () => {
      this.#assertInitialized();
      this.#assertWritable();
      await this.#withTransaction(async () => {
        const next = new Map(await this.#loadCurrent());
        const job = next.get(slug);
        if (job?.deliveryOwner?.instanceId !== this.#instanceId || job.snapshot.delivery?.state !== "sending") {
          throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "配送の実行元または状態が一致しません。");
        }
        next.set(slug, { ...job, deliveryOwner: undefined,
          snapshot: { ...job.snapshot, updatedAt: new Date().toISOString(),
            delivery: { ...job.snapshot.delivery, state, error } } });
        await this.#persist(next);
        this.#jobs = next;
      });
    });
  }

  diagnostics(): ConsultJobStoreDiagnostics {
    this.#assertInitialized();
    this.#refreshJobsForRead();
    const snapshots = [...this.#jobs.values()].map((job) => job.snapshot);
    const activeJobCount = snapshots.filter((snapshot) =>
      snapshot.state !== "succeeded" && snapshot.state !== "failed").length;
    return {
      jobCount: snapshots.length,
      activeJobCount,
      terminalJobCount: snapshots.length - activeJobCount,
    };
  }

  async #persist(jobs: ReadonlyMap<string, StoredJob>): Promise<void> {
    if (!this.#ownsTransactionLock || this.#readTransactionLock()?.instanceId !== this.#instanceId) {
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "transaction lockなしでconsult job台帳を書き換えられません。",
      );
    }
    const payload = JSON.stringify({
      version: 6,
      jobs: [...jobs.values()].sort((left, right) =>
        left.snapshot.slug.localeCompare(right.snapshot.slug, "en")),
    });
    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // 旧版へ戻すため、最初の形式移行前の台帳をそのまま残す。
      let previous: string | undefined;
      try { previous = await readFile(this.#statePath, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const previousVersion = previous === undefined ? null : JSON.parse(previous).version;
      if (previous !== undefined && [1, 2, 3, 4, 5].includes(previousVersion)) {
        try { await writeFile(`${this.#statePath}.v${previousVersion}-backup`, previous, { mode: 0o600, flag: "wx" }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.#statePath);
      await chmodPrivateIfPosix(this.#statePath);
    } catch {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        throw new ConnectorError(
          "JOB_RECOVERY_UNAVAILABLE",
          "consult job台帳のatomic writeと一時file cleanupに失敗しました。",
        );
      }
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "consult job台帳をatomic writeできませんでした。",
      );
    }
  }

  #assertInitialized(): void {
    this.#assertOpen();
    if (!this.#initialized) {
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "consult job storeがinitializeされていません。",
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "consult job storeはclose済みです。");
    }
  }

  #assertWritable(): void {
    if (this.#readOnly) {
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "read-only consult job storeから台帳を書き換えられません。",
      );
    }
  }

  async #prepareStateDirectory(): Promise<void> {
    try {
      if (this.#readOnly) {
        try {
          await stat(this.#stateDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
      } else {
        await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
      }
      if (posixModeExposesOthers((await stat(this.#stateDirectory)).mode)) {
        throw new Error("state_directory_permissions");
      }
    } catch {
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "consult job state directoryを準備できませんでした。",
      );
    }
  }

  async #readJobs(): Promise<Map<string, StoredJob>> {
    let source: string;
    try {
      source = await readFile(this.#statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "consult job台帳を読み取れませんでした。",
      );
    }
    return parsePersistedJobs(source);
  }

  #readJobsSync(): Map<string, StoredJob> {
    let source: string;
    try {
      source = readFileSync(this.#statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "consult job台帳を読み取れませんでした。",
      );
    }
    return parsePersistedJobs(source);
  }

  #refreshJobsForRead(): void {
    const persisted = this.#readJobsSync();
    const recovered = this.#recoverNonTerminal(persisted).jobs;
    if (this.#readOnly) {
      for (const [slug, original] of persisted) {
        const job = recovered.get(slug)!;
        if (job === original) {
          this.#readOnlyRecoveries.delete(slug);
          continue;
        }
        const source = JSON.stringify(original);
        const cached = this.#readOnlyRecoveries.get(slug);
        if (cached?.source === source) recovered.set(slug, cached.job);
        else this.#readOnlyRecoveries.set(slug, { source, job });
      }
      for (const slug of this.#readOnlyRecoveries.keys()) {
        if (!persisted.has(slug)) this.#readOnlyRecoveries.delete(slug);
      }
    }
    this.#jobs = recovered;
  }

  async #loadCurrent(): Promise<Map<string, StoredJob>> {
    const recovered = this.#recoverNonTerminal(await this.#readJobs());
    if (recovered.changed) await this.#persist(recovered.jobs);
    this.#jobs = recovered.jobs;
    return recovered.jobs;
  }

  async #pruneDeadOwnerLeases(): Promise<void> {
    const entries = await readdir(this.#stateDirectory);
    for (const name of entries) {
      if (!/^consult-owner-[0-9a-f-]{36}\.json$/u.test(name)) continue;
      const path = join(this.#stateDirectory, name);
      let owner: z.output<typeof ownerSchema>;
      try {
        owner = ownerSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch {
        throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "job実行元の記録が破損しています。");
      }
      if (name !== `consult-owner-${owner.instanceId}.json`) {
        throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "job実行元の記録名が一致しません。");
      }
      if (!this.#processLive(owner.pid)) await rm(path);
    }
  }

  #recoverNonTerminal(jobs: ReadonlyMap<string, StoredJob>): { jobs: Map<string, StoredJob>; changed: boolean } {
    const recovered = new Map<string, StoredJob>();
    let changed = false;
    const legacyWriterLive = this.#hasLiveLegacyWriter();
    for (const [slug, original] of jobs) {
      let job = original;
      if (job.snapshot.delivery?.state === "sending" &&
          !(job.deliveryOwner ? this.#ownerLive(job.deliveryOwner) : legacyWriterLive)) {
        job = { ...job, deliveryOwner: undefined, snapshot: {
          ...job.snapshot, updatedAt: new Date().toISOString(), delivery: { ...job.snapshot.delivery,
            state: "unknown", error: "PARENT_DELIVERY_UNKNOWN" },
        } };
        changed = true;
      }
      if (job.snapshot.state !== "succeeded" && job.snapshot.state !== "failed" &&
          !(job.owner ? this.#ownerLive(job.owner) : legacyWriterLive)) {
        job = { ...job, owner: undefined, snapshot: {
          ...job.snapshot,
          state: "failed",
          updatedAt: new Date().toISOString(),
          result: null,
          error: {
            code: "JOB_RECOVERY_UNAVAILABLE",
            message: "process再起動前のconsult完了有無を安全に確定できないため再送しません。",
            retry: "status_first",
          },
        } };
        changed = true;
      }
      recovered.set(slug, job);
    }
    return { jobs: recovered, changed };
  }

  #ownerLive(owner: z.output<typeof ownerSchema>): boolean {
    let raw: string;
    try {
      raw = readFileSync(join(this.#stateDirectory, `consult-owner-${owner.instanceId}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "job実行元の記録を読めませんでした。");
    }
    let lease: z.output<typeof ownerSchema>;
    try {
      lease = ownerSchema.parse(JSON.parse(raw));
    } catch {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "job実行元の記録が破損しています。");
    }
    if (lease.pid !== owner.pid || lease.instanceId !== owner.instanceId) return false;
    return this.#processLive(owner.pid);
  }

  #processLive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  #hasLiveLegacyWriter(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.#legacyLockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "旧writer lockを読めませんでした。");
    }
    let lock: z.output<typeof writerLockSchema>;
    try {
      lock = writerLockSchema.parse(JSON.parse(raw));
    } catch {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "旧writer lockが破損しています。");
    }
    return this.#processLive(lock.pid);
  }

  async #withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquireTransactionLock();
    try {
      if (this.#hasLiveLegacyWriter()) {
        throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "旧版のconsult job writerがまだ実行中です。");
      }
      return await operation();
    } finally {
      this.#releaseTransactionLock();
    }
  }

  async #acquireTransactionLock(): Promise<void> {
    const payload = JSON.stringify({ version: 1, ...this.#owner });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await writeFile(this.#transactionLockPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
        this.#ownsTransactionLock = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "transaction lockを作成できませんでした。");
        }
        const lock = this.#readTransactionLock(true);
        if (lock && !this.#ownerLive(lock)) {
          try { await rm(this.#transactionLockPath); } catch (removeError) {
            if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "stale transaction lockを除去できませんでした。");
            }
          }
        } else {
          await delay(25);
        }
      }
    }
    throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "transaction lockの待機がtimeoutしました。");
  }

  #readTransactionLock(tolerateIncomplete = false): z.output<typeof writerLockSchema> | null {
    let raw: string;
    try {
      raw = readFileSync(this.#transactionLockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "transaction lockを読めませんでした。");
    }
    try {
      return writerLockSchema.parse(JSON.parse(raw));
    } catch {
      if (tolerateIncomplete) return null;
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "transaction lockが破損しています。");
    }
  }

  #releaseTransactionLock(): void {
    if (!this.#ownsTransactionLock) return;
    const lock = this.#readTransactionLock();
    if (lock?.instanceId !== this.#instanceId) {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "transaction lockの所有者が一致しません。");
    }
    try {
      rmSync(this.#transactionLockPath);
      this.#ownsTransactionLock = false;
    } catch {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "transaction lockを解放できませんでした。");
    }
  }

  #releaseOwnerLease(): void {
    if (!this.#ownsOwnerLease) return;
    try {
      rmSync(this.#ownerPath);
      this.#ownsOwnerLease = false;
    } catch {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "job実行元の記録を解放できませんでした。");
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#exclusiveTail;
    let release!: () => void;
    this.#exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function parsePersistedJobs(source: string): Map<string, StoredJob> {
  let parsed: z.output<typeof persistedSchema>;
  try {
    parsed = persistedSchema.parse(JSON.parse(source));
  } catch {
    throw new ConnectorError(
      "JOB_RECOVERY_UNAVAILABLE",
      "consult job台帳が破損しているため自動回復しません。",
    );
  }
  const loaded = new Map<string, StoredJob>();
  for (const job of parsed.jobs) {
      if ((job.parent !== undefined) !== (job.snapshot.delivery !== undefined)) {
        throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "配送記録と宛先の対応が不正です。");
      }
      if (loaded.has(job.snapshot.slug)) {
        throw new ConnectorError(
          "JOB_RECOVERY_UNAVAILABLE",
          "consult job台帳に重複slugがあります。",
        );
      }
      loaded.set(job.snapshot.slug, job);
  }
  return loaded;
}
