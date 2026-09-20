import assert from "node:assert/strict";
import test from "node:test";
import { macGuiEnvironment } from "../src/platform/macos-gui-environment.js";

test("呼出元の環境が空でもAquaの値を読み、同じ対象で解除・読戻しする", () => {
  const gui = new Map([["CODEX_CLI_PATH", "/old/launcher"]]);
  const run = (args: string[]) => {
    assert.deepEqual(args.slice(0, 3), ["asuser", "501", "/bin/launchctl"]);
    const [action, key, value] = args.slice(3);
    if (action === "unsetenv") gui.delete(key!);
    if (action === "setenv") gui.set(key!, value!);
    return { pid: 1, output: [], stdout: action === "getenv" ? gui.get(key!) ?? "" : "", stderr: "", status: 0, signal: null };
  };
  assert.equal(macGuiEnvironment("getenv", "CODEX_CLI_PATH", undefined, run, 501), "/old/launcher");
  macGuiEnvironment("unsetenv", "CODEX_CLI_PATH", undefined, run, 501);
  assert.equal(macGuiEnvironment("getenv", "CODEX_CLI_PATH", undefined, run, 501), null);
  macGuiEnvironment("setenv", "CODEX_CLI_PATH", "/restored/path", run, 501);
  assert.equal(gui.get("CODEX_CLI_PATH"), "/restored/path");
});

test("GUIへの接続失敗を設定なしとして扱わない", () => {
  const run = () => ({ pid: 1, output: [], stdout: "", stderr: "接続拒否", status: 1, signal: null });
  assert.throws(() => macGuiEnvironment("getenv", "CODEX_CLI_PATH", undefined, run, 501),
    { reasonCode: "codex_steer_environment_unavailable" });
});
