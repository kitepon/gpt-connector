import assert from "node:assert/strict";
import test from "node:test";
import { modelResolutionMatches, normalizeModelCatalog, resolveChatSelection } from "../src/model-catalog.js";
import { ConnectorError } from "../src/errors.js";
import { rawCatalog } from "./latest-catalog.fixture.js";

test("既定モデルはWebの最新スライダー右端へ一致する", () => {
  const catalog = normalizeModelCatalog(rawCatalog);
  assert.equal(catalog.defaultModel, "gpt-pro");
});

test("最新の5段階をWebの順序と名前で公開し、全段階を解決する", () => {
  const catalog = normalizeModelCatalog(rawCatalog);
  assert.deepEqual(catalog.levels.map(item => item.level), ["Instant", "中程度", "高", "極高", "Pro"]);
  assert.deepEqual(catalog.levels.map(item => item.id), [0, 1, 2, 6, 3]);
  assert.equal(catalog.defaultLevel, "Pro");
  assert.deepEqual(catalog.levels.map(item => resolveChatSelection(catalog, { level: item.level })), [
    { model: "gpt-instant" },
    { model: "gpt-thinking", effort: "standard" },
    { model: "gpt-thinking", effort: "extended" },
    { model: "gpt-thinking", effort: "max" },
    { model: "gpt-pro" },
  ]);
  assert.deepEqual(resolveChatSelection(catalog, {}), { model: "gpt-pro" });
});

test("最新の右端が更新されたら名前やモデルを固定せず追従する", () => {
  const changed = structuredClone(rawCatalog);
  changed.models.push({ slug: "gpt-next", title: "Next", reasoning_type: "pro", thinking_efforts: [] });
  changed.versions[0]!.intelligence_presets[4]!.model_slug = "gpt-next";
  changed.versions[0]!.intelligence_presets[4]!.title = "新しい右端";
  assert.deepEqual(resolveChatSelection(normalizeModelCatalog(changed), {}), { model: "gpt-next" });
});

test("右端が利用不可でも手前の段階へ下げない", () => {
  const changed = structuredClone(rawCatalog);
  changed.versions[0]!.intelligence_presets[4]!.preset_type = "upgrade";
  const catalog = normalizeModelCatalog(changed);
  assert.equal(catalog.levels.length, 5);
  assert.throws(() => resolveChatSelection(catalog, {}),
    (error) => error instanceof ConnectorError && error.code === "MODEL_NOT_AVAILABLE");
});

test("最新の定義欠落と壊れた右端はRUNTIME_DRIFTで止める", () => {
  for (const versions of [[], [{ id: "latest", enabled: false, intelligence_presets: [] }],
    [{ id: "latest", enabled: true, intelligence_presets: [{ title: "Pro" }] }]]) {
    assert.throws(() => normalizeModelCatalog({ ...rawCatalog, versions }),
      (error) => error instanceof ConnectorError && error.code === "RUNTIME_DRIFT");
  }
});

test("未知の段階、混在指定、Workモデルへの解決を拒否する", () => {
  const catalog = normalizeModelCatalog(rawCatalog);
  assert.throws(() => resolveChatSelection(catalog, { level: "最小" }));
  assert.throws(() => resolveChatSelection(catalog, { level: "Pro", model: "gpt-thinking" }));
  assert.throws(() => resolveChatSelection(catalog, { level: "Pro", effort: "max" }));
  const workOnly = normalizeModelCatalog({ ...rawCatalog,
    models: rawCatalog.models.map(model => ({ ...model, is_work_mode_model: model.slug === "gpt-pro" })),
  });
  assert.throws(() => resolveChatSelection(workOnly, {}));
  assert.deepEqual(resolveChatSelection(catalog, { model: "gpt-thinking", effort: "min" }),
    { model: "gpt-thinking", effort: "min" });
});

test("通常Chatの実行モデルと明示思考量を照合し、省略時の思考量は捏造しない", () => {
  assert.equal(modelResolutionMatches("gpt-pro", undefined, "gpt-pro", null), true);
  assert.equal(modelResolutionMatches("gpt-pro", undefined, "gpt-thinking", "max"), false);
  assert.equal(modelResolutionMatches("gpt-pro", undefined, null, null), false);
  assert.equal(modelResolutionMatches("gpt-thinking", "max", "gpt-thinking", "extended"), false);
  assert.equal(modelResolutionMatches("gpt-thinking", "max", "gpt-thinking", "max"), true);
});
