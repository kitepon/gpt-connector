import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("npm pack内の全Markdownは相対linkをpack内だけで解決する", async () => {
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  const pack = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set(pack[0]?.files.map((file) => file.path) ?? []);
  const markdownFiles = [...files].filter((path) => path.endsWith(".md"));
  assert.ok(markdownFiles.length > 0, "npm packにMarkdownが含まれていません");
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
  const [readme, installer, release, history, docsIndex] = await Promise.all([
    readFile(resolve(projectRoot, "README.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/ai-installer-setup-contract.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/release.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/archive/native-attachment-contract-v0.2-history.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/README.md"), "utf8"),
  ]);
  assert.match(readme, /auth_required[^\n]*browser show/u);
  assert.match(installer, /auth_required[^\n]*browser show/u);
  assert.match(release, /test:release-gate[^\n]*単体試験/u);
  assert.match(release, /verify:release-commit[^\n]*publish対象/u);
  assert.match(history, /engine[^\n]*実装しなかった/u);
  assert.match(docsIndex, /完了・中止・置換・凍結/u);
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
