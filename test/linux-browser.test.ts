import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { showBrowser, startBrowser } from "../src/browser-launcher.js";
import { chromeLaunchCommand, hideProcess, inspectListenerProcesses, isOwnedChromeProcess, parseListenInodes, revealProcess, activateProcess, verifyWindowVisibility, type ProcIo } from "../src/platform/linux-browser.js";
import { LinuxX11, mapStateFromAttributesReply } from "../src/platform/linux-x11.js";

const executable = "/opt/google/chrome/chrome";
const owner = (profile: string) => ({ pid: "42", executable, command: "", args: [executable, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`] });

test("Linux: 公式Chromeの導入先を探索し、空白と日本語を含むprofileを一引数で渡す", () => {
  const profile = "/home/日本語 user/.gpt-connector/browser-profile";
  const result = chromeLaunchCommand(profile, { DISPLAY: ":1" }, (candidate) => candidate === executable);
  assert.equal(result.command, executable);
  assert.ok(result.args.includes(`--user-data-dir=${profile}`));
  assert.ok(result.args.includes("--no-startup-window"));
  assert.ok(result.args.includes("--ozone-platform=x11"));
  assert.ok(result.args.every((value) => !value.includes("headless")));
  assert.ok(!result.args.includes("https://chatgpt.com/"));
  assert.throws(() => chromeLaunchCommand(profile, { DISPLAY: ":1" }, () => false), { code: "CDP_UNAVAILABLE", message: "Google Chromeが見つかりません。公式パッケージで導入してください。" });
  assert.throws(() => chromeLaunchCommand(profile, {}, (candidate) => candidate === executable), { code: "CDP_UNAVAILABLE", message: "Linuxの専用ChromeにはローカルX11のDISPLAYが必要です。" });
});

test("Linux: 実行fileと引数で専用Chromeの所有を照合する", () => {
  const profile = "/home/日本語 user/.gpt-connector/browser-profile";
  assert.equal(isOwnedChromeProcess(owner(profile), profile), true);
  assert.equal(isOwnedChromeProcess(owner(`${profile}-other`), profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), executable: "/usr/lib/chromium/chrome" }, profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), executable: "/opt/google/chrome-beta/chrome" }, profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), args: [...owner(profile).args, "--user-data-dir=/tmp/other"] }, profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), args: undefined }, profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), args: ["/usr/bin/google-chrome-stable", ...owner(profile).args.slice(1)] }, profile), true);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), args: ["/usr/lib/chromium/chrome", ...owner(profile).args.slice(1)], executable: "/usr/lib/chromium/chrome" }, profile), false);
});

test("Linux: 127.0.0.1:9223の待受inodeだけを所有候補にする", () => {
  const tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:2407 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9489 1 0000000000000000 100 0 0 10 0\n   1: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0\n";
  assert.deepEqual(parseListenInodes(tcp), [{ address: "127.0.0.1", inode: "9489" }]);
  assert.equal(parseListenInodes(tcp.replace("0100007F:2407", "00000000:2407"))[0]?.address, "0.0.0.0");
});

test("Linux: socket inodeと公式Chromeのcmdlineから所有者を読む", async () => {
  const profile = "/tmp/linux profile";
  const io: ProcIo = {
    async readText(path) {
      if (path.endsWith("/tcp6")) return "";
      return "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:2407 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9489 1 0000000000000000 100 0 0 10 0\n";
    },
    async listPids() { return ["42", "self"]; },
    async listFds(pid) { return pid === "42" ? ["3"] : []; },
    async readlink(path) { return path.endsWith("/fd/3") ? "socket:[9489]" : executable; },
    async readCmdline() { return Buffer.from(`${executable}\0--remote-debugging-address=127.0.0.1\0--remote-debugging-port=9223\0--user-data-dir=${profile}\0`); },
  };
  const listeners = await inspectListenerProcesses(io);
  assert.equal(listeners.length, 1);
  assert.equal(isOwnedChromeProcess(listeners[0]!, profile), true);
  await assert.rejects(inspectListenerProcesses({ ...io, async readText(path) { return path.endsWith("/tcp6") ? "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 00000000000000000000000000000000:2407 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0\n" : ""; } }), /待受addressが不正です/);
});

test("Linux: X11のmapStateはmapInstalledの次のbyteを読む", () => {
  const packet = Buffer.from("01000100030000001f02000001000101ffffffff00000000000002000300a0017f8063000000000000000000", "hex");
  assert.equal(mapStateFromAttributesReply(packet), 2);
});

test("Linux: 共通launcherが専用PIDの非表示と再表示をLinux adapterへ渡す", async () => {
  const home = await mkdtemp(join(tmpdir(), "gpt-linux-browser-"));
  const profile = join(home, ".gpt-connector", "browser-profile");
  const events: string[] = [];
  const options = {
    platform: "linux" as const, home, endpointReady: async () => true,
    processInspector: async () => [owner(profile)], appReady: async () => true,
    existingTargetAbsent: async () => false, windowPreparer: async () => "ready" as const,
    windowShower: async () => "normal" as const,
    processHider: async (pid: number) => { events.push(`hide:${pid}`); },
    processRevealer: async (pid: number) => { events.push(`show:${pid}`); },
    processActivator: async (pid: number) => { events.push(`activate:${pid}`); },
    windowVisibilityVerifier: async (pid: number, visible: boolean) => { events.push(`visible:${pid}:${visible}`); },
  };
  try {
    assert.equal((await startBrowser(options)).status, "already_ready");
    assert.equal((await showBrowser(options)).status, "shown");
    assert.deepEqual(events, ["hide:42", "visible:42:false", "show:42", "activate:42", "visible:42:true"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Linux: 自PIDのGoogle-chrome windowを隠してから表示し直す", { skip: process.platform !== "linux" || !process.env.DISPLAY }, async () => {
  const display = await LinuxX11.connect();
  let id = 0;
  try {
    id = await display.createProbeWindow(process.pid);
    await hideProcess(process.pid, 3_000);
    await verifyWindowVisibility(process.pid, false, 3_000);
    await revealProcess(process.pid, 3_000);
    await activateProcess(process.pid, 3_000);
    await verifyWindowVisibility(process.pid, true, 3_000);
  } finally {
    if (id !== 0) await display.destroy(id).catch(() => undefined);
    display.close();
  }
});

test("Linux: detached起動は呼出元の終了後も子と引数を残す", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpt linux lifetime "));
  const receipt = join(directory, "receipt.json");
  const child = join(directory, "child.mjs");
  const parent = join(directory, "parent.mjs");
  const args = ["日本語と 空白", "引用\"文字"];
  const adapter = new URL("../src/platform/linux-browser.ts", import.meta.url).href;
  await writeFile(child, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, args: process.argv.slice(3) })); setInterval(() => {}, 1000);\n");
  await writeFile(parent, `import { spawnDetached } from ${JSON.stringify(adapter)};\nspawnDetached(process.execPath, ${JSON.stringify([child, receipt, ...args])});\n`);
  let owned = 0;
  try {
    const code = await new Promise<number | null>((resolve) => {
      const proc = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), parent], { stdio: "ignore" });
      proc.once("exit", resolve);
    });
    assert.equal(code, 0);
    const deadline = Date.now() + 3_000;
    let body = "";
    while (Date.now() < deadline) {
      try { body = await readFile(receipt, "utf8"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    const parsed = JSON.parse(body) as { pid: number; args: string[] };
    owned = parsed.pid;
    assert.deepEqual(parsed.args, args);
    assert.equal(process.kill(owned, 0), true);
  } finally {
    if (owned !== 0) { try { process.kill(owned, "SIGTERM"); } catch { /* すでに終了 */ } }
    await rm(directory, { recursive: true, force: true });
  }
});
