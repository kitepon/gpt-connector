import { z } from "zod";

import { isAbsolute } from "node:path";

import type { ConnectorErrorCode } from "./errors.js";

export const consultSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u);

// 段階から内部model/effortへの変換はconnectorが所有する。
export const chatgptLevelFieldDescription =
  "通常Chatの「最新」の思考量。chatgpt_modelsのlevelsにあるlevelを指定する" +
  "（例: Instant・中程度・高・極高・Pro）。省略時は最新スライダーの右端。" +
  "model/effortとの併用は不可。";

// 明示model/effortは既存呼出しと画像生成の互換入口。
export const chatgptModelFieldDescription =
  "chatgpt_modelsが返すOpenAI ChatGPTのmodel slugだけを指定する（例 gpt-5-5）。" +
  "catalogに無い値はMODEL_NOT_AVAILABLEで失敗する。";

export const chatgptEffortFieldDescription =
  "chatgpt_modelsが当該ChatGPT modelに対して返したthinking effortだけを指定する。";

export const chatgptSessionFieldDescription =
  "同じChatGPT会話を続けるためのID。初回は省略し、keepOpen=trueで返されたsessionIdを次回も指定する。" +
  "継続時は既に渡した前提・資料の再送は不要で、追加質問・変更点を渡す。専用Chromeのpage再読込・終了・bridge更新後は無効。";

export const chatgptKeepOpenFieldDescription =
  "会話を継続する場合はtrue。sessionIdを返して会話を保持する。falseは今回の回答後にarchiveする。最後はchatgpt_closeで閉じる。";

export const consultInputSchema = z
  .object({
    prompt: z.string().min(1),
    level: z.string().min(1).optional().describe(chatgptLevelFieldDescription),
    files: z.array(z.string()).min(1).max(20).optional(),
    workspaceRoot: z.string().min(1).optional(),
    model: z.string().min(1).optional().describe(chatgptModelFieldDescription),
    effort: z.string().min(1).optional().describe(chatgptEffortFieldDescription),
    slug: consultSlugSchema,
    sessionId: z.string().uuid().optional().describe(chatgptSessionFieldDescription),
    keepOpen: z.boolean().default(false).describe(chatgptKeepOpenFieldDescription),
    wait: z.boolean().default(true).describe(
      "falseは回答完了を待たず、受付時のslug・状態・sessionId（keepOpen=true時）を返す。結果はsessionsで同じslugから取得する。自動通知は行わない。trueは従来どおり回答まで待つ。",
    ),
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
    if (input.level !== undefined && (input.model !== undefined || input.effort !== undefined)) {
      context.addIssue({ code: "custom", message: "levelとmodel/effortは併用できません。", path: ["level"] });
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
    level: z.string().min(1).optional().describe(chatgptLevelFieldDescription),
    model: z.string().min(1).optional().describe(chatgptModelFieldDescription),
    effort: z.string().min(1).optional().describe(chatgptEffortFieldDescription),
    sessionId: z.string().uuid().optional().describe(chatgptSessionFieldDescription),
    keepOpen: z.boolean().default(false).describe(chatgptKeepOpenFieldDescription),
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

export interface ChatLevel {
  readonly id: number;
  readonly level: string;
  readonly displayVersion: string | null;
  readonly model: string;
  readonly effort?: string;
  readonly available: boolean;
}

export interface ModelCatalog {
  readonly version: "latest";
  readonly defaultLevel: string;
  readonly defaultModel: string;
  readonly levels: readonly ChatLevel[];
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
  /** 会話を保持する問い合わせは、受付時から継続用IDを返す。 */
  readonly sessionId?: string;
  readonly state: ConsultJobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result: ConsultSuccessResult | null;
  readonly error: ConsultFailure | null;
}
