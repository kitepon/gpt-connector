import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  consultSlugSchema,
  type ConsultJobState,
  type ConsultSnapshot,
} from "./contract.js";
import { ConnectorError, connectorErrorCodes } from "./errors.js";
import { chmodPrivateIfPosix, defaultConsultStateDirectory, posixModeExposesOthers } from "./platform/state.js";

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
  state: z.enum(["queued", "uploading", "submitted", "running", "succeeded", "failed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  result: successResultSchema.nullable(),
  error: failureSchema.nullable(),
}).strict();

const persistedSchema = z.object({
  version: z.literal(1),
  jobs: z.array(z.object({
    fingerprint: z.string().min(1),
    snapshot: snapshotSchema,
  }).strict()),
}).strict();

const writerLockSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
}).strict();

interface StoredJob {
  readonly fingerprint: string;
  readonly snapshot: ConsultSnapshot;
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
  readonly #lockPath: string;
  readonly #readOnly: boolean;
  readonly #instanceId = randomUUID();
  #jobs = new Map<string, StoredJob>();
  #initialized = false;
  #closed = false;
  #ownsWriterLock = false;
  #readOnlyRecovered = false;
  #exclusiveTail: Promise<void> = Promise.resolve();

  constructor(options: ConsultJobStoreOptions = {}) {
    this.#stateDirectory = options.stateDirectory ?? defaultConsultStateDirectory();
    this.#statePath = join(this.#stateDirectory, "consult-jobs.json");
    this.#lockPath = join(this.#stateDirectory, "consult-jobs.lock");
    this.#readOnly = options.readOnly ?? false;
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#initialized) return;
      this.#assertOpen();
      await this.#prepareStateDirectory();
      const loaded = await this.#readJobs();
      const hasNonTerminal = [...loaded.values()].some((job) =>
        job.snapshot.state !== "succeeded" && job.snapshot.state !== "failed");
      const writerActive = hasNonTerminal && await this.#hasLiveWriter();
      if (hasNonTerminal && !writerActive) {
        const recovered = this.#recoverNonTerminal(loaded);
        if (this.#readOnly) {
          this.#jobs = recovered;
          this.#readOnlyRecovered = true;
        } else {
          await this.#acquireWriterLock();
          try {
            const current = this.#recoverNonTerminal(await this.#readJobs());
            await this.#persist(current);
            this.#jobs = current;
          } finally {
            this.#releaseWriterLock();
          }
        }
      } else {
        this.#jobs = loaded;
      }
      this.#initialized = true;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#releaseWriterLock();
    this.#closed = true;
  }

  async reserve(slug: string, fingerprint: string): Promise<ReserveResult> {
    return this.#exclusive(async () => {
      this.#assertInitialized();
      this.#assertWritable();
      if (!consultSlugSchema.safeParse(slug).success || fingerprint.length === 0) {
        throw new ConnectorError("INVALID_INPUT", "consult job keyが不正です。");
      }
      if (!this.#ownsWriterLock) this.#jobs = await this.#readJobs();
      let existing = this.#jobs.get(slug);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new ConnectorError(
            "JOB_CONFLICT",
            "同じslugへ異なるconsult inputは送信できません。",
          );
        }
        return { created: false, snapshot: structuredClone(existing.snapshot) };
      }

      const alreadyOwnedWriterLock = this.#ownsWriterLock;
      await this.#acquireWriterLock();
      try {
        const current = alreadyOwnedWriterLock
          ? new Map(this.#jobs)
          : this.#recoverNonTerminal(await this.#readJobs());
        this.#jobs = current;
        existing = this.#jobs.get(slug);
        if (existing !== undefined) {
          this.#releaseWriterLock();
          if (existing.fingerprint !== fingerprint) {
            throw new ConnectorError(
              "JOB_CONFLICT",
              "同じslugへ異なるconsult inputは送信できません。",
            );
          }
          return { created: false, snapshot: structuredClone(existing.snapshot) };
        }

        const now = new Date().toISOString();
        const job: StoredJob = {
          fingerprint,
          snapshot: {
            slug,
            state: "queued",
            createdAt: now,
            updatedAt: now,
            result: null,
            error: null,
          },
        };
        const next = new Map(this.#jobs);
        next.set(slug, job);
        await this.#persist(next);
        this.#jobs = next;
        return { created: true, snapshot: structuredClone(job.snapshot) };
      } catch (error) {
        if (this.#ownsWriterLock) this.#releaseWriterLock();
        throw error;
      }
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
      if (!this.#ownsWriterLock) {
        throw new ConnectorError(
          "JOB_RECOVERY_UNAVAILABLE",
          "このprocessはconsult jobのwriter leaseを所有していません。",
        );
      }
      const current = this.#jobs.get(slug);
      if (current === undefined) {
        throw new ConnectorError("JOB_NOT_FOUND", "指定slugのconsult jobは存在しません。");
      }
      if (!allowedTransitions.get(current.snapshot.state)?.includes(state)) {
        throw new ConnectorError("RUNTIME_DRIFT", "consult job state transitionが不正です。");
      }
      const candidate = snapshotSchema.safeParse({
        ...current.snapshot,
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
      const next = new Map(this.#jobs);
      next.set(slug, {
        fingerprint: current.fingerprint,
        snapshot: candidate.data,
      });
      await this.#persist(next);
      this.#jobs = next;
      const hasNonTerminal = [...next.values()].some((job) =>
        job.snapshot.state !== "succeeded" && job.snapshot.state !== "failed");
      if ((state === "succeeded" || state === "failed") && !hasNonTerminal) {
        this.#releaseWriterLock();
      }
      return structuredClone(candidate.data);
    });
  }

  get(slug: string): ConsultSnapshot {
    this.#assertInitialized();
    this.#refreshJobsForRead();
    const job = this.#jobs.get(slug);
    if (job === undefined) {
      throw new ConnectorError("JOB_NOT_FOUND", "指定slugのconsult jobは存在しません。");
    }
    return structuredClone(job.snapshot);
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
    if (!this.#ownsWriterLock) {
      throw new ConnectorError(
        "JOB_RECOVERY_UNAVAILABLE",
        "writer leaseなしでconsult job台帳を書き換えられません。",
      );
    }
    const payload = JSON.stringify({
      version: 1,
      jobs: [...jobs.values()].sort((left, right) =>
        left.snapshot.slug.localeCompare(right.snapshot.slug, "en")),
    });
    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
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
    // dead writerをread-only初期化で回収したsnapshotは、このprocess内の正規回答。
    // raw台帳を再読込するとrunningへ巻き戻るため、sessions完了まで固定する。
    if (this.#ownsWriterLock || this.#readOnlyRecovered) return;
    this.#jobs = this.#readJobsSync();
  }

  #recoverNonTerminal(jobs: ReadonlyMap<string, StoredJob>): Map<string, StoredJob> {
    const recovered = new Map<string, StoredJob>();
    for (const [slug, job] of jobs) {
      if (job.snapshot.state === "succeeded" || job.snapshot.state === "failed") {
        recovered.set(slug, job);
        continue;
      }
      recovered.set(slug, {
        fingerprint: job.fingerprint,
        snapshot: {
          ...job.snapshot,
          state: "failed",
          updatedAt: new Date().toISOString(),
          result: null,
          error: {
            code: "JOB_RECOVERY_UNAVAILABLE",
            message: "process再起動前のconsult完了有無を安全に確定できないため再送しません。",
            retry: "status_first",
          },
        },
      });
    }
    return recovered;
  }

  async #hasLiveWriter(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.#lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "writer lockを読めませんでした。");
    }
    let lock: z.output<typeof writerLockSchema>;
    try {
      lock = writerLockSchema.parse(JSON.parse(raw));
    } catch {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "writer lockが破損しています。");
    }
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  async #acquireWriterLock(): Promise<void> {
    if (this.#ownsWriterLock) return;
    this.#assertWritable();
    const payload = JSON.stringify({ version: 1, pid: process.pid, instanceId: this.#instanceId });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.#lockPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
        this.#ownsWriterLock = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "writer lockを作成できませんでした。");
        }
        if (await this.#hasLiveWriter()) {
          throw new ConnectorError(
            "JOB_RECOVERY_UNAVAILABLE",
            "別processがconsult jobのwriter leaseを保持しています。",
          );
        }
        try {
          await rm(this.#lockPath);
        } catch {
          throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "stale writer lockを除去できませんでした。");
        }
      }
    }
    throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "writer lockを取得できませんでした。");
  }

  #releaseWriterLock(): void {
    if (!this.#ownsWriterLock) return;
    try {
      const lock = writerLockSchema.parse(JSON.parse(readFileSync(this.#lockPath, "utf8")));
      if (lock.instanceId !== this.#instanceId) {
        throw new Error("writer_lock_owner_mismatch");
      }
      rmSync(this.#lockPath);
      this.#ownsWriterLock = false;
    } catch {
      throw new ConnectorError("JOB_RECOVERY_UNAVAILABLE", "writer lockを安全に解放できませんでした。");
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
