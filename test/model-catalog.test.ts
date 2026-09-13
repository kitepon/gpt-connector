import assert from "node:assert/strict";
import test from "node:test";

import { ConnectorError } from "../src/errors.js";
import {
  normalizeModelCatalog,
  validateModelSelection,
} from "../src/model-catalog.js";

const catalog = normalizeModelCatalog({
  default_model_slug: "gpt-chat",
  versions: [{ id: "latest", enabled: true, intelligence_presets: [
    { id: 3, title: "Pro", model_slug: "gpt-chat", preset_type: "available" },
  ] }],
  models: [
    {
      slug: "gpt-chat",
      title: "GPT Chat",
      reasoning_type: "reasoning",
      thinking_efforts: [
        { thinking_effort: "min" },
        { thinking_effort: "standard" },
      ],
      configurable_thinking_effort: true,
      is_work_mode_model: false,
      max_tokens: 1000,
    },
    {
      slug: "gpt-work",
      title: "GPT Work",
      thinking_efforts: [{ thinking_effort: "max" }],
      is_work_mode_model: true,
    },
  ],
});

test("Work-only modelをcatalogから除外する", () => {
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["gpt-chat"],
  );
  assert.equal(catalog.defaultModel, "gpt-chat");
});

test("modelとeffortの対応を検証する", () => {
  assert.deepEqual(validateModelSelection(catalog, "gpt-chat", "min"), {
    requestedModel: "gpt-chat",
    requestedEffort: "min",
  });
});

test("非対応effortはfallbackせず拒否する", () => {
  assert.throws(
    () => validateModelSelection(catalog, "gpt-chat", "max"),
    (error) =>
      error instanceof ConnectorError && error.code === "EFFORT_NOT_SUPPORTED",
  );
});

test("未知modelはfallbackせず拒否する", () => {
  assert.throws(
    () => validateModelSelection(catalog, "missing", undefined),
    (error) =>
      error instanceof ConnectorError && error.code === "MODEL_NOT_AVAILABLE",
  );
});

test("model未指定時は公式default解決へ委ねる", () => {
  assert.deepEqual(validateModelSelection(catalog, undefined, undefined), {});
});

test("modelなしのeffort指定は拒否する", () => {
  assert.throws(
    () => validateModelSelection(catalog, undefined, "min"),
    (error) =>
      error instanceof ConnectorError && error.code === "EFFORT_NOT_SUPPORTED",
  );
});
