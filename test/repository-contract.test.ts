import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.ok(
    files.has("docs/archive/native-attachment-contract-v0.2-history.md"),
    "現行attachment契約から参照する成立履歴がnpm packに含まれていません",
  );
  for (const markdownPath of markdownFiles) {
    const source = await readFile(resolve(projectRoot, markdownPath), "utf8");
    const targets = [
      ...[...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1] ?? ""),
      ...[...source.matchAll(/<(?:img|source)\b[^>]*(?:src|srcset)=["']([^"']+)["'][^>]*>/giu)]
        .map((match) => match[1] ?? ""),
    ];
    for (const rawTarget of targets) {
      const target = rawTarget.trim().replace(/^<|>$/gu, "");
      if (/^(?:https?:|mailto:|data:|#)/u.test(target)) continue;
      const path = target.split("#", 1)[0]?.split("?", 1)[0] ?? "";
      if (path.length === 0) continue;
      const packedPath = posix.normalize(posix.join(posix.dirname(markdownPath), path));
      assert.ok(
        files.has(packedPath),
        `${markdownPath}の相対link ${rawTarget} はnpm pack内の${packedPath}で解決できません`,
      );
    }
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
  assert.match(readme, /doctor[^\n]*auth_required[^\n]*表示/u);
  assert.match(installer, /`auth_required`では[^\n]*専用Chromeだけを表示/u);
  assert.match(installer, /`doctor`が専用Chromeを表示済み/u);
  assert.match(release, /test:release-gate[^\n]*単体試験/u);
  assert.match(release, /verify:release-commit[^\n]*publish対象/u);
  assert.match(workflow, /corepack pnpm verify:release-commit/u);
  assert.match(history, /engine[^\n]*実装しなかった/u);
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
  assert.match(caller, /documentation-command:\s*>-[\s\S]*test\/repository-contract\.test\.ts/u);
  assert.match(productFull, /\bworkflow_call:\s*$/mu);
});
