import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { configureLegacyCodexSteer as configureCodexSteer } from "../src/setup-codex-steer.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gpt-steer-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gui = new Map<string, string>();
  const events: string[] = [];
  let live = false;
  const runtime = {
    platform: "darwin", directory: join(root, "config"), socket_root: join(root, "sockets"),
    node: "/usr/local/bin/node", relay: "/gpt-connector/codex-stdio-relay.js",
    findBinary: () => "/Applications/Codex.app/Contents/Resources/codex",
    getGui: (key: string) => gui.get(key) ?? null,
    setGui: (key: string, value: string | null) => { events.push("set"); if (value === null) gui.delete(key); else gui.set(key, value); },
    persist: () => { events.push("persist"); }, unpersist: () => { events.push("unpersist"); },
    verify: async (launcher: string) => {
      events.push("verify");
      const text = await readFile(launcher, "utf8");
      assert.match(text, /gpt-connector\/codex-stdio-relay/u);
      assert.doesNotMatch(text, /aiterm/iu);
    },
    live: async () => live, compatible: async () => false,
  };
  return { root, runtime, gui, events, started: () => { live = true; } };
}

test("未導入環境へ単独で準備し、起動確認後にready、解除で元の設定へ戻す", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  assert.equal((await configureCodexSteer("status", f.runtime)).status, "disabled");
  assert.deepEqual(await readdir(f.root), []);
  assert.equal((await configureCodexSteer("enable", f.runtime)).status, "restart_required");
  assert.deepEqual(f.events, ["verify", "persist", "set"]);
  assert.equal(f.gui.get("CODEX_CLI_PATH"), join(f.runtime.directory, "codex"));
  f.started();
  assert.equal((await configureCodexSteer("status", f.runtime)).status, "ready");
  assert.equal((await configureCodexSteer("disable", f.runtime)).status, "restart_required");
  assert.equal(f.gui.has("CODEX_CLI_PATH"), false);
  assert.equal(JSON.parse(await readFile(join(f.runtime.directory, "config.json"), "utf8")).enabled, false);
});

test("既存の公式受付と共存する時は起動設定も他製品のファイルも変更しない", async t => {
  const f = await fixture(t);
  f.gui.set("CODEX_CLI_PATH", "/another-product/launcher");
  const runtime = { ...f.runtime, compatible: async () => true };
  assert.deepEqual(await configureCodexSteer("enable", runtime), { status: "ready", connection: "existing" });
  assert.deepEqual(await configureCodexSteer("status", runtime), { status: "ready", connection: "existing" });
  await configureCodexSteer("disable", runtime);
  assert.deepEqual(f.events, []);
  assert.deepEqual(await readdir(f.root), []);
  assert.equal(f.gui.get("CODEX_CLI_PATH"), "/another-product/launcher");
});

test("互換性を確認できない設定と候補の起動失敗は、GUI設定変更前に止める", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  f.gui.set("CODEX_CLI_PATH", "/another-product/launcher");
  await assert.rejects(configureCodexSteer("enable", f.runtime), { reasonCode: "codex_steer_configuration_conflict" });
  f.gui.clear();
  await assert.rejects(configureCodexSteer("enable", { ...f.runtime, verify: async () => { throw new Error("候補の起動失敗"); } }), /候補の起動失敗/u);
  assert.deepEqual(f.events, []);
  assert.deepEqual(await readdir(f.runtime.directory), []);
});

test("導入後に別の起動設定へ変わった場合は解除で上書きしない", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await configureCodexSteer("enable", f.runtime);
  f.gui.set("CODEX_CLI_PATH", "/changed/launcher");
  await assert.rejects(configureCodexSteer("disable", f.runtime), { reasonCode: "codex_steer_configuration_changed" });
  assert.equal(f.gui.get("CODEX_CLI_PATH"), "/changed/launcher");
});

test("対象外OSは設定に触れず対応外を返す", async t => {
  const f = await fixture(t);
  assert.equal((await configureCodexSteer("enable", { ...f.runtime, platform: "linux" })).status, "unsupported");
  assert.deepEqual(f.events, []);
  assert.deepEqual(await readdir(f.root), []);
});

test("解除済み記録でもGUIに残った自分のlauncherを解除し、他製品は保持する", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await configureCodexSteer("enable", f.runtime);
  const launcher = f.gui.get("CODEX_CLI_PATH")!;
  await configureCodexSteer("disable", f.runtime);
  f.gui.set("CODEX_CLI_PATH", launcher);
  assert.equal((await configureCodexSteer("disable", f.runtime)).status, "restart_required");
  assert.equal(f.gui.has("CODEX_CLI_PATH"), false);
  f.gui.set("CODEX_CLI_PATH", "/other/launcher");
  assert.equal((await configureCodexSteer("disable", f.runtime)).status, "disabled");
  assert.equal(f.gui.get("CODEX_CLI_PATH"), "/other/launcher");
});
