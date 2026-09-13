import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCodexSteer, type CodexSteerRuntime } from "../src/setup-codex-steer.js";

// 環境APIだけを差し替え、Macの設定判定を両OSで同じ入力・期待値に通す。
for (const platform of ["darwin", "win32"]) test(`${platform}: 設定の所有・検証順序・復元・既存接続はMacと共通`, async t => {
  const directory = mkdtempSync(join(tmpdir(), "gpt-setup-parity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gui = new Map<string, string>();
  const events: string[] = [];
  let live = false;
  let compatible = false;
  const launcher = join(directory, "launcher");
  const configFile = join(directory, "config.json");
  const runtime: Partial<CodexSteerRuntime> = {
    platform, directory, findBinary: () => "official",
    getGui: key => gui.get(key) ?? null,
    setGui: (key, value) => { events.push("set"); if (value === null) gui.delete(key); else gui.set(key, value); },
    persist: () => { events.push("persist"); }, unpersist: () => { events.push("unpersist"); },
    prepare: target => { mkdirSync(target, { recursive: true }); },
    save: (_target, config) => { events.push("save"); writeFileSync(configFile, JSON.stringify(config)); },
    build: async (_options, verify) => { await verify(launcher); return launcher; },
    verify: async () => { events.push("verify"); }, live: async () => live, compatible: async () => compatible,
  };
  const run = (action: "enable" | "disable" | "status") => configureCodexSteer(action, runtime);
  assert.deepEqual(await run("status"), { status: "disabled" });
  gui.set("CODEX_CLI_PATH", "other-launcher");
  await assert.rejects(run("enable"), { reasonCode: "codex_steer_configuration_conflict" });
  compatible = true;
  assert.deepEqual(await run("enable"), { status: "ready", connection: "existing" });
  assert.deepEqual(await run("status"), { status: "ready", connection: "existing" });
  assert.deepEqual(await run("disable"), { status: "disabled" });
  assert.deepEqual(events, []);
  assert.equal(gui.get("CODEX_CLI_PATH"), "other-launcher");
  compatible = false;
  gui.set("CODEX_CLI_PATH", "official");
  await assert.rejects(configureCodexSteer("enable", { ...runtime, verify: async () => { throw new Error("候補失敗"); } }), /候補失敗/);
  assert.deepEqual(events, []);
  assert.equal((await run("enable")).status, "restart_required");
  assert.deepEqual(events, ["verify", "save", "persist", "set"]);
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).previous_cli_path, "official");
  live = true;
  assert.deepEqual(await run("status"), { status: "ready" });
  assert.deepEqual(await run("enable"), { status: "ready" });
  gui.set("CODEX_CLI_PATH", "third-party");
  assert.deepEqual(await run("status"), { status: "failed", reason_code: "codex_steer_configuration_changed" });
  await assert.rejects(run("disable"), { reasonCode: "codex_steer_configuration_changed" });
  assert.equal(gui.get("CODEX_CLI_PATH"), "third-party");
  // 元の値へ戻っている場合も、Macの既存仕様どおり解除を完了する。
  gui.set("CODEX_CLI_PATH", "official");
  assert.equal((await run("disable")).status, "restart_required");
  assert.equal(gui.get("CODEX_CLI_PATH"), "official");
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).enabled, false);
  assert.deepEqual(events.slice(-3), ["unpersist", "set", "save"]);
});
