import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { chromeLaunchCommand, inspectListenerProcesses, isOwnedChromeProcess } from "../src/platform/windows-browser.js";
import { startBrowser, showBrowser } from "../src/browser-launcher.js";
import { windowsPowerShell, windowsPowerShellSync } from "../src/platform/windows-powershell.js";

const executable = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const owner = () => ({ pid: "42", command: "chrome.exe", profileLock: true });

test("Windows: OSから日本語をUTF-8で取得する", { skip: process.platform !== "win32" }, async () => {
  assert.equal(windowsPowerShellSync("'日本語 user'"), "日本語 user");
  assert.equal(await windowsPowerShell("'日本語 user'"), "日本語 user");
});

test("Windows: Chromeの標準導入先を探索し、空白と日本語を含むprofileを一引数で渡す", () => {
  const profile = String.raw`C:\Users\日本語 user\.gpt-connector\browser-profile`;
  const result = chromeLaunchCommand(profile, { ProgramFiles: String.raw`C:\Program Files` }, candidate => candidate === executable);
  assert.equal(result.command, executable);
  assert.ok(result.args.includes(`--user-data-dir=${profile}`));
  assert.ok(result.args.includes("--no-startup-window"));
  assert.throws(() => chromeLaunchCommand(profile, {}, () => false), { code: "CDP_UNAVAILABLE" });
});

test("Windows: 専用profileのlockfileを持つchrome.exeだけを所有者とする", () => {
  assert.equal(isOwnedChromeProcess(owner()), true);
  assert.equal(isOwnedChromeProcess({ ...owner(), command: "CHROME.EXE" }), true);
  assert.equal(isOwnedChromeProcess({ ...owner(), profileLock: false }), false);
  assert.equal(isOwnedChromeProcess({ ...owner(), profileLock: undefined }), false);
  assert.equal(isOwnedChromeProcess({ ...owner(), command: "ssh.exe" }), false);
});

test("Windows: 9223の待受PIDが専用profileのlockfileを開いているかをfile systemから読む", { skip: process.platform !== "win32" }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "gpt-windows-lock-"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  // The Windows runner is a real host whose dedicated Chrome may own 9223.
  const port = (server.address() as AddressInfo).port;
  try {
    assert.deepEqual(await inspectListenerProcesses(profile, port), [{ pid: String(process.pid), command: "node.exe", profileLock: false }]);
    const lock = await open(join(profile, "lockfile"), "w");
    try {
      assert.deepEqual(await inspectListenerProcesses(profile, port), [{ pid: String(process.pid), command: "node.exe", profileLock: true }]);
    } finally { await lock.close(); }
    assert.deepEqual(await inspectListenerProcesses(profile, port), [{ pid: String(process.pid), command: "node.exe", profileLock: false }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});

test("Windows: 共通launcherが専用PIDの非表示と再表示をWindows adapterへ渡す", async () => {
  const home = await mkdtemp(join(tmpdir(), "gpt-windows-browser-"));
  const events: string[] = [];
  const options = {
    platform: "win32" as const, home, endpointReady: async () => true,
    processInspector: async () => [owner()], appReady: async () => true,
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
