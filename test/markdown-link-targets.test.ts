import assert from "node:assert/strict";
import test from "node:test";

import {
  markdownLinkTargets,
  missingPackedMarkdownTargets,
  relativeMarkdownLinkTargets,
} from "../scripts/markdown-link-targets.mjs";

test("nested、reference、HTMLのhref・src・srcsetを全て列挙する", () => {
  const markdown = [
    "[![image](assets/image(one).png)](docs/outer(target).md)",
    "",
    "[asset]: images/reference.png \"title\"",
    "[multiline]:",
    "  docs/multiline.md",
    "",
    "<a href=\"docs/from-html.md\">guide</a>",
    "<video src=\"assets/demo.mp4\"></video>",
    "<img src=\"assets/base.png\" srcset=\"assets/small.png 1x, assets/large.png 2x\">",
    "<source srcset=\"assets/mobile.png 480w, https://example.com/wide.png 960w\">",
  ].join("\n");

  assert.deepEqual(markdownLinkTargets(markdown), [
    "docs/outer(target).md",
    "assets/image(one).png",
    "images/reference.png",
    "docs/multiline.md",
    "docs/from-html.md",
    "assets/demo.mp4",
    "assets/base.png",
    "assets/small.png",
    "assets/large.png",
    "assets/mobile.png",
    "https://example.com/wide.png",
  ]);
});

test("reference形式とnested外側の欠落をnpm packの欠落として返す", () => {
  const missing = missingPackedMarkdownTargets({
    markdownPath: "README.md",
    markdown: [
      "[![present](assets/present.png)](docs/missing(outer).md)",
      "",
      "![hero][asset]",
      "",
      "[asset]: images/missing.png",
    ].join("\n"),
    packedPaths: new Set(["README.md", "assets/present.png"]),
  });

  assert.deepEqual(missing, [
    { target: "docs/missing(outer).md", resolved: "docs/missing(outer).md" },
    { target: "images/missing.png", resolved: "images/missing.png" },
  ]);
});

test("code fence、inline code、comment、data-src内の疑似linkを除外する", () => {
  const markdown = [
    "`[inline](missing-inline.md)`",
    "<!-- [comment](missing-comment.md) -->",
    "```md",
    "[fenced](missing-fenced.md)",
    "```",
    "<video data-src=\"missing-data-src.mp4\"></video>",
    "[real](docs/a\\(b\\).md)",
  ].join("\n");

  assert.deepEqual(markdownLinkTargets(markdown), ["docs/a(b).md"]);
});

test("HTML entityとcommaを含むsrcset URLをpathへ戻す", () => {
  const markdown = [
    "[entity](assets/a&amp;b.png)",
    "<a title='example href=\"missing-title.md\"' href=\"docs/real.md\">x</a>",
    "<a href=\"assets/html&amp;entity.md\">entity</a>",
    "<img srcset=\"assets/crop,wide.png 1x, assets/next.png 2x\">",
  ].join("\n");

  assert.deepEqual(relativeMarkdownLinkTargets(markdown), [
    "assets/a&b.png",
    "docs/real.md",
    "assets/html&entity.md",
    "assets/crop,wide.png",
    "assets/next.png",
  ]);
});
