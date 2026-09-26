import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  attachmentLimits,
  prepareAttachmentFiles,
  type PreparedAttachmentFile,
} from "./attachment-files.js";
import { CdpClient, discoverChatGptTarget } from "./cdp.js";
import {
  chatInputSchema,
  closeInputSchema,
  consultInputSchema,
  imageInputSchema,
  sessionsInputSchema,
  type ChatInput,
  type ChatResult,
  type CloseInput,
  type CloseResult,
  type ConnectorDiagnostics,
  type ConsultDryRunResult,
  type ConsultInput,
  type ConsultSnapshot,
  type ImageInput,
  type ImageSnapshot,
  type ModelCatalog,
  type SessionsInput,
} from "./contract.js";
import {
  prepareGeneratedImageOutput,
  writeGeneratedImageFiles,
  type GeneratedImageBytes,
} from "./generated-image-files.js";
import { ConsultJobStore } from "./consult-job-store.js";
import { verifyCodexParent, deliverCodexAnswer } from "./codex-parent.js";
import {
  verifyCursorParent,
  deliverCursorAnswer,
} from "./cursor-parent.js";
import { deliverPendingConsultJobs } from "./consult-delivery.js";
import type { DeliveryParent } from "./consult-job-store.js";
import {
  ConnectorError,
  connectorErrorCodes,
  type ConnectorErrorCode,
} from "./errors.js";
import {
  withLatestLevels, resolveChatSelection, validateModelSelection, type ChatSelection,
} from "./model-catalog.js";
import {
  bridgeBuildId,
  createBridgeBootstrapExpression,
  createBridgeCallExpression,
} from "./page-bridge.js";
import { evaluateByValue } from "./runtime-evaluate.js";
import { SessionRegistry } from "./session-registry.js";
import { packageVersion } from "./version.js";

const operationStartSchema = z.object({
  operationId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
});
type OperationStart = z.output<typeof operationStartSchema>;

const operationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const operationEnvelopeSchema = z.object({
  state: z.enum(["pending", "succeeded", "failed"]),
  result: z.unknown().nullable().optional(),
  error: operationErrorSchema.nullable().optional(),
});

const modelCatalogSchema = z.object({
  defaultModel: z.string().nullable(),
  versions: z.array(z.unknown()),
  models: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      reasoningType: z.string().nullable(),
      efforts: z.array(z.string()),
      configurableEffort: z.boolean(),
      maxTokens: z.number().nullable(),
    }),
  ),
});

const chatResultSchema = z.object({
  text: z.string().min(1),
  status: z.string(),
  endTurn: z.literal(true),
  resolvedModel: z.string().nullable(),
  resolvedEffort: z.string().nullable(),
  sessionId: z.string().uuid().optional(),
});

const attachmentSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  names: z.array(z.string()),
  mimeTypes: z.array(z.string().nullable()),
  readBack: z.literal("confirmed"),
  retention: z.literal("unknown"),
  cleanup: z.enum(["not_supported", "failed", "deleted"]),
});

const bridgeChatResultSchema = chatResultSchema.extend({
  attachments: attachmentSummarySchema,
});

type BridgeChatResult = z.output<typeof bridgeChatResultSchema>;

const bridgeGeneratedImageSchema = z.object({
  downloadHandle: z.string().uuid(),
  mimeType: z.string().startsWith("image/"),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

const bridgeImageResultSchema = z.object({
  text: z.string(),
  status: z.string(),
  endTurn: z.literal(true),
  resolvedModel: z.string().nullable(),
  resolvedEffort: z.string().nullable(),
  attachments: attachmentSummarySchema,
  images: z.array(bridgeGeneratedImageSchema).min(1),
});

type BridgeImageResult = z.output<typeof bridgeImageResultSchema>;

interface RetrievedGeneratedImage extends GeneratedImageBytes {
  readonly downloadHandle: string;
}

export function imageResolutionMatches(
  requestedModel: string,
  requestedEffort: string | undefined,
  resolvedModel: string | null,
  resolvedEffort: string | null,
): boolean {
  return resolvedModel === requestedModel
    && (requestedEffort === undefined || resolvedEffort === requestedEffort);
}

// 画像生成は通常Chatより長くかかり、実測で180秒直後にdownloadが揃うことがある。
// callerの短いoperationTimeoutMsでも、画像だけは生成済み結果を捨てない待機幅を確保する。
export const imageOperationTimeoutMs = 360_000;

const uploadHandleSchema = z.object({ uploadHandle: z.string().uuid() });
const uploadChunkResultSchema = z.object({ receivedBytes: z.number().int().nonnegative() });
const uploadResultSchema = z.object({
  uploadHandle: z.string().uuid(),
  name: z.string(),
  size: z.number().int().positive(),
  mimeType: z.string(),
});

const uploadChunkBytes = 256 * 1024;
const downloadChunkBytes = 256 * 1024;

const downloadChunkSchema = z.object({
  base64Chunk: z.string().min(1),
  offset: z.number().int().nonnegative(),
  bytes: z.number().int().positive(),
  totalBytes: z.number().int().positive(),
});
const discardDownloadSchema = z.object({ discarded: z.literal(true) });
const softDeleteDownloadSchema = z.object({ softDeleted: z.literal(true) });

const closeResultSchema = z.object({ archived: z.literal(true) });

const pageDiagnosticsSchema = z.object({
  sessionCount: z.number().int().nonnegative(),
  operationCount: z.number().int().nonnegative(),
  uploadCount: z.number().int().nonnegative(),
  bufferedUploadBytes: z.number().int().nonnegative(),
  downloadCount: z.number().int().nonnegative(),
  bufferedDownloadBytes: z.number().int().nonnegative(),
});

export interface ConnectorOptions {
  readonly endpoint?: string;
  /** 有界なread-only readiness probeだけが差し替える内部transport。 */
  readonly fetch?: typeof globalThis.fetch;
  /** CDP handshake/callのtimeout。省略時は通常connectorの既定値を維持する。 */
  readonly cdpTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly stateDirectory?: string;
  /** Read-only diagnostics may inspect an existing job store but must never create or recover it. */
  readonly readOnlyJobs?: boolean;
  /** MCPが取得した親への配送。試験では外部受付だけ差し替える。CodexとCursorで分岐し、互いに影響しない。 */
  readonly parentDelivery?: {
    verify(parent: DeliveryParent): Promise<void>;
    submit(parent: DeliveryParent, id: string, text: string, outcome: "succeeded" | "failed"): Promise<void>;
  };
}

interface AuthProbe {
  readonly status: number;
  readonly authenticated: boolean;
  readonly officialOrigin: boolean;
}

export class GptConnector {
  readonly #client: CdpClient;
  readonly #sessions = new SessionRegistry();
  readonly #jobs: ConsultJobStore;
  readonly #consultTasks = new Map<string, Promise<ConsultSnapshot>>();
  readonly #operationTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #parentPollIntervalMs: number;
  readonly #parentDelivery: NonNullable<ConnectorOptions["parentDelivery"]>;
  #deliveryTask: Promise<void> | null = null;
  #transportFailed = false;

  get transportFailed(): boolean {
    return this.#transportFailed;
  }

  private constructor(client: CdpClient, options: ConnectorOptions) {
    this.#client = client;
    this.#jobs = new ConsultJobStore({ stateDirectory: options.stateDirectory, readOnly: options.readOnlyJobs });
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 180_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#parentPollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.#parentDelivery = options.parentDelivery ?? {
      async verify(parent) {
        if ("socketRoot" in parent) return verifyCursorParent(parent);
        return verifyCodexParent(parent);
      },
      async submit(parent, id, text, outcome) {
        if ("socketRoot" in parent) return deliverCursorAnswer(parent, id, text, { outcome });
        return deliverCodexAnswer(parent, id, text);
      },
    };
  }

  static async connect(options: ConnectorOptions = {}): Promise<GptConnector> {
    const endpoint = options.endpoint ?? "http://127.0.0.1:9223";
    const target = await discoverChatGptTarget(endpoint, options.fetch);
    const client = await CdpClient.connect(target.webSocketDebuggerUrl, options.cdpTimeoutMs);
    const connector = new GptConnector(client, options);

    try {
      await client.call("Runtime.enable");
      await connector.#jobs.initialize();
      await connector.#bootstrap();
      if (!options.readOnlyJobs) await connector.#flushDeliveries();
      return connector;
    } catch (error) {
      try {
        connector.#jobs.close();
      } finally {
        client.close();
      }
      throw error;
    }
  }

  static async doctor(options: ConnectorOptions = {}): Promise<ConnectorDiagnostics> {
    let connector: GptConnector | null = null;
    try {
      connector = await GptConnector.connect(options);
      return await connector.diagnostics();
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : null;
      return {
        schema: "gpt-connector.diagnostics.v1",
        packageVersion,
        overall: "not_ready",
        reasonCode: diagnosticReason(code),
        cdpConnected: false,
        officialOrigin: null,
        authenticated: code === "AUTH_REQUIRED" ? false : null,
        bridgeBuildId,
        sessionCount: null,
        operationCount: null,
        uploadCount: null,
        bufferedUploadBytes: null,
        downloadCount: null,
        bufferedDownloadBytes: null,
        jobCount: null,
        activeJobCount: null,
        terminalJobCount: null,
      };
    } finally {
      connector?.close();
    }
  }

  async models(): Promise<ModelCatalog> {
    const result = await this.#runOperation("startModels", []);
    const parsed = modelCatalogSchema.safeParse(result);
    if (!parsed.success) {
      throw new ConnectorError("RUNTIME_DRIFT", "通常Chatのモデル一覧の形式が変わりました。");
    }
    return withLatestLevels(parsed.data.models, parsed.data.versions);
  }

  async diagnostics(): Promise<ConnectorDiagnostics> {
    const page = pageDiagnosticsSchema.parse(
      await evaluateByValue<unknown>(
        this.#client,
        createBridgeCallExpression("diagnostics", []),
        false,
      ),
    );
    const jobs = this.#jobs.diagnostics();
    return {
      schema: "gpt-connector.diagnostics.v1",
      packageVersion,
      overall: "ready",
      reasonCode: "ready",
      cdpConnected: true,
      officialOrigin: true,
      authenticated: true,
      bridgeBuildId,
      ...page,
      ...jobs,
    };
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const parsed = chatInputSchema.parse(input);
    const result = await this.#chatParsed(parsed, []);
    return chatResultSchema.parse(result);
  }

  async consult(input: ConsultInput, parent?: DeliveryParent): Promise<ConsultSnapshot | ConsultDryRunResult> {
    let parsed: z.output<typeof consultInputSchema>;
    try {
      parsed = consultInputSchema.parse(input);
    } catch {
      throw new ConnectorError("INVALID_INPUT", "consult inputが公開schemaに一致しません。");
    }
    if (parent && !parsed.dryRun) {
      await this.#parentDelivery.verify(parent);
      parsed.wait = false;
    }

    const prepared = parsed.files === undefined
      ? { files: [] as readonly PreparedAttachmentFile[], totalBytes: 0 }
      : await prepareAttachmentFiles({
        workspaceRoot: parsed.workspaceRoot!,
        specs: parsed.files,
      });
    const fileMetadata = prepared.files.map((file) => ({
      relativePath: file.relativePath,
      name: file.name,
      bytes: file.bytes,
      mimeType: file.mimeType,
      sha256: file.sha256,
    }));

    if (parsed.dryRun) {
      const selection = resolveChatSelection(await this.models(), parsed);
      for (const file of prepared.files) file.content.fill(0);
      return {
        dryRun: true,
        slug: parsed.slug,
        files: fileMetadata,
        totalBytes: prepared.totalBytes,
        requestedModel: selection.model,
        requestedEffort: selection.effort ?? null,
        limits: attachmentLimits,
        uploadWouldRun: false,
        conversationWouldRun: false,
      };
    }

    const fingerprint = consultFingerprint({
      prompt: parsed.prompt,
      level: parsed.level,
      files: fileMetadata,
      model: parsed.model ?? null,
      effort: parsed.effort ?? null,
      keepOpen: parsed.keepOpen,
      sessionId: parsed.sessionId,
      parentThreadId: parent && "threadId" in parent ? parent.threadId : undefined,
    });
    let reservation;
    try {
      reservation = await this.#jobs.reserve(parsed.slug, fingerprint, parent);
    } catch (error) {
      for (const file of prepared.files) file.content.fill(0);
      throw error;
    }
    if (!reservation.created) {
      for (const file of prepared.files) file.content.fill(0);
      return parsed.wait ? this.#consultTasks.get(parsed.slug) ?? reservation.snapshot : reservation.snapshot;
    }
    let accept!: (snapshot: ConsultSnapshot) => void;
    const accepted = new Promise<ConsultSnapshot>((resolve) => { accept = resolve; });
    const task = this.#runConsultJob(parsed, prepared.files, accept, parent !== undefined).then(async snapshot => {
      await this.#flushDeliveries();
      return this.#jobs.get(snapshot.slug);
    });
    this.#consultTasks.set(parsed.slug, task);
    void task.then(
      () => { this.#consultTasks.delete(parsed.slug); },
      () => {
        this.#consultTasks.delete(parsed.slug);
        // 台帳への記録自体が失敗した場合は、バックグラウンド処理でも無音にしない。
        process.stderr.write("gpt-connector: JOB_RECOVERY_UNAVAILABLE（相談結果を保存できませんでした）\n");
      },
    );
    return parsed.wait ? task : Promise.race([accepted, task]);
  }

  async image(input: ImageInput): Promise<ImageSnapshot> {
    let parsed: z.output<typeof imageInputSchema>;
    try {
      parsed = imageInputSchema.parse(input);
    } catch {
      throw new ConnectorError("INVALID_INPUT", "image inputが公開schemaに一致しません。");
    }

    const catalog = await this.models();
    validateModelSelection(catalog, parsed.model, parsed.effort);
    const fingerprint = imageFingerprint({
      prompt: parsed.prompt,
      workspaceRoot: parsed.workspaceRoot,
      output: parsed.output,
      model: parsed.model,
      effort: parsed.effort ?? null,
    });
    const reservation = await this.#jobs.reserve(parsed.slug, fingerprint);
    if (!reservation.created) return reservation.snapshot;
    return this.#runImageJob(parsed);
  }

  sessions(input: SessionsInput): ConsultSnapshot {
    let parsed: z.output<typeof sessionsInputSchema>;
    try {
      parsed = sessionsInputSchema.parse(input);
    } catch {
      throw new ConnectorError("INVALID_INPUT", "sessions inputが公開schemaに一致しません。");
    }
    return this.#jobs.get(parsed.slug);
  }

  async #runConsultJob(
    parsed: z.output<typeof consultInputSchema>,
    files: readonly PreparedAttachmentFile[],
    accepted: (snapshot: ConsultSnapshot) => void,
    autoDeliver: boolean,
  ): Promise<ConsultSnapshot> {
    let uploadHandles: readonly string[] = [];
    try {
      const selection = resolveChatSelection(await this.models(), parsed);
      await this.#jobs.transition(parsed.slug, "uploading");
      uploadHandles = await this.#uploadAttachments(files);
      await this.#jobs.transition(parsed.slug, "submitted");
      const result = await this.#chatParsed(
        {
          prompt: parsed.prompt,
          model: parsed.model,
          effort: parsed.effort,
          sessionId: parsed.sessionId,
          keepOpen: parsed.keepOpen,
        },
        uploadHandles,
        selection,
        async (started) => {
          const snapshot = await this.#jobs.transition(parsed.slug, "running", {
            ...(parsed.keepOpen && started.sessionId !== undefined ? { sessionId: started.sessionId } : {}),
          });
          accepted(snapshot);
        },
        autoDeliver ? this.#parentPollIntervalMs : this.#pollIntervalMs,
      );
      return this.#jobs.transition(parsed.slug, "succeeded", {
        result: {
          text: result.text,
          status: result.status,
          endTurn: true,
          resolvedModel: result.resolvedModel,
          resolvedEffort: result.resolvedEffort,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
          attachments: result.attachments,
          archived: parsed.keepOpen !== true,
        },
        error: null,
      });
    } catch (error) {
      let jobError = error;
      if (error instanceof ConnectorError && error.code === "CDP_UNAVAILABLE") this.#transportFailed = true;
      let cleanup: "not_supported" | "failed" = "not_supported";
      for (const uploadHandle of uploadHandles) {
        try {
          await this.#discardUpload(uploadHandle);
        } catch {
          // job errorをcleanup failureへ昇格し、成功や元errorの握り潰しを防ぐ。
          jobError = new ConnectorError(
            "UPLOAD_FAILED",
            "consult失敗後にpage側upload handleを完全破棄できませんでした。",
          );
          cleanup = "failed";
          break;
        }
      }
      const connectorError = jobError instanceof ConnectorError
        ? jobError
        : new ConnectorError("CHAT_FAILED", "consult jobが失敗しました。");
      const partialCount = typeof connectorError.details?.uploadedCount === "number"
        ? connectorError.details.uploadedCount
        : uploadHandles.length;
      const partialCleanup = connectorError.details?.cleanup === "failed"
        ? "failed"
        : cleanup;
      return this.#jobs.transition(parsed.slug, "failed", {
        result: null,
        error: {
          code: connectorError.code,
          message: connectorError.message,
          retry: retryFor(connectorError.code),
          ...(partialCount > 0 ? {
            partialUpload: { count: partialCount, cleanup: partialCleanup },
          } : {}),
        },
      });
    } finally {
      for (const file of files) file.content.fill(0);
    }
  }

  async #runImageJob(
    parsed: z.output<typeof imageInputSchema>,
  ): Promise<ImageSnapshot> {
    let images: readonly RetrievedGeneratedImage[] = [];
    let downloadsDiscarded = false;
    try {
      await prepareGeneratedImageOutput({
        workspaceRoot: parsed.workspaceRoot,
        output: parsed.output,
      });
      await this.#jobs.transition(parsed.slug, "submitted");
      await this.#jobs.transition(parsed.slug, "running");
      const result = await this.#imageParsed(parsed);
      images = await this.#downloadGeneratedImages(result.images);
      const files = await writeGeneratedImageFiles({
        workspaceRoot: parsed.workspaceRoot,
        output: parsed.output,
        images,
      });
      const cleanup = await this.#softDeleteGeneratedImageSources(images);
      const discardFailureCount = await this.#discardGeneratedImageDownloads(images);
      downloadsDiscarded = discardFailureCount === 0;
      const finalCleanup = discardFailureCount === 0
        ? cleanup
        : {
            retention: cleanup.retention === "recently_deleted" ? "recently_deleted" as const : "mixed" as const,
            cleanup: "failed" as const,
          };
      return this.#jobs.transition(parsed.slug, "succeeded", {
        result: {
          text: result.text,
          status: result.status,
          endTurn: true,
          resolvedModel: result.resolvedModel,
          resolvedEffort: result.resolvedEffort,
          attachments: {
            count: 0,
            names: [],
            mimeTypes: [],
            readBack: "confirmed",
            retention: "unknown",
            cleanup: "not_supported",
          },
          images: {
            count: files.length,
            files,
            readBack: "confirmed",
            ...finalCleanup,
          },
          archived: true,
        },
        error: null,
      });
    } catch (error) {
      const discardFailureCount = downloadsDiscarded
        ? 0
        : await this.#discardGeneratedImageDownloads(images);
      const connectorError = discardFailureCount > 0
        ? new ConnectorError(
            "IMAGE_CLEANUP_FAILED",
            "image job失敗後にpage側bufferを完全破棄できませんでした。",
            { discardFailureCount },
          )
        : error instanceof ConnectorError
        ? error
        : new ConnectorError("CHAT_FAILED", "image jobが失敗しました。");
      return this.#jobs.transition(parsed.slug, "failed", {
        result: null,
        error: {
          code: connectorError.code,
          message: connectorError.message,
          retry: retryFor(connectorError.code),
        },
      });
    } finally {
      for (const image of images) image.content.fill(0);
    }
  }

  async #imageParsed(
    parsed: z.output<typeof imageInputSchema>,
  ): Promise<BridgeImageResult> {
    const raw = await this.#runOperation("startChat", [{
      prompt: imageGenerationPrompt(parsed.prompt),
      model: parsed.model,
      effort: parsed.effort,
      keepOpen: false,
      attachmentHandles: [],
      imageMode: true,
    }], Math.max(this.#operationTimeoutMs, imageOperationTimeoutMs));
    const result = bridgeImageResultSchema.safeParse(raw);
    if (result.success) {
      if (imageResolutionMatches(
        parsed.model,
        parsed.effort,
        result.data.resolvedModel,
        result.data.resolvedEffort,
      )) return result.data;

      let cleanupFailureCount = 0;
      for (const image of result.data.images) {
        try {
          await evaluateByValue<unknown>(
            this.#client,
            createBridgeCallExpression("softDeleteDownloadSource", [image.downloadHandle]),
          );
        } catch {
          cleanupFailureCount += 1;
        }
        try {
          await evaluateByValue<unknown>(
            this.#client,
            createBridgeCallExpression("discardDownload", [image.downloadHandle]),
            false,
          );
        } catch {
          cleanupFailureCount += 1;
        }
      }
      throw new ConnectorError(
        "MODEL_RESOLUTION_MISMATCH",
        `画像生成のresolved modelまたはeffortがrequested selectionと一致しませんでした。 requestedModel=${parsed.model} resolvedModel=${result.data.resolvedModel ?? "null"} requestedEffort=${parsed.effort ?? "null"} resolvedEffort=${result.data.resolvedEffort ?? "null"}`,
        {
          requestedModel: parsed.model,
          resolvedModel: result.data.resolvedModel,
          requestedEffort: parsed.effort ?? null,
          resolvedEffort: result.data.resolvedEffort,
          cleanupFailureCount,
        },
      );
    }

    const handles = z.array(z.object({ downloadHandle: z.string().uuid() }))
      .safeParse((raw as { images?: unknown } | null)?.images);
    let cleanupFailureCount = 0;
    if (handles.success) {
      for (const image of handles.data) {
        try {
          await evaluateByValue<unknown>(
            this.#client,
            createBridgeCallExpression("discardDownload", [image.downloadHandle]),
            false,
          );
        } catch {
          cleanupFailureCount += 1;
        }
      }
    }
    throw new ConnectorError(
      "RUNTIME_DRIFT",
      cleanupFailureCount === 0
        ? "画像生成結果がbridge schemaに一致しませんでした。"
        : "画像生成結果のschema不一致後にpage側bufferを完全破棄できませんでした。",
      { cleanupFailureCount },
    );
  }

  async #downloadGeneratedImages(
    descriptors: BridgeImageResult["images"],
  ): Promise<readonly RetrievedGeneratedImage[]> {
    const results: RetrievedGeneratedImage[] = [];
    try {
      for (const descriptor of descriptors) {
        const chunks: Buffer[] = [];
        try {
          for (let offset = 0; offset < descriptor.bytes; offset += downloadChunkBytes) {
            const length = Math.min(downloadChunkBytes, descriptor.bytes - offset);
            const chunk = downloadChunkSchema.parse(
              await evaluateByValue<unknown>(
                this.#client,
                createBridgeCallExpression("readDownloadChunk", [
                  descriptor.downloadHandle,
                  offset,
                  length,
                ]),
                false,
              ),
            );
            if (
              chunk.offset !== offset ||
              chunk.bytes !== length ||
              chunk.totalBytes !== descriptor.bytes
            ) {
              throw new ConnectorError(
                "IMAGE_DOWNLOAD_FAILED",
                "生成画像のchunk metadataが一致しませんでした。",
              );
            }
            const bytes = Buffer.from(chunk.base64Chunk, "base64");
            if (bytes.byteLength !== length) {
              bytes.fill(0);
              throw new ConnectorError(
                "IMAGE_DOWNLOAD_FAILED",
                "生成画像のchunk byte数が一致しませんでした。",
              );
            }
            chunks.push(bytes);
          }
          const content = Buffer.concat(chunks);
          for (const chunk of chunks) chunk.fill(0);
          if (
            content.byteLength !== descriptor.bytes ||
            createHash("sha256").update(content).digest("hex") !== descriptor.sha256
          ) {
            content.fill(0);
            throw new ConnectorError(
              "IMAGE_DOWNLOAD_FAILED",
              "生成画像のbyte数またはdigestが一致しませんでした。",
            );
          }
          results.push({
            downloadHandle: descriptor.downloadHandle,
            content,
            mimeType: descriptor.mimeType,
            bytes: descriptor.bytes,
            sha256: descriptor.sha256,
            width: descriptor.width,
            height: descriptor.height,
          });
        } catch (error) {
          for (const chunk of chunks) chunk.fill(0);
          throw error;
        }
      }
      return results;
    } catch (error) {
      for (const result of results) result.content.fill(0);
      let cleanupFailureCount = 0;
      for (const descriptor of descriptors) {
        try {
          await evaluateByValue<unknown>(
            this.#client,
            createBridgeCallExpression("discardDownload", [descriptor.downloadHandle]),
            false,
          );
        } catch {
          cleanupFailureCount += 1;
        }
      }
      if (cleanupFailureCount > 0) {
        throw new ConnectorError(
          "IMAGE_DOWNLOAD_FAILED",
          "生成画像の回収失敗後にpage側bufferを完全破棄できませんでした。",
          {
            cleanupFailureCount,
            originalCode: error instanceof ConnectorError ? error.code : "IMAGE_DOWNLOAD_FAILED",
          },
        );
      }
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("IMAGE_DOWNLOAD_FAILED", "生成画像をpageから回収できませんでした。");
    }
  }

  async #softDeleteGeneratedImageSources(
    images: readonly RetrievedGeneratedImage[],
  ): Promise<{
    readonly retention: "library" | "recently_deleted" | "mixed";
    readonly cleanup: "soft_deleted" | "failed" | "partial";
  }> {
    let softDeletedCount = 0;
    for (const image of images) {
      try {
        softDeleteDownloadSchema.parse(
          await evaluateByValue<unknown>(
            this.#client,
            createBridgeCallExpression("softDeleteDownloadSource", [image.downloadHandle]),
          ),
        );
        softDeletedCount += 1;
      } catch {
        // aggregate結果へ明示し、保存済みlocal imageは成功結果として維持する。
      }
    }
    if (softDeletedCount === images.length) {
      return { retention: "recently_deleted", cleanup: "soft_deleted" };
    }
    if (softDeletedCount === 0) {
      return { retention: "library", cleanup: "failed" };
    }
    return { retention: "mixed", cleanup: "partial" };
  }

  async #discardGeneratedImageDownloads(
    images: readonly RetrievedGeneratedImage[],
  ): Promise<number> {
    let failureCount = 0;
    for (const image of images) {
      try {
        discardDownloadSchema.parse(
          await evaluateByValue<unknown>(
            this.#client,
            createBridgeCallExpression("discardDownload", [image.downloadHandle]),
            false,
          ),
        );
      } catch {
        failureCount += 1;
      }
    }
    return failureCount;
  }

  async #chatParsed(
    parsed: z.output<typeof chatInputSchema>,
    attachmentHandles: readonly string[],
    selection?: ChatSelection,
    onStarted?: (started: OperationStart) => Promise<void>,
    pollIntervalMs = this.#pollIntervalMs,
  ): Promise<BridgeChatResult> {
    const selected = selection ?? resolveChatSelection(await this.models(), parsed);

    const existingSession = parsed.sessionId;
    if (existingSession !== undefined) await this.#acquireSession(existingSession);
    let activeSession = existingSession;

    try {
      const raw = await this.#runOperation("startChat", [
        { ...parsed, ...selected, attachmentHandles },
      ], null, async (started) => {
        if (parsed.keepOpen && started.sessionId === undefined) {
          throw new ConnectorError("RUNTIME_DRIFT", "会話を保持する受付結果にsessionIdがありません。");
        }
        if (existingSession === undefined && started.sessionId !== undefined) {
          activeSession = started.sessionId;
          this.#sessions.register(activeSession);
          this.#sessions.acquire(activeSession);
        }
        await onStarted?.(started);
      }, pollIntervalMs);
      const result = bridgeChatResultSchema.parse(raw);

      if (activeSession !== undefined) {
        if (parsed.keepOpen) this.#sessions.release(activeSession);
        else this.#sessions.delete(activeSession);
      } else if (result.sessionId !== undefined) {
        this.#sessions.register(result.sessionId);
      }

      return result;
    } catch (error) {
      if (activeSession !== undefined && this.#sessions.has(activeSession)) {
        if (
          (existingSession !== undefined && parsed.keepOpen) ||
          (error instanceof ConnectorError && error.code === "ARCHIVE_FAILED")
        ) {
          this.#sessions.release(activeSession);
        } else {
          this.#sessions.delete(activeSession);
        }
      }
      throw error;
    }
  }

  async #uploadAttachments(
    files: readonly PreparedAttachmentFile[],
  ): Promise<readonly string[]> {
    const uploadHandles: string[] = [];
    try {
      for (const file of files) {
        uploadHandles.push(await this.#transferAttachment(file));
      }
      return uploadHandles;
    } catch (error) {
      const cleanupFailures: string[] = [];
      for (const uploadHandle of uploadHandles) {
        try {
          await this.#discardUpload(uploadHandle);
        } catch (cleanupError) {
          cleanupFailures.push(
            cleanupError instanceof ConnectorError ? cleanupError.code : "RUNTIME_DRIFT",
          );
        }
      }
      if (cleanupFailures.length > 0) {
        throw new ConnectorError(
          "UPLOAD_FAILED",
          "添付upload失敗後にpage側handleを完全破棄できませんでした。",
          {
            cleanupFailureCount: cleanupFailures.length,
            uploadedCount: uploadHandles.length,
            cleanup: "failed",
            originalCode: error instanceof ConnectorError ? error.code : "UPLOAD_FAILED",
          },
        );
      }
      if (uploadHandles.length > 0) {
        const original = error instanceof ConnectorError
          ? error
          : new ConnectorError("UPLOAD_FAILED", "添付uploadが途中で失敗しました。");
        throw new ConnectorError(original.code, original.message, {
          uploadedCount: uploadHandles.length,
          cleanup: "not_supported",
        });
      }
      throw error;
    } finally {
      for (const file of files) file.content.fill(0);
    }
  }

  async #transferAttachment(file: PreparedAttachmentFile): Promise<string> {
    const created = uploadHandleSchema.parse(
      await evaluateByValue<unknown>(
        this.#client,
        createBridgeCallExpression("createUpload", [{
          name: file.name,
          mimeType: file.mimeType,
          size: file.bytes,
          sha256: file.sha256,
        }]),
        false,
      ),
    );

    try {
      for (let offset = 0; offset < file.content.byteLength; offset += uploadChunkBytes) {
        const length = Math.min(uploadChunkBytes, file.content.byteLength - offset);
        const base64Chunk = Buffer.from(
          file.content.buffer,
          file.content.byteOffset + offset,
          length,
        ).toString("base64");
        const appended = uploadChunkResultSchema.parse(
          await evaluateByValue<unknown>(
            this.#client,
            createBridgeCallExpression("appendUploadChunk", [
              created.uploadHandle,
              base64Chunk,
            ]),
            false,
          ),
        );
        if (appended.receivedBytes !== offset + length) {
          throw new ConnectorError(
            "UPLOAD_FAILED",
            "page側の添付byte受信数が一致しませんでした。",
          );
        }
      }

      const result = uploadResultSchema.parse(
        await this.#runOperation("startUpload", [{
          uploadHandle: created.uploadHandle,
          timeoutMs: Math.min(this.#operationTimeoutMs, 120_000),
        }]),
      );
      if (
        result.uploadHandle !== created.uploadHandle ||
        result.name !== file.name ||
        result.size !== file.bytes
      ) {
        throw new ConnectorError(
          "RUNTIME_DRIFT",
          "upload完了metadataが送信fileと一致しませんでした。",
        );
      }
      return created.uploadHandle;
    } catch (error) {
      await this.#discardUpload(created.uploadHandle);
      throw error;
    }
  }

  async #discardUpload(uploadHandle: string): Promise<void> {
    await evaluateByValue<unknown>(
      this.#client,
      createBridgeCallExpression("discardUpload", [uploadHandle]),
      false,
    );
  }

  async closeSession(input: CloseInput): Promise<CloseResult> {
    const parsed = closeInputSchema.parse(input);
    await this.#acquireSession(parsed.sessionId);

    try {
      const raw = await this.#runOperation("startClose", [parsed]);
      const result = closeResultSchema.parse(raw);
      this.#sessions.delete(parsed.sessionId);
      return result;
    } catch (error) {
      if (this.#sessions.has(parsed.sessionId)) this.#sessions.release(parsed.sessionId);
      throw error;
    }
  }

  close(): void {
    try {
      this.#jobs.close();
    } finally {
      this.#client.close();
    }
  }

  async shutdown(): Promise<void> {
    // keepOpenで保持した会話はMCP再接続後も使う。archiveは明示closeが所有する。
    const results = await Promise.allSettled(this.#consultTasks.values());
    this.close();
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async #acquireSession(sessionId: string): Promise<void> {
    if (!this.#sessions.has(sessionId)) {
      const session = z.object({ sessionId: z.string().uuid(), busy: z.boolean() }).nullable().parse(
        await evaluateByValue<unknown>(this.#client, createBridgeCallExpression("sessionInfo", [sessionId]), false),
      );
      if (session === null) throw new ConnectorError("SESSION_NOT_FOUND", "sessionが見つかりません。専用Chromeのpage再読込・終了・bridge更新後は継続できません。");
      if (session.sessionId !== sessionId) throw new ConnectorError("RUNTIME_DRIFT", "会話IDの照合に失敗しました。");
      if (session.busy) throw new ConnectorError("SESSION_BUSY", "sessionは別turnを処理中です。");
      if (!this.#sessions.has(sessionId)) this.#sessions.register(sessionId);
    }
    this.#sessions.acquire(sessionId);
  }

  async #bootstrap(): Promise<void> {
    const auth = await evaluateByValue<AuthProbe>(
      this.#client,
      String.raw`(async () => {
        const response = await fetch("/api/auth/session", { credentials: "include" });
        let authenticated = false;
        if (response.ok) {
          const data = await response.json();
          authenticated = Boolean(data?.user);
        }
        return {
          status: response.status,
          authenticated,
          officialOrigin: location.origin === "https://chatgpt.com"
        };
      })()`,
    );

    if (!auth.officialOrigin) {
      throw new ConnectorError("RUNTIME_DRIFT", "page targetがChatGPT公式originではありません。");
    }
    if (!auth.authenticated) {
      throw new ConnectorError("AUTH_REQUIRED", "専用ChromeでChatGPTへログインしてください。", {
        status: auth.status,
      });
    }

    const existingBridge = await evaluateByValue<unknown>(
      this.#client,
      `(() => {
        const bridge = globalThis.__gptConnectorBridgeV1;
        return bridge?.version === 1 &&
          bridge?.buildId === ${JSON.stringify(bridgeBuildId)} &&
          typeof bridge.summary === "function"
          ? bridge.summary()
          : null;
      })()`,
    );
    const existingBridgeResult = z
      .object({
        version: z.literal(1),
        buildId: z.literal(bridgeBuildId),
        ready: z.literal(true),
      })
      .safeParse(existingBridge);
    if (existingBridgeResult.success) return;

    const runtimeUrl = await evaluateByValue<string>(this.#client, String.raw`(async () => {
      const imports = globalThis.__reactRouterManifest?.entry?.imports;
      if (!Array.isArray(imports)) throw new Error("RUNTIME_DRIFT:entry_imports");
      const matches = [];
      for (const path of imports) {
        const url = new URL(path, location.origin);
        if (url.origin !== location.origin || !url.pathname.startsWith("/cdn/assets/")) continue;
        const runtime = (await import(url.href)).__webpack_require__;
        if (typeof runtime === "function" && runtime.m && runtime.c) matches.push(url.href);
      }
      if (matches.length !== 1) throw new Error("RUNTIME_DRIFT:rspack_runtime:" + matches.length);
      return matches[0];
    })()`);
    const summary = await evaluateByValue<unknown>(
      this.#client,
      createBridgeBootstrapExpression(runtimeUrl),
    );
    const parsed = z
      .object({
        version: z.literal(1),
        buildId: z.literal(bridgeBuildId),
        ready: z.literal(true),
      })
      .safeParse(summary);
    if (!parsed.success) {
      throw new ConnectorError("RUNTIME_DRIFT", "page bridgeを初期化できませんでした。");
    }
  }

  async #runOperation(
    method: "startModels" | "startUpload" | "startChat" | "startClose",
    args: readonly unknown[],
    timeoutMs: number | null = this.#operationTimeoutMs,
    onStarted?: (started: OperationStart) => Promise<void>,
    pollIntervalMs = this.#pollIntervalMs,
  ): Promise<unknown> {
    const started = operationStartSchema.parse(
      await evaluateByValue<unknown>(
        this.#client,
        createBridgeCallExpression(method, args),
        false,
      ),
    );

    const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
    let reported = false;
    while (deadline === undefined || Date.now() < deadline) {
      const envelope = operationEnvelopeSchema.parse(
        await evaluateByValue<unknown>(
          this.#client,
          createBridgeCallExpression("poll", [started.operationId, false]),
          false,
        ),
      );

      if (envelope.state === "failed") {
        await this.#consumeOperation(started.operationId);
        const error = envelope.error;
        throw new ConnectorError(
          toConnectorErrorCode(error?.code),
          error?.message ?? "ChatGPT runtime operationが失敗しました。",
        );
      }

      if (!reported) {
        await onStarted?.(started);
        reported = true;
      }
      if (envelope.state === "succeeded") {
        await this.#consumeOperation(started.operationId);
        return envelope.result;
      }

      await delay(pollIntervalMs);
    }

    throw new ConnectorError(
      method === "startUpload" ? "UPLOAD_TIMEOUT" : "CHAT_FAILED",
      "ChatGPT runtime operationがtimeoutしました。",
      { method, timeoutMs },
    );
  }

  async #consumeOperation(operationId: string): Promise<void> {
    await evaluateByValue(
      this.#client,
      createBridgeCallExpression("poll", [operationId, true]),
      false,
    );
  }

  #flushDeliveries(): Promise<void> {
    this.#deliveryTask ??= this.#deliverPending().finally(() => { this.#deliveryTask = null; });
    return this.#deliveryTask;
  }

  async #deliverPending(): Promise<void> {
    await deliverPendingConsultJobs(this.#jobs, this.#parentDelivery, "ChatGPT");
  }
}

function toConnectorErrorCode(value: string | undefined): ConnectorErrorCode {
  return connectorErrorCodes.includes(value as ConnectorErrorCode)
    ? (value as ConnectorErrorCode)
    : "CHAT_FAILED";
}

function diagnosticReason(code: ConnectorErrorCode | null): ConnectorDiagnostics["reasonCode"] {
  if (code === "AUTH_REQUIRED") return "auth_required";
  if (code === "CDP_UNAVAILABLE") return "cdp_unavailable";
  if (code === "RUNTIME_DRIFT") return "runtime_drift";
  if (code === "JOB_RECOVERY_UNAVAILABLE") return "state_unavailable";
  return "connector_error";
}

function consultFingerprint(input: {
  readonly prompt: string;
  readonly level?: string;
  readonly files: readonly {
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly model: string | null;
  readonly effort: string | null;
  readonly keepOpen: boolean;
  readonly sessionId?: string;
  readonly parentThreadId?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      promptSha256: createHash("sha256").update(input.prompt).digest("hex"),
      files: input.files.map((file) => ({
        relativePath: file.relativePath,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      model: input.model,
      effort: input.effort,
      keepOpen: input.keepOpen,
      ...(input.level === undefined ? {} : { level: input.level }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
    }))
    .digest("hex");
}

function imageFingerprint(input: {
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly output: string;
  readonly model: string;
  readonly effort: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: "image.v1",
      promptSha256: createHash("sha256").update(input.prompt).digest("hex"),
      workspaceRoot: input.workspaceRoot,
      output: input.output,
      model: input.model,
      effort: input.effort,
    }))
    .digest("hex");
}

function imageGenerationPrompt(prompt: string): string {
  return [
    "画像生成ツールを使い、次の仕様に従う画像を1枚生成してください。",
    "説明文だけで終えず、必ず実画像を生成してください。",
    "",
    prompt,
  ].join("\n");
}

function retryFor(code: ConnectorErrorCode): ConsultSnapshot["error"] extends infer T
  ? T extends { retry: infer R } ? R : never
  : never {
  if (code === "AUTH_REQUIRED") return "after_auth";
  if (code === "RUNTIME_DRIFT") return "after_runtime_update";
  if (
    code === "INVALID_INPUT" ||
    code === "FILE_NOT_FOUND" ||
    code === "FILE_OUTSIDE_ROOT" ||
    code === "SENSITIVE_FILE_BLOCKED" ||
    code === "FILE_TYPE_NOT_SUPPORTED" ||
    code === "FILE_EMPTY" ||
    code === "FILE_LIMIT_EXCEEDED" ||
    code === "MODEL_NOT_AVAILABLE" ||
    code === "EFFORT_NOT_SUPPORTED"
    || code === "IMAGE_OUTPUT_FAILED"
  ) return "after_input_change";
  if (
    code === "UPLOAD_TIMEOUT" ||
    code === "UPLOAD_FAILED" ||
    code === "CHAT_FAILED" ||
    code === "STREAM_INCOMPLETE" ||
    code === "ATTACHMENT_READBACK_FAILED" ||
    code === "JOB_RECOVERY_UNAVAILABLE"
    || code === "IMAGE_NOT_GENERATED"
    || code === "IMAGE_READBACK_FAILED"
    || code === "IMAGE_DOWNLOAD_FAILED"
    || code === "IMAGE_CLEANUP_FAILED"
    || code === "MODEL_RESOLUTION_MISMATCH"
  ) return "status_first";
  return "never";
}
