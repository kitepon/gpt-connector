// Steerの正規導入。公式hookを登録・承認してから、旧中継の起動差し替えを解除する。本体はaiterm-steer-delivery。
import { fileURLToPath } from "node:url";
import * as steer from "aiterm-steer-delivery";
import { CodexSteerSetupError, readRelayConfig, type RelayConfig } from "./codex-steer-config.js";
import { configureLegacyCodexSteer as configureLegacyRelay } from "./setup-codex-steer.js";
import { ensurePrivateDirectory } from "./platform/state.js";
import { macGuiEnvironment } from "./platform/macos-gui-environment.js";
import { readCodexHookConfig, type CodexHookConfig } from "./codex-hook-state.js";
import { GPT_CONNECTOR_PROFILE as PROFILE } from "./steer-profile.js";
import { translateSteerError } from "./steer-errors.js";
import type { CodexSteerAction, CodexSteerResult } from "./setup-codex-steer.js";
export type { CodexSteerAction, CodexSteerResult } from "./setup-codex-steer.js";

export function codexSteerSelected(): boolean { return readCodexHookConfig()?.enabled === true || readRelayConfig()?.enabled === true; }
export const codexHookCommand = steer.codexHookCommand;

export function mergeCodexParentHooks(file: string, command: string | null, previousCommand?: string): boolean {
  try { return steer.mergeCodexParentHooks(PROFILE, file, command, previousCommand); }
  catch (error) {
    if (error instanceof steer.SetupError) throw Object.assign(new CodexSteerSetupError(error.code, error.message), { cause: error });
    throw error;
  }
}

export async function verifyCodexHookRegistration(config: CodexHookConfig, approve: boolean): Promise<void> {
  await withSetupErrors(() => steer.verifyCodexHookRegistration(PROFILE, config, approve));
}

type Runtime = steer.CodexSteerRuntime & { legacyOverride: () => string | null };

export async function configureCodexSteer(action: CodexSteerAction = "status", overrides: Partial<Runtime> = {}): Promise<CodexSteerResult> {
  const legacyOverride = overrides.legacyOverride ?? (() => process.platform === "darwin" ? macGuiEnvironment("getenv", "CODEX_CLI_PATH") : null);
  const readLegacy = overrides.legacy ?? readRelayConfig;
  // 旧中継は、有効な選択か、GUIの起動設定に旧launcherが残っている間は移行が必要。
  const legacy = () => {
    const relay = readLegacy() as (RelayConfig & { launcher?: string }) | { enabled: boolean; binary?: string } | null;
    if (!relay) return null;
    const pending = relay.enabled || ("launcher" in relay && relay.launcher !== undefined && legacyOverride() === relay.launcher);
    return pending ? { enabled: true, ...(relay.binary ? { binary: relay.binary } : {}) } : null;
  };
  const rest: Partial<Runtime> = { ...overrides };
  delete rest.legacyOverride;
  return withSetupErrors(() => steer.configureCodexSteer(PROFILE, action, {
    hook: fileURLToPath(new URL("./codex-parent-hook.js", import.meta.url)),
    disableLegacy: () => configureLegacyRelay("disable"), verify: verifyCodexHookRegistration,
    prepareDirectory: directory => ensurePrivateDirectory(directory),
    ...rest, legacy,
  }));
}

// パッケージのsetup失敗は、gpt-connectorのsetup結果と同じreason_codeの形で返す。
async function withSetupErrors<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof steer.SetupError) throw Object.assign(new CodexSteerSetupError(error.code, error.message), { cause: error });
    throw translateSteerError(error);
  }
}
