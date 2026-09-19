import { accessSync, constants } from "node:fs";
import { CodexSteerSetupError } from "../codex-steer-config.js";

// Homebrew更新で消えるCellar実体を永続登録へ保存しない。
export function setupNodeExecutable(executable = process.execPath): string {
  const brew = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(executable);
  if (!brew) return executable;
  const node = `${brew[1]}/opt/${brew[2]}/bin/node`;
  try { accessSync(node, constants.X_OK); }
  catch { throw new CodexSteerSetupError("node_runtime_unavailable", "HomebrewのNode起動先を実行できません。Nodeの導入状態を確認してください。"); }
  return node;
}
