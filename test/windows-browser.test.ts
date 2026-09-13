import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeLaunchCommand, isOwnedChromeProcess } from "../src/platform/windows-browser.js";
import { startBrowser, showBrowser } from "../src/browser-launcher.js";
import { windowsPowerShell, windowsPowerShellSync } from "../src/platform/windows-powershell.js";

const executable = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const owner = (profile: string) => ({ pid: "42", executable, command: "", args: [executable, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`] });

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

test("Windows: ネイティブ解析したargvと実行fileで所有を照合する", () => {
  const profile = String.raw`C:\Users\日本語 user\.gpt-connector\browser-profile`;
  assert.equal(isOwnedChromeProcess(owner(profile), profile.toUpperCase()), true);
  assert.equal(isOwnedChromeProcess(owner(profile + "-other"), profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), executable: "C:\\other.exe" }, profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), args: [...owner(profile).args, "--user-data-dir=C:\\other"] }, profile), false);
  assert.equal(isOwnedChromeProcess({ ...owner(profile), args: undefined }, profile), false);
});

test("Windows: 共通launcherが専用PIDの非表示と再表示をWindows adapterへ渡す", async () => {
  const home = await mkdtemp(join(tmpdir(), "gpt-windows-browser-"));
  const profile = join(home, ".gpt-connector", "browser-profile");
  const events: string[] = [];
  const options = {
    platform: "win32" as const, home, endpointReady: async () => true,
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
