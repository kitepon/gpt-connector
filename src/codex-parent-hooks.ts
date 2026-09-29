// 親の同期hookだけが、公式キューのgpt-connector回答を同じターンの入力へ移す。本体はaiterm-steer-delivery。
import * as steer from "aiterm-steer-delivery";
import { GPT_CONNECTOR_PROFILE as PROFILE } from "./steer-profile.js";
import type { CodexReceiverRuntime } from "./codex-receiver.js";
import { steerCall } from "./steer-errors.js";

export async function runCodexResultHook(input: unknown, emit: (value: object) => Promise<void>, options: {
  directory?: string; codex_home?: string; runtime?: CodexReceiverRuntime;
} = {}): Promise<void> {
  await steerCall(() => steer.runCodexResultHook(PROFILE, input, emit, options));
}
