import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  consultInputSchema,
  chatInputSchema,
  imageInputSchema,
  sessionsInputSchema,
} from "../src/contract.js";
import { packageVersion } from "../src/version.js";

test("CLI/package公開versionをpackage.jsonと一致させる", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  assert.equal(packageVersion, packageJson.version);
});

test("consult inputは既定値とslugを正規化する", () => {
  assert.deepEqual(
    consultInputSchema.parse({ prompt: "見解をください", slug: "review-001" }),
    {
      prompt: "見解をください",
      slug: "review-001",
      keepOpen: false,
      wait: true,
      dryRun: false,
    },
  );
});

test("consult inputは未知fieldと不正slugを拒否する", () => {
  assert.throws(() =>
    consultInputSchema.parse({ prompt: "x", slug: "Bad Slug", engine: "browser" }),
  );
  assert.throws(() => consultInputSchema.parse({ prompt: "x", slug: "ab" }));
});

test("filesにはabsolute workspaceRootが必要", () => {
  assert.throws(() =>
    consultInputSchema.parse({ prompt: "x", slug: "files-001", files: ["a.md"] }),
  );
  assert.throws(() =>
    consultInputSchema.parse({
      prompt: "x",
      slug: "files-001",
      files: ["a.md"],
      workspaceRoot: "relative/root",
    }),
  );

  const parsed = consultInputSchema.parse({
    prompt: "x",
    slug: "files-001",
    files: ["a.md"],
    workspaceRoot: "/workspace",
  });
  assert.deepEqual(parsed.files, ["a.md"]);
  assert.equal(parsed.workspaceRoot, "/workspace");
});

test("effort指定時はmodelを必須にする", () => {
  assert.throws(() =>
    consultInputSchema.parse({ prompt: "x", slug: "effort-001", effort: "extended" }),
  );
  assert.equal(
    consultInputSchema.parse({
      prompt: "x",
      slug: "effort-001",
      model: "gpt-5-6-thinking",
      effort: "extended",
    }).effort,
    "extended",
  );
});

test("chatとconsultは最新の段階を受け取り、省略を内部モデル名で埋めない", () => {
  assert.equal(chatInputSchema.parse({ prompt: "確認", level: "Pro" }).level, "Pro");
  assert.equal(consultInputSchema.parse({ prompt: "確認", slug: "level-001", level: "高" }).level, "高");
  assert.equal(chatInputSchema.parse({ prompt: "確認" }).model, undefined);
  assert.throws(() => consultInputSchema.parse({ prompt: "確認", slug: "level-002", level: "Pro", model: "gpt-thinking" }));
});

test("sessions inputはexact slugだけを受ける", () => {
  assert.deepEqual(sessionsInputSchema.parse({ slug: "review-001" }), {
    slug: "review-001",
  });
  assert.throws(() => sessionsInputSchema.parse({}));
  assert.throws(() => sessionsInputSchema.parse({ slug: "review-001", list: true }));
});

test("image inputはmodelと安全な保存境界を必須にする", () => {
  assert.deepEqual(
    imageInputSchema.parse({
      prompt: "珊瑚色の円",
      slug: "image-001",
      workspaceRoot: "/workspace",
      output: "assets/ad.png",
      model: "gpt-5-6-thinking",
      effort: "min",
    }),
    {
      prompt: "珊瑚色の円",
      slug: "image-001",
      workspaceRoot: "/workspace",
      output: "assets/ad.png",
      model: "gpt-5-6-thinking",
      effort: "min",
    },
  );
  assert.throws(() => imageInputSchema.parse({
    prompt: "x",
    slug: "image-001",
    workspaceRoot: "relative",
    output: "ad.png",
    model: "gpt-5-6-thinking",
  }));
  assert.throws(() => imageInputSchema.parse({
    prompt: "x",
    slug: "image-001",
    workspaceRoot: "/workspace",
    output: "/tmp/ad.png",
    model: "gpt-5-6-thinking",
  }));
  assert.throws(() => imageInputSchema.parse({
    prompt: "x",
    slug: "image-001",
    workspaceRoot: "/workspace",
    output: "ad.png",
  }));
});
