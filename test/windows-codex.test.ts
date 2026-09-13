import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { windowsServerArguments } from "../src/platform/windows-codex-relay.js";
import { buildWindowsLauncher, configureWindowsCodexSteer, findWindowsCodexCache, windowsLauncherSource } from "../src/platform/windows-codex-setup.js";
import { ensurePrivateDirectory } from "../src/platform/state.js";
import { withCodexSocket } from "../src/codex-parent.js";
import { findWindowsParentSocket, readWindowsProcesses, readWindowsRelay } from "../src/platform/windows-codex-parent.js";

test("Windows: Desktopの配布元と一致する実行用コピーだけを採用する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-codex-cache-"));
  const resources = join(directory, "resources");
  const cache = join(directory, "cache");
  const current = join(cache, "0123456789abcdef");
  const old = join(cache, "fedcba9876543210");
  const names = ["codex.exe", "codex-code-mode-host.exe", "codex-windows-sandbox-setup.exe", "codex-command-runner.exe"];
  try {
    for (const target of [resources, current, old]) {
      await mkdir(target, { recursive: true });
      for (const name of names) await writeFile(join(target, name), target === old ? "古い配布" : name);
    }
    assert.equal(findWindowsCodexCache(resources, cache), join(current, "codex.exe"));
    await writeFile(join(current, "codex-command-runner.exe"), "他の配布");
    assert.throws(() => findWindowsCodexCache(resources, cache), /公式Desktopを起動/);
    assert.throws(() => findWindowsCodexCache(resources, join(directory, "未起動")), /公式Desktopを起動/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows: serverだけを中継し、他コマンドと既存transportを変更しない", () => {
  assert.deepEqual(windowsServerArguments(["-c", 'x="app-server"', "app-server", "--stdio", "--analytics-default-enabled"]), ["-c", 'x="app-server"', "app-server", "--analytics-default-enabled"]);
  assert.deepEqual(windowsServerArguments(["app-server", "--listen", "stdio://"]), ["app-server"]);
  for (const args of [["--version"], ["exec", "app-server"], ["app-server", "proxy"], ["app-server", "daemon", "status"], ["app-server", "--help"]]) assert.equal(windowsServerArguments(args), null);
  assert.throws(() => windowsServerArguments(["app-server", "--listen", "ws://127.0.0.1:9999"]), /変更できません/);
  assert.throws(() => windowsServerArguments(["app-server", "--ws-token-file", "secret"]), /変更できません/);
});

test("Windows: native launcherは空白・日本語・引用符・末尾backslashをそのまま子へ渡す", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-launcher-日本語 "));
  ensurePrivateDirectory(directory);
  const echo = join(directory, "echo.mjs");
  await writeFile(echo, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  try {
    const source = windowsLauncherSource(process.execPath, echo, "binary with space", "root with space");
    const launcher = buildWindowsLauncher(directory, source);
    const args = ['a"b', "a b", "日本語", "last\\", "", "\\\"quoted"];
    const child = spawn(launcher, args, { windowsHide: true });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    assert.equal((await once(child, "close"))[0], 0);
    assert.deepEqual(JSON.parse(output), ["binary with space", "root with space", ...args]);
    assert.equal(buildWindowsLauncher(directory, source), launcher);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows: native launcherはstdinをEOF前に転送する", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-stdin-"));
  ensurePrivateDirectory(directory);
  const echo = join(directory, "echo.mjs");
  await writeFile(echo, "process.stdin.on('data', data => process.stdout.write(data));\n");
  const launcher = buildWindowsLauncher(directory, windowsLauncherSource(process.execPath, echo, "binary", "root"));
  const child = spawn(launcher, [], { windowsHide: true });
  const exited = once(child, "close");
  const reader = createInterface({ input: child.stdout });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = once(reader, "line", { signal: controller.signal });
    child.stdin.write("initialize\n");
    assert.equal((await response)[0], "initialize");
  } finally { clearTimeout(timer); child.stdin.end(); await exited; reader.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Windows: 同梱CLIで中継initializeとEOF後のprocess終了・接続情報削除を確認する", { skip: process.platform !== "win32" || !process.env.GPT_CONNECTOR_TEST_CODEX_BINARY }, async () => {
  const directory = await mkdtemp(join(resolve(".gpt-connector-tmp"), "codex-test-"));
  ensurePrivateDirectory(directory);
  const root = join(directory, "sessions");
  ensurePrivateDirectory(root);
  const codexHome = join(directory, "codex");
  ensurePrivateDirectory(codexHome);
  const relay = resolve("dist/src/platform/windows-codex-relay.js");
  const launcher = buildWindowsLauncher(directory, windowsLauncherSource(process.execPath, relay, process.env.GPT_CONNECTOR_TEST_CODEX_BINARY!, root));
  const child = spawn(launcher, ["app-server", "--listen", "stdio://"], { env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true });
  const exited = once(child, "close");
  const reader = createInterface({ input: child.stdout });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = once(reader, "line", { signal: controller.signal });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "gpt_windows_test", version: "1" } } }) + "\n");
    const value = JSON.parse((await response)[0]);
    assert.equal(value.id, 1);
    assert.ok(value.result);
    const sessions = await readdir(root);
    assert.equal(sessions.length, 1);
    const record = JSON.parse(await readFile(join(root, sessions[0]!, "connection.json"), "utf8"));
    assert.ok(record.serverPid > 0);
    readWindowsRelay(join(root, sessions[0]!, "connection.json"));
    const rows = readWindowsProcesses();
    assert.equal(findWindowsParentSocket([...rows, { pid: 99999999, parent_pid: record.serverPid, command: "MCP fixture", executable: process.execPath, started: "fixture" }], 99999999), join(root, sessions[0]!, "connection.json"));
    assert.throws(() => findWindowsParentSocket(rows, 99999999), /親CodexのSteer接続がありません/);
    const loaded = await withCodexSocket(join(root, sessions[0]!, "connection.json"), request => request("thread/loaded/list", { limit: 1 }));
    assert.deepEqual((loaded as { data: unknown[] }).data, []);
    execFileSync("icacls", [join(root, sessions[0]!, "connection.json"), "/grant", "*S-1-5-32-545:R"], { windowsHide: true });
    assert.throws(() => readWindowsRelay(join(root, sessions[0]!, "connection.json")));
    child.stdin.end();
    assert.equal((await exited)[0], 0);
    assert.deepEqual(await readdir(root), []);
    assert.throws(() => process.kill(record.serverPid, 0), { code: "ESRCH" });
  } finally { clearTimeout(timer); child.stdin.end(); await exited; reader.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Windows: setupは検証後に起動設定を保存し、再実行・解除・競合を区別する", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-setup-windows-"));
  let gui: string | null = null;
  let ready = false;
  let verified = 0;
  const runtime = { directory, node: process.execPath, relay: "fixture.js", findBinary: () => "fixture.exe",
    getGui: (key: string) => key === "CODEX_CLI_PATH" ? gui : null,
    setGui: (_key: string, value: string | null) => { assert.ok(verified > 0); gui = value; },
    verify: async () => { verified++; }, live: async () => ready };
  try {
    assert.equal((await configureWindowsCodexSteer("enable", runtime)).status, "restart_required");
    const launcher = gui;
    ready = true;
    assert.equal((await configureWindowsCodexSteer("status", runtime)).status, "ready");
    assert.equal((await configureWindowsCodexSteer("enable", runtime)).status, "ready");
    assert.equal(gui, launcher);
    gui = "another.exe";
    await assert.rejects(configureWindowsCodexSteer("disable", runtime), /上書きしません/);
    gui = launcher;
    assert.equal((await configureWindowsCodexSteer("disable", runtime)).status, "restart_required");
    assert.equal(gui, null);
    assert.equal((await configureWindowsCodexSteer("status", runtime)).status, "disabled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
