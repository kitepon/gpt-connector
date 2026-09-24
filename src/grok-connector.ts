import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { CdpClient, discoverProviderTarget } from "./cdp.js";
import { deliverPendingConsultJobs, type ParentDelivery } from "./consult-delivery.js";
import { ConsultJobStore, type DeliveryParent } from "./consult-job-store.js";
import {
  grokChatInputSchema, grokConsultInputSchema, sessionsInputSchema, closeInputSchema,
  type ChatResult, type ConsultSnapshot, type GrokChatInput, type GrokConsultInput,
  type SessionsInput, type CloseInput,
} from "./contract.js";
import { verifyCodexParent, deliverCodexAnswer } from "./codex-parent.js";
import { verifyCursorParent, deliverCursorAnswer } from "./cursor-parent.js";
import { ConnectorError, connectorErrorCodes, type ConnectorErrorCode } from "./errors.js";
import { discoverGrokModules } from "./grok-asset-discovery.js";
import {
  createGrokBridgeBootstrapExpression, createGrokBridgeCallExpression, grokBridgeBuildId,
} from "./grok-page-bridge.js";
import { defaultConsultStateDirectory } from "./platform/state.js";
import { evaluateByValue } from "./runtime-evaluate.js";

const summarySchema = z.object({ version: z.literal(1), buildId: z.literal(grokBridgeBuildId), ready: z.literal(true) });
const operationStartSchema = z.object({ operationId: z.string().uuid() });
const operationSchema = z.object({
  state: z.enum(["pending", "succeeded", "failed"]),
  sessionId: z.string().uuid().nullable(),
  result: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
const chatResultSchema = z.object({
  text: z.string().min(1), status: z.string(), endTurn: z.literal(true),
  resolvedModel: z.string().nullable(), resolvedEffort: z.string().nullable(),
  requestedMode: z.literal("auto"), reportedModel: z.string().nullable(),
  sessionId: z.string().uuid().optional(),
  attachments: z.object({
    count: z.literal(0), names: z.array(z.string()).length(0),
    mimeTypes: z.array(z.string()).length(0), readBack: z.literal("confirmed"),
    retention: z.literal("unknown"), cleanup: z.literal("not_supported"),
  }),
  archived: z.literal(false),
});
const modesSchema = z.object({
  defaultMode: z.string(), selectedMode: z.string(),
  modes: z.array(z.object({ id: z.string(), title: z.string(), available: z.boolean() })),
});

export interface GrokConnectorOptions {
  readonly endpoint?: string;
  readonly stateDirectory?: string;
  readonly fetch?: typeof fetch;
  readonly cdpTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly readOnlyJobs?: boolean;
  readonly parentDelivery?: ParentDelivery;
}

export class GrokConnector {
  readonly #client: CdpClient;
  readonly #jobs: ConsultJobStore;
  readonly #tasks = new Map<string, Promise<ConsultSnapshot>>();
  readonly #parentDelivery: ParentDelivery;
  readonly #operationTimeoutMs: number | null;
  readonly #pollIntervalMs: number;
  #deliveryTask: Promise<void> | null = null;
  #transportFailed = false;

  get transportFailed(): boolean { return this.#transportFailed; }
  get stateDirectory(): string { return this.#jobs.stateDirectory; }

  private constructor(client: CdpClient, options: GrokConnectorOptions) {
    this.#client = client;
    this.#jobs = new ConsultJobStore({ stateDirectory: join(options.stateDirectory ?? defaultConsultStateDirectory(), "grok"), readOnly: options.readOnlyJobs });
    this.#operationTimeoutMs = options.operationTimeoutMs ?? null;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
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

  static async connect(options: GrokConnectorOptions = {}): Promise<GrokConnector> {
    const target = await discoverProviderTarget(options.endpoint ?? "http://127.0.0.1:9223", "grok", options.fetch);
    const client = await CdpClient.connect(target.webSocketDebuggerUrl, options.cdpTimeoutMs);
    const connector = new GrokConnector(client, options);
    try {
      await client.call("Runtime.enable");
      await connector.#jobs.initialize();
      const existing = await evaluateByValue<unknown>(client,
        `globalThis.__gptConnectorGrokBridgeV1?.summary?.() ?? null`, false);
      if (!summarySchema.safeParse(existing).success) {
        const modules = await discoverGrokModules(client, options.fetch);
        const raw = await evaluateByValue(client, createGrokBridgeBootstrapExpression(modules));
        if (!summarySchema.safeParse(raw).success) throw new ConnectorError("RUNTIME_DRIFT", "Grok bridgeを初期化できませんでした。");
      }
      const auth = z.object({ authenticated: z.boolean() }).parse(
        await evaluateByValue(client, createGrokBridgeCallExpression("auth", [])),
      );
      if (!auth.authenticated) throw new ConnectorError("AUTH_REQUIRED", "専用ChromeでGrokへログインしてください。");
      if (!options.readOnlyJobs) await connector.#flushDeliveries();
      return connector;
    } catch (error) {
      connector.close();
      throw error;
    }
  }

  static async doctor(options: GrokConnectorOptions = {}): Promise<Awaited<ReturnType<GrokConnector["diagnostics"]>> | {
    schema: "gpt-connector.grok-diagnostics.v1";
    overall: "not_ready";
    reasonCode: string;
  }> {
    let connector: GrokConnector | undefined;
    try {
      connector = await GrokConnector.connect({ ...options, readOnlyJobs: true });
      return await connector.diagnostics();
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      return { schema: "gpt-connector.grok-diagnostics.v1", overall: "not_ready",
        reasonCode: error.code };
    } finally { connector?.close(); }
  }

  async modes(): Promise<z.output<typeof modesSchema>> {
    return modesSchema.parse(await evaluateByValue(this.#client, createGrokBridgeCallExpression("modes", [])));
  }

  async diagnostics(): Promise<{
    schema: "gpt-connector.grok-diagnostics.v1";
    overall: "ready";
    bridgeBuildId: string;
    operationCount: number;
    activeSessionCount: number;
    jobCount: number;
    activeJobCount: number;
    terminalJobCount: number;
  }> {
    const page = z.object({ operationCount: z.number().int(), sessionCount: z.number().int() }).parse(
      await evaluateByValue(this.#client, createGrokBridgeCallExpression("diagnostics", []), false),
    );
    return { schema: "gpt-connector.grok-diagnostics.v1", overall: "ready",
      bridgeBuildId: grokBridgeBuildId, operationCount: page.operationCount,
      activeSessionCount: page.sessionCount, ...this.#jobs.diagnostics() };
  }

  async chat(input: GrokChatInput): Promise<ChatResult> {
    const parsed = grokChatInputSchema.parse(input);
    const result = await this.#runChat(parsed);
    return { text: result.text, status: result.status, endTurn: true,
      resolvedModel: result.resolvedModel, resolvedEffort: result.resolvedEffort,
      requestedMode: result.requestedMode, reportedModel: result.reportedModel,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}) };
  }

  async consult(input: GrokConsultInput, parent?: DeliveryParent): Promise<ConsultSnapshot | {
    dryRun: true; slug: string; requestedMode: "auto"; conversationWouldRun: false;
  }> {
    let parsed: z.output<typeof grokConsultInputSchema>;
    try { parsed = grokConsultInputSchema.parse(input); }
    catch { throw new ConnectorError("INVALID_INPUT", "Grok consult inputが公開schemaに一致しません。"); }
    if (parsed.dryRun) return { dryRun: true, slug: parsed.slug, requestedMode: "auto", conversationWouldRun: false };
    if (parent) {
      await this.#parentDelivery.verify(parent);
      parsed.wait = false;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({
      provider: "grok", promptSha256: createHash("sha256").update(parsed.prompt).digest("hex"),
      sessionId: parsed.sessionId ?? null, keepOpen: parsed.keepOpen,
      parentThreadId: parent && "threadId" in parent ? parent.threadId : null,
    })).digest("hex");
    const reservation = await this.#jobs.reserve(parsed.slug, fingerprint, parent);
    if (!reservation.created) {
      return parsed.wait ? this.#tasks.get(parsed.slug) ?? reservation.snapshot : reservation.snapshot;
    }
    let accept!: (snapshot: ConsultSnapshot) => void;
    const accepted = new Promise<ConsultSnapshot>((resolve) => { accept = resolve; });
    const task = this.#runConsultJob(parsed, accept, parent !== undefined).then(async (snapshot) => {
      await this.#flushDeliveries();
      return this.#jobs.get(snapshot.slug);
    });
    this.#tasks.set(parsed.slug, task);
    void task.then(
      () => { this.#tasks.delete(parsed.slug); },
      () => {
        this.#tasks.delete(parsed.slug);
        process.stderr.write("gpt-connector: JOB_RECOVERY_UNAVAILABLE（Grok相談結果を保存できませんでした）\n");
      },
    );
    return parsed.wait ? task : Promise.race([accepted, task]);
  }

  sessions(input: SessionsInput): ConsultSnapshot {
    return this.#jobs.get(sessionsInputSchema.parse(input).slug);
  }

  async closeSession(input: CloseInput): Promise<{ deleted: true }> {
    const parsed = closeInputSchema.parse(input);
    return z.object({ deleted: z.literal(true) }).parse(
      await evaluateByValue(this.#client, createGrokBridgeCallExpression("close", [parsed.sessionId])),
    );
  }

  close(): void {
    try { this.#jobs.close(); } finally { this.#client.close(); }
  }

  async shutdown(): Promise<void> {
    const settled = await Promise.allSettled(this.#tasks.values());
    this.close();
    const failed = settled.find((entry) => entry.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async #runConsultJob(
    input: z.output<typeof grokConsultInputSchema>,
    accept: (snapshot: ConsultSnapshot) => void,
    autoDeliver: boolean,
  ): Promise<ConsultSnapshot> {
    try {
      await this.#jobs.transition(input.slug, "submitted");
      const result = await this.#runChat(input, async (sessionId) => {
        accept(await this.#jobs.transition(input.slug, "running", {
          ...(input.keepOpen ? { sessionId } : {}),
        }));
      }, autoDeliver ? 10_000 : this.#pollIntervalMs);
      return this.#jobs.transition(input.slug, "succeeded", { result, error: null });
    } catch (error) {
      if (error instanceof ConnectorError && (error.code === "CDP_UNAVAILABLE" || error.code === "RUNTIME_DRIFT")) this.#transportFailed = true;
      const reason = error instanceof ConnectorError ? error :
        new ConnectorError("CHAT_FAILED", "Grok相談が失敗しました。");
      return this.#jobs.transition(input.slug, "failed", {
        error: { code: reason.code, message: reason.message,
          retry: reason.code === "AUTH_REQUIRED" ? "after_auth" :
            reason.code === "RUNTIME_DRIFT" ? "after_runtime_update" :
            reason.code === "MODEL_NOT_AVAILABLE" || reason.code === "INVALID_INPUT" ? "after_input_change" :
            reason.code === "SESSION_NOT_FOUND" || reason.code === "SESSION_BUSY" ? "never" : "status_first" },
      });
    }
  }

  async #runChat(
    input: z.output<typeof grokChatInputSchema>,
    onStarted?: (sessionId: string) => Promise<void>,
    pollIntervalMs = this.#pollIntervalMs,
  ): Promise<z.output<typeof chatResultSchema>> {
    const started = operationStartSchema.parse(await evaluateByValue(
      this.#client, createGrokBridgeCallExpression("startChat", [input]), false,
    ));
    const deadline = this.#operationTimeoutMs === null ? null : Date.now() + this.#operationTimeoutMs;
    let reported = false;
    while (deadline === null || Date.now() < deadline) {
      const envelope = operationSchema.parse(await evaluateByValue(
        this.#client, createGrokBridgeCallExpression("poll", [started.operationId, false]), false,
      ));
      if (envelope.state === "failed") {
        await evaluateByValue(this.#client, createGrokBridgeCallExpression("poll", [started.operationId, true]), false);
        const code = connectorErrorCodes.includes(envelope.error?.code as ConnectorErrorCode)
          ? envelope.error!.code as ConnectorErrorCode : "CHAT_FAILED";
        throw new ConnectorError(code, envelope.error?.message ?? "Grok Chatが失敗しました。");
      }
      if (!reported && envelope.sessionId) {
        await onStarted?.(envelope.sessionId);
        reported = true;
      }
      if (envelope.state === "succeeded") {
        await evaluateByValue(this.#client, createGrokBridgeCallExpression("poll", [started.operationId, true]), false);
        return chatResultSchema.parse(envelope.result);
      }
      await delay(pollIntervalMs);
    }
    throw new ConnectorError("CHAT_FAILED", "Grok Chatの回答待機がtimeoutしました。");
  }

  #flushDeliveries(): Promise<void> {
    this.#deliveryTask ??= deliverPendingConsultJobs(this.#jobs, this.#parentDelivery, "Grok")
      .finally(() => { this.#deliveryTask = null; });
    return this.#deliveryTask;
  }
}
