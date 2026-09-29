// Cursor親の受け口。本体はaiterm-steer-delivery（Aitermと同じ配送）。
// 作業中はCursor公式hookのadditional_contextで差し込み、idle中は背景の受信processが起こす。
// 0.14以前に受け付けた依頼だけは、旧方式（cursor-parent.ts・cursor-inbox.ts）で完了させる。
import { fileURLToPath } from "node:url";
import * as steer from "aiterm-steer-delivery";
import { z } from "zod";

import { GPT_CONNECTOR_PROFILE as PROFILE } from "./steer-profile.js";
import { steerCall } from "./steer-errors.js";

export const cursorHookParentSchema = z.object({ kind: z.literal("cursor"), hook_root: z.string().min(1) }).strict();
export type CursorHookParent = z.infer<typeof cursorHookParentSchema>;

export interface CursorParentDelivery {
  readonly delivery_id: string;
  readonly wait_process: steer.WaitProcess;
}

/** ChatGPTとGrokの台帳は別だが、hookはどちらの依頼か区別できないので、配送記録は一か所に置く。 */
export function cursorHookRoot(): string {
  return steer.cursorHookRoot(PROFILE);
}

export function isCursorHookParent(parent: object): parent is CursorHookParent {
  return "kind" in parent && (parent as { kind?: unknown }).kind === "cursor";
}

export function cursorHookParentFromRequest(
  clientName: string | undefined,
  options: { hookRoot?: string; hooksFile?: string } = {},
): CursorHookParent | null {
  if (!steer.isCursorMcpClient(clientName)) return null;
  return steerCall(() => steer.cursorParentFromRequest(PROFILE, clientName, {
    hookRoot: options.hookRoot ?? cursorHookRoot(), hooksFile: options.hooksFile,
  }));
}

export function verifyCursorHookParent(parent: CursorHookParent, hooksFile?: string): void {
  steerCall(() => steer.verifyCursorParent(PROFILE, parent, hooksFile));
}

/** 受付時に配送IDの記録を作る。hookはこれが無い配送IDを会話へ結ばない。 */
export function prepareCursorHookDelivery(parent: CursorHookParent, deliveryId: string): void {
  steerCall(() => steer.prepareCursorDelivery(parent, deliveryId));
}

export async function submitCursorHookAnswer(parent: CursorHookParent, deliveryId: string, text: string): Promise<void> {
  await steerCall(() => steer.submitCursorParentAnswer(parent, deliveryId, text));
}

/** 背景で起動する受信process。scriptは同梱の受信入口。 */
export function cursorReceiveProcess(deliveryId: string, executable = process.execPath): steer.WaitProcess {
  const script = fileURLToPath(new URL("./cursor-parent-receive.js", import.meta.url));
  return steer.cursorReceiveProcess(script, deliveryId, executable);
}

export function cursorParentDelivery(deliveryId: string): CursorParentDelivery {
  return { delivery_id: deliveryId, wait_process: cursorReceiveProcess(deliveryId) };
}

/** 互換表示の`receiveCommand`。Cursorの背景シェル（POSIXはsh、WindowsはPowerShell 7）へそのまま渡せる形。 */
export function cursorReceiveCommand(wait: steer.WaitProcess): string {
  if (process.platform === "win32") return `& ${[wait.executable, ...wait.args].map(steer.quotePowerShell).join(" ")}`;
  return [wait.executable, ...wait.args].map(value => `'${value.replace(/'/g, `'"'"'`)}'`).join(" ");
}
