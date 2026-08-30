import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { missingPackedMarkdownTargets } from "../scripts/markdown-link-targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("実npm pack内の全Markdownは相対linkをpack内だけで解決する", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "gpt-connector-pack-contract-"));
  t.after(async () => rm(outputDirectory, { recursive: true, force: true }));
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", outputDirectory],
    { cwd: projectRoot, encoding: "utf8" },
  );
  const pack = JSON.parse(output) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.equal((await stat(join(outputDirectory, pack[0]?.filename ?? ""))).isFile(), true);
  const files = new Set(pack[0]?.files.map((file) => file.path) ?? []);
  const markdownFiles = [...files].filter((path) => path.endsWith(".md"));
  assert.ok(markdownFiles.length > 0, "npm packにMarkdownが含まれていません");
  const requiredHistory = [
    "docs/archive/native-attachment-contract-v0.2-history.md",
    "docs/archive/2026-07-13-native-attachment-oracle-replacement-plan.md",
    "docs/archive/2026-07-13-native-file-attachment-plan.md",
    "docs/archive/2026-07-13-oracle-replacement-evaluation-plan.md",
  ];
  for (const historyPath of requiredHistory) {
    assert.ok(files.has(historyPath), `参照される成立履歴がnpm packにありません: ${historyPath}`);
  }
  for (const markdownPath of markdownFiles) {
    const source = await readFile(resolve(projectRoot, markdownPath), "utf8");
    const missing = missingPackedMarkdownTargets({ markdownPath, markdown: source, packedPaths: files });
    assert.deepEqual(
      missing,
      [],
      `${markdownPath}の相対linkがnpm pack内で解決できません: ${missing
        .map(({ target, resolved }) => `${target} -> ${resolved}`)
        .join(", ")}`,
    );
  }
});

test("現行versionの直書き箇所はpackage versionと一致する", async () => {
  const [pkgSource, versionSource, readme, installer, changelog] = await Promise.all([
    readFile(resolve(projectRoot, "package.json"), "utf8"),
    readFile(resolve(projectRoot, "src/version.ts"), "utf8"),
    readFile(resolve(projectRoot, "README.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/ai-installer-setup-contract.md"), "utf8"),
    readFile(resolve(projectRoot, "CHANGELOG.md"), "utf8"),
  ]);
  const version = (JSON.parse(pkgSource) as { version: string }).version;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(versionSource, new RegExp(`packageVersion = ["']${escaped}["']`, "u"));
  assert.match(readme, new RegExp(`gpt-connector@${escaped}`, "u"));
  assert.match(installer, new RegExp(`gpt_connector_version=["']${escaped}["']`, "u"));
  assert.equal(changelog.match(/^## (\d+\.\d+\.\d+)\b/mu)?.[1], version);
});

test("復旧、release gate、archive履歴の案内は実装事実と一致する", async () => {
  const [readme, installer, release, history, evaluation, docsIndex, workflow] = await Promise.all([
    readFile(resolve(projectRoot, "README.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/ai-installer-setup-contract.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/release.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/archive/native-attachment-contract-v0.2-history.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/archive/2026-07-13-oracle-replacement-evaluation-plan.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/README.md"), "utf8"),
    readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8"),
  ]);
  assert.match(readme, /auth_required[^\n]*browser show[^\n]*専用Chromeを表示/u);
  assert.match(readme, /診断はChromeの表示状態を変えず/u);
  assert.match(installer, /Chromeの表示状態も変えず/u);
  assert.match(installer, /reasonCode`が`auth_required`[^\n]*\n次の正規入口で専用Chromeを表示/u);
  assert.match(installer, /gpt-connector browser show/u);
  assert.match(release, /test:release-gate[^\n]*単体試験/u);
  assert.match(release, /test:release-gate[^\n]*現在のworktreeは判定しない/u);
  assert.match(release, /verify:release-commit[^\n]*publish対象/u);
  assert.match(workflow, /release-commit:\s*[\s\S]*node scripts\/verify-release-commit\.mjs/u);
  assert.match(workflow, /corepack pnpm verify:release-commit/u);
  assert.match(workflow, /needs:\s*\[ownership, full, release-commit\]/u);
  assert.match(history, /engine[^\n]*実装しなかった/u);
  assert.match(history, /\]\(2026-07-13-native-attachment-oracle-replacement-plan\.md\)/u);
  assert.match(history, /\]\(2026-07-13-oracle-replacement-evaluation-plan\.md\)/u);
  assert.match(evaluation, /`engine`互換を実装する場合[^\n]*未実装/u);
  assert.match(docsIndex, /完了・中止・置換・凍結/u);

  const versionSync = release.match(/## Version同期\n([\s\S]*?)\n## /u)?.[1] ?? "";
  assert.match(versionSync, /^\s*- `README\.md`/mu);
  assert.doesNotMatch(versionSync, /^\s*- `pnpm-lock\.yaml`/mu);
});

test("製品CIはrepository内のreusable workflowだけを使う", async () => {
  const workflowsDirectory = resolve(projectRoot, ".github/workflows");
  const workflowFiles = (await readdir(workflowsDirectory))
    .filter((path) => /\.ya?ml$/u.test(path));
  const workflows = await Promise.all(workflowFiles.map(async (path) => ({
    path,
    source: await readFile(resolve(workflowsDirectory, path), "utf8"),
  })));
  for (const workflow of workflows) {
    assert.doesNotMatch(
      workflow.source,
      /uses:\s*kitepon\/dotagents\/\.github\/workflows\//u,
      `${workflow.path}が外部dotagents workflowへ依存しています`,
    );
  }

  const caller = workflows.find((workflow) => workflow.path === "ci.yml")?.source ?? "";
  const productFull = workflows.find(
    (workflow) => workflow.path === "product-full-ci.yml",
  )?.source ?? "";
  assert.match(caller, /uses:\s*\.\/\.github\/workflows\/product-full-ci\.yml\b/u);
  assert.match(caller, /documentation-command:\s*>-[\s\S]*test\/repository-contract\.test\.ts[\s\S]*test\/markdown-link-targets\.test\.ts/u);
  assert.match(productFull, /\bworkflow_call:\s*$/mu);
  assert.equal(productFull.match(/shell:\s*pwsh/gu)?.length, 3);
  assert.doesNotMatch(productFull, /Progra~1\\Git\\bin\\bash\.exe/u);
});
