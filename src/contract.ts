import { z } from "zod";

import { isAbsolute } from "node:path";

import type { ConnectorErrorCode } from "./errors.js";

export const consultSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u);

// model/effortはlive ChatGPTのcatalogでfail-closedに検証される。callerが他providerの
// model IDを渡す誤用を、実行前のschema注釈の時点で止める。
export const chatgptModelFieldDescription =
  "chatgpt_modelsが返すOpenAI ChatGPTのmodel slugだけを指定する（例 gpt-5-5）。" +
  "claude-*、gemini-*など他providerのmodel IDは指定できず、MODEL_NOT_AVAILABLEで失敗する。";

export const chatgptEffortFieldDescription =
  "chatgpt_modelsが当該ChatGPT modelに対して返したthinking effortだけを指定する。";

export const consultInputSchema = z
  .object({
    prompt: z.string().min(1),
    files: z.array(z.string()).min(1).max(20).optional(),
    workspaceRoot: z.string().min(1).optional(),
    model: z.string().min(1).optional().describe(chatgptModelFieldDescription),
    effort: z.string().min(1).optional().describe(chatgptEffortFieldDescription),
    slug: consultSlugSchema,
    keepOpen: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.files !== undefined && input.workspaceRoot === undefined) {
      context.addIssue({
        code: "custom",
        message: "files指定時はworkspaceRootが必要です。",
        path: ["workspaceRoot"],
      });
    }
    if (input.workspaceRoot !== undefined && !isAbsolute(input.workspaceRoot)) {
      context.addIssue({
        code: "custom",
        message: "workspaceRootはabsolute pathで指定してください。",
        path: ["workspaceRoot"],
      });
    }
    if (input.effort !== undefined && input.model === undefined) {
      context.addIssue({
        code: "custom",
        message: "effort指定時はmodelが必要です。",
        path: ["model"],
      });
    }
  });

export type ConsultInput = z.input<typeof consultInputSchema>;

export const imageInputSchema = z
  .object({
    prompt: z.string().min(1),
    workspaceRoot: z.string().min(1),
    output: z.string().min(1),
    model: z.string().min(1).describe(chatgptModelFieldDescription),
    effort: z.string().min(1).optional().describe(chatgptEffortFieldDescription),
    slug: consultSlugSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!isAbsolute(input.workspaceRoot)) {
      context.addIssue({
        code: "custom",
        message: "workspaceRootはabsolute pathで指定してください。",
        path: ["workspaceRoot"],
      });
    }
    if (isAbsolute(input.output) || input.output.includes("\0")) {
      context.addIssue({
        code: "custom",
        message: "outputはworkspaceRoot相対pathで指定してください。",
        path: ["output"],
      });
    }
  });

export type ImageInput = z.input<typeof imageInputSchema>;

export const sessionsInputSchema = z
  .object({ slug: consultSlugSchema })
  .strict();

export type SessionsInput = z.input<typeof sessionsInputSchema>;

export interface ConsultDryRunFile {
  readonly relativePath: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface ConsultDryRunResult {
  readonly dryRun: true;
  readonly slug: string;
  readonly files: readonly ConsultDryRunFile[];
  readonly totalBytes: number;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  readonly limits: {
    readonly maxFiles: 20;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
  };
  readonly uploadWouldRun: false;
  readonly conversationWouldRun: false;
}

export const chatInputSchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    sessionId: z.string().uuid().optional(),
    keepOpen: z.boolean().default(false),
  })
  .strict();

export type ChatInput = z.input<typeof chatInputSchema>;

export const closeInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();

export type CloseInput = z.input<typeof closeInputSchema>;

export interface ModelChoice {
  readonly id: string;
  readonly title: string;
  readonly reasoningType: string | null;
  readonly efforts: readonly string[];
  readonly configurableEffort: boolean;
  readonly maxTokens: number | null;
}

export interface ModelCatalog {
  readonly defaultModel: string | null;
  readonly models: readonly ModelChoice[];
}

export interface ChatResult {
  readonly text: string;
  readonly status: string;
  readonly endTurn: true;
  readonly resolvedModel: string | null;
  readonly resolvedEffort: string | null;
  readonly sessionId?: string;
}

export interface CloseResult {
  readonly archived: true;
}

export interface ConnectorDiagnostics {
  readonly schema: "gpt-connector.diagnostics.v1";
  readonly packageVersion: string;
  readonly overall: "ready" | "not_ready";
  readonly reasonCode:
    | "ready"
    | "auth_required"
    | "cdp_unavailable"
    | "runtime_drift"
    | "state_unavailable"
    | "connector_error";
  readonly cdpConnected: boolean;
  readonly officialOrigin: boolean | null;
  readonly authenticated: boolean | null;
  readonly bridgeBuildId: string;
  readonly sessionCount: number | null;
  readonly operationCount: number | null;
  readonly uploadCount: number | null;
  readonly bufferedUploadBytes: number | null;
  readonly downloadCount: number | null;
  readonly bufferedDownloadBytes: number | null;
  readonly jobCount: number | null;
  readonly activeJobCount: number | null;
  readonly terminalJobCount: number | null;
}

export type ConsultJobState =
  | "queued"
  | "uploading"
  | "submitted"
  | "running"
  | "succeeded"
  | "failed";

export interface ConsultAttachmentSummary {
  readonly count: number;
  readonly names: readonly string[];
  readonly mimeTypes: readonly (string | null)[];
  readonly readBack: "confirmed";
  readonly retention: "unknown";
  readonly cleanup: "not_supported" | "failed" | "deleted";
}

export interface ConsultSuccessResult extends ChatResult {
  readonly attachments: ConsultAttachmentSummary;
  readonly images?: GeneratedImageSummary;
  readonly archived: boolean;
}

export interface GeneratedImageFile {
  readonly relativePath: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface GeneratedImageSummary {
  readonly count: number;
  readonly files: readonly GeneratedImageFile[];
  readonly readBack: "confirmed";
  readonly retention: "library" | "recently_deleted" | "mixed";
  readonly cleanup: "not_supported" | "soft_deleted" | "failed" | "partial";
}

export type ImageSnapshot = ConsultSnapshot;

export interface ConsultFailure {
  readonly code: ConnectorErrorCode;
  readonly message: string;
  readonly retry:
    | "never"
    | "after_input_change"
    | "after_auth"
    | "after_runtime_update"
    | "status_first";
  readonly partialUpload?: {
    readonly count: number;
    readonly cleanup: "not_supported" | "failed";
  };
}

export interface ConsultSnapshot {
  readonly slug: string;
  readonly state: ConsultJobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result: ConsultSuccessResult | null;
  readonly error: ConsultFailure | null;
}
