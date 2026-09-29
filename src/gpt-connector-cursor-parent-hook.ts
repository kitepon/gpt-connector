#!/usr/bin/env node
// Cursorが起動する公式hook（afterMCPExecution・postToolUse）。stdoutはCursorのhook出力だけに使い、失敗しても作業は止めない。
import { handleCursorParentHook } from "./cursor-hook.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks).toString("utf8");
try {
  process.stdout.write(`${JSON.stringify(await handleCursorParentHook(raw.length > 0 ? raw : "{}"))}\n`);
} catch (error) {
  process.stderr.write(`gpt-connector cursor hook: ${error instanceof Error ? error.message : "failed"}\n`);
  process.stdout.write("{}\n");
}
