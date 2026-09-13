import { z } from "zod";

import { ConnectorError } from "./errors.js";
import type { ChatInput, ModelCatalog, ModelChoice } from "./contract.js";

export interface RawThinkingEffort {
  readonly thinking_effort?: unknown;
}

export interface RawModel {
  readonly slug?: unknown;
  readonly title?: unknown;
  readonly reasoning_type?: unknown;
  readonly thinking_efforts?: unknown;
  readonly configurable_thinking_effort?: unknown;
  readonly is_work_mode_model?: unknown;
  readonly max_tokens?: unknown;
}

export interface RawModelCatalog {
  readonly default_model_slug?: unknown;
  readonly models?: unknown;
  readonly versions?: unknown;
}

function toEfforts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const effort = (item as RawThinkingEffort).thinking_effort;
    return typeof effort === "string" && effort.length > 0 ? [effort] : [];
  });
}

function toModel(value: unknown): ModelChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as RawModel;
  if (raw.is_work_mode_model === true || typeof raw.slug !== "string") return null;

  return {
    id: raw.slug,
    title: typeof raw.title === "string" ? raw.title : raw.slug,
    reasoningType: typeof raw.reasoning_type === "string" ? raw.reasoning_type : null,
    efforts: toEfforts(raw.thinking_efforts),
    configurableEffort: raw.configurable_thinking_effort === true,
    maxTokens:
      typeof raw.max_tokens === "number" && Number.isFinite(raw.max_tokens)
        ? raw.max_tokens
        : null,
  };
}

export function normalizeModelCatalog(raw: RawModelCatalog): ModelCatalog {
  const models = Array.isArray(raw.models)
    ? raw.models.flatMap((model) => {
        const normalized = toModel(model);
        return normalized === null ? [] : [normalized];
      })
    : [];

  return withLatestLevels(models, raw.versions);
}

export function withLatestLevels(models: readonly ModelChoice[], versions: unknown): ModelCatalog {
  const candidates = Array.isArray(versions)
    ? versions.filter((version) => version?.id === "latest") : [];
  const parsed = latestVersionSchema.safeParse(candidates.length === 1 ? candidates[0] : null);
  if (!parsed.success) {
    throw new ConnectorError("RUNTIME_DRIFT", "通常Chatの最新スライダー定義を取得できませんでした。");
  }
  const levels = parsed.data.intelligence_presets.map((preset) => ({
    id: preset.id,
    level: preset.title,
    displayVersion: preset.selected_display_version ?? null,
    model: preset.model_slug,
    ...(preset.thinking_effort === undefined ? {} : { effort: preset.thinking_effort }),
    available: preset.preset_type === "available",
  }));
  if (new Set(levels.map((level) => level.level)).size !== levels.length) {
    throw new ConnectorError("RUNTIME_DRIFT", "最新スライダーの段階名が重複しています。");
  }
  // 右端は配列の最後。presetのidは順序を表さない。
  const rightmost = levels[levels.length - 1]!;
  return { version: "latest", defaultLevel: rightmost.level, defaultModel: rightmost.model, levels, models };
}

const latestVersionSchema = z.object({
  id: z.literal("latest"),
  enabled: z.literal(true),
  intelligence_presets: z.array(z.object({
    id: z.number().int(),
    title: z.string().min(1),
    selected_display_version: z.string().optional(),
    model_slug: z.string().min(1),
    thinking_effort: z.string().min(1).optional(),
    preset_type: z.string().min(1),
  })).min(1),
});

export interface ChatSelection {
  readonly model: string;
  readonly effort?: string;
}

export function resolveChatSelection(
  catalog: ModelCatalog,
  input: Pick<ChatInput, "level" | "model" | "effort">,
): ChatSelection {
  if (input.level !== undefined && (input.model !== undefined || input.effort !== undefined)) {
    throw new ConnectorError("INVALID_INPUT", "levelとmodel/effortは併用できません。");
  }
  if (input.model !== undefined || input.effort !== undefined) {
    validateModelSelection(catalog, input.model, input.effort);
    return { model: input.model!, ...(input.effort === undefined ? {} : { effort: input.effort }) };
  }
  const level = input.level === undefined
    ? catalog.levels[catalog.levels.length - 1]
    : catalog.levels.find((candidate) => candidate.level === input.level);
  if (!level || !level.available) {
    throw new ConnectorError("MODEL_NOT_AVAILABLE", "指定した最新の段階を利用できません。", {
      level: input.level ?? catalog.defaultLevel,
    });
  }
  validateModelSelection(catalog, level.model, level.effort);
  return { model: level.model, ...(level.effort === undefined ? {} : { effort: level.effort }) };
}

export function modelResolutionMatches(
  model: string,
  effort: string | undefined,
  resolvedModel: string | null,
  resolvedEffort: string | null,
): boolean {
  return model === resolvedModel && (effort === undefined || effort === resolvedEffort);
}

export interface ValidatedModelSelection {
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
}

export function validateModelSelection(
  catalog: ModelCatalog,
  model: string | undefined,
  effort: string | undefined,
): ValidatedModelSelection {
  if (model === undefined) {
    if (effort !== undefined) {
      throw new ConnectorError(
        "EFFORT_NOT_SUPPORTED",
        "effortを指定する場合はmodelも指定してください。",
      );
    }
    return {};
  }

  const selected = catalog.models.find((candidate) => candidate.id === model);
  if (selected === undefined) {
    throw new ConnectorError(
      "MODEL_NOT_AVAILABLE",
      "指定modelは現在の通常Chat catalogで利用できません。",
      { model },
    );
  }

  if (effort !== undefined && !selected.efforts.includes(effort)) {
    throw new ConnectorError(
      "EFFORT_NOT_SUPPORTED",
      "指定effortは選択modelで利用できません。",
      { model, effort },
    );
  }

  return {
    requestedModel: model,
    ...(effort === undefined ? {} : { requestedEffort: effort }),
  };
}
