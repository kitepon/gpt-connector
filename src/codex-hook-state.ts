// Codexの設定領域にはhook登録だけを置き、配送の所有情報はgpt-connectorが保持する。本体はaiterm-steer-delivery。
import * as steer from "aiterm-steer-delivery";
import type { RuntimeProcess } from "aiterm-steer-delivery";
import { GPT_CONNECTOR_PROFILE as PROFILE } from "./steer-profile.js";
import { steerCall } from "./steer-errors.js";

export type CodexHookConfig = steer.CodexHookConfig;
export const { writeHookJson, codexInputDirectory, answerDigest } = steer;
export function codexHookDirectory(): string { return steer.codexHookDirectory(PROFILE); }
export function readCodexHookConfig(directory = codexHookDirectory()): CodexHookConfig | null { return steerCall(() => steer.readCodexHookConfig(PROFILE, directory)); }
export function registerCodexHookInput(home: string, thread: string, id: string, text: string, root = codexHookDirectory()): void {
  steer.registerCodexHookInput(home, thread, id, text, root);
}
export function finishCodexHookSubmission(home: string, thread: string, id: string, root: string): void { steer.finishCodexHookSubmission(home, thread, id, root); }
export function codexHookDeliveryState(home: string, thread: string, id: string, root = codexHookDirectory()): "sending" | "unknown" | null {
  return steerCall(() => steer.codexHookDeliveryState(home, thread, id, root));
}
export function ownedCodexHooks(response: unknown, command: string, file: string): ReturnType<typeof steer.ownedCodexHooks> { return steerCall(() => steer.ownedCodexHooks(PROFILE, response, command, file)); }
export function assertCodexHooksReady(response: unknown, command: string, file: string): void { steerCall(() => steer.assertCodexHooksReady(PROFILE, response, command, file)); }
export function assertCodexHookParentCurrent(config: CodexHookConfig, rows?: RuntimeProcess[], pid = process.pid): void {
  steerCall(() => steer.assertCodexHookParentCurrent(PROFILE, config, rows, pid));
}
