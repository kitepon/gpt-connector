// 公式CLIを通常stdioで起動し、公式キューへ配送する。本体はaiterm-steer-delivery（Aitermと同じ配送）。
import * as steer from "aiterm-steer-delivery";
import { GPT_CONNECTOR_PROFILE as PROFILE } from "./steer-profile.js";
import { steerCall } from "./steer-errors.js";

export const realCodexHome = steer.realCodexHome;
export interface CodexReceiverParent { thread_id: string; codex_home: string }
export interface CodexReceiverRuntime { executable: string; args?: string[]; timeout_ms?: number; hook_directory?: string }
export type CodexRequest = (method: string, params: object) => Promise<unknown>;

export async function withCodexReceiver<T>(parent: CodexReceiverParent, action: (request: CodexRequest) => Promise<T>, runtime?: CodexReceiverRuntime): Promise<T> {
  return steerCall(() => steer.withCodexReceiver(PROFILE, parent, action, runtime));
}

/** Steer（hook）が無効でも公式キューで届ける。有効なら導入済みhookと親processの状態も確かめる。 */
export async function verifyCodexQueueParent(parent: CodexReceiverParent, runtime?: CodexReceiverRuntime): Promise<void> {
  await steerCall(() => steer.verifyCodexParent(PROFILE, parent, runtime ?? undefined));
}

export async function submitCodexQueueAnswer(parent: CodexReceiverParent, deliveryId: string, text: string, runtime?: CodexReceiverRuntime): Promise<void> {
  await steerCall(() => steer.submitCodexParentAnswer(PROFILE, parent, deliveryId, text, runtime));
}
