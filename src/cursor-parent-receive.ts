#!/usr/bin/env node
// Cursor親がidleのとき、背景で起動して回答本文の到着を待つ受け口。本体はaiterm-steer-delivery。
// 結果は1行のJSON（0=受取、3=期限切れ、1=誤り）。
import { runCursorReceiveMain } from "aiterm-steer-delivery";
import { cursorHookRoot } from "./cursor-parent-receiver.js";
import { GPT_CONNECTOR_PROFILE } from "./steer-profile.js";

await runCursorReceiveMain(GPT_CONNECTOR_PROFILE, process.argv.slice(2), cursorHookRoot());
