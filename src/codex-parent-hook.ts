#!/usr/bin/env node
// Codexが起動する同期hook。stdoutはCodexの公式hook出力だけに使う。失敗をStop継続のexit 2に変換しない。本体はaiterm-steer-delivery。
import { runCodexHookMain } from "aiterm-steer-delivery";
import { GPT_CONNECTOR_PROFILE } from "./steer-profile.js";
await runCodexHookMain(GPT_CONNECTOR_PROFILE, process.argv[2]);
