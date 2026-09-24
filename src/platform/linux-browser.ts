// Linuxの公式Chrome探索、127.0.0.1:9223の所有確認、X11 window制御を所有する。
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { posix } from "node:path";
import { ConnectorError } from "../errors.js";
import type { ListenerProcess, SpawnedChild } from "./browser.js";
import { LinuxX11 } from "./linux-x11.js";

const chromeCandidates = ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];
const listenState = "0A";

export interface ProcIo {
  readText(path: string): Promise<string>;
  listPids(): Promise<readonly string[]>;
  listFds(pid: string): Promise<readonly string[]>;
  readlink(path: string): Promise<string>;
  readCmdline(pid: string): Promise<Buffer>;
}

export function chromeLaunchCommand(profile: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync) {
  const command = chromeCandidates.find((candidate) => exists(candidate));
  if (!command) throw new ConnectorError("CDP_UNAVAILABLE", "Google Chromeが見つかりません。公式パッケージで導入してください。");
  if (!env.DISPLAY) throw new ConnectorError("CDP_UNAVAILABLE", "Linuxの専用ChromeにはローカルX11のDISPLAYが必要です。");
  return { command, args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", `--user-data-dir=${profile}`, "--no-startup-window", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11"] };
}

export function spawnDetached(command: string, args: readonly string[]): SpawnedChild {
  const env = { ...process.env };
  if (env.DISPLAY && !env.XAUTHORITY) {
    const authority = `${userInfo().homedir}/.Xauthority`;
    if (existsSync(authority)) env.XAUTHORITY = authority;
  }
  const child = nodeSpawn(command, args, { detached: true, stdio: "ignore", env });
  child.unref();
  return child;
}

export function isOwnedChromeProcess(listener: ListenerProcess, profile: string): boolean {
  const args = listener.args;
  if (!listener.executable || !isOfficialChrome(listener.executable) || !args) return false;
  if (!matchesChromeArgv0(args[0], listener.executable)) return false;
  const values = (key: string) => args.filter((arg) => arg.startsWith(`${key}=`));
  return values("--remote-debugging-address").length === 1 && args.includes("--remote-debugging-address=127.0.0.1")
    && values("--remote-debugging-port").length === 1 && args.includes("--remote-debugging-port=9223")
    && values("--user-data-dir").length === 1
    && posix.normalize(values("--user-data-dir")[0]!.slice("--user-data-dir=".length)) === posix.normalize(profile);
}

export function parseListenInodes(text: string, port = 9223): readonly { readonly address: string; readonly inode: string }[] {
  const listeners = [];
  for (const line of text.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    const local = parts[1];
    const state = parts[3];
    const inode = parts[9];
    if (!local || !state || !inode || state.toUpperCase() !== listenState) continue;
    const [address, portHex] = local.split(":");
    if (!address || !portHex || Number.parseInt(portHex, 16) !== port) continue;
    listeners.push({ address: ipv4(address), inode });
  }
  return listeners;
}

export async function inspectListenerProcesses(io: ProcIo = realProcIo): Promise<readonly ListenerProcess[]> {
  const ipv4Text = await io.readText("/proc/net/tcp");
  const ipv6Text = await io.readText("/proc/net/tcp6").catch(() => "");
  if (parseListenInodes(ipv6Text).length > 0) throw new Error("専用CDPの待受addressが不正です");
  const listeners = parseListenInodes(ipv4Text);
  if (listeners.some((listener) => listener.address !== "127.0.0.1")) throw new Error("専用CDPの待受addressが不正です");
  if (listeners.length === 0) return [];
  const inodes = new Set(listeners.map((listener) => listener.inode));
  const processes = [];
  for (const pid of await io.listPids()) {
    if (!/^\d+$/.test(pid)) continue;
    let owns = false;
    try {
      for (const fd of await io.listFds(pid)) {
        try { if (inodes.has(socketInode(await io.readlink(`/proc/${pid}/fd/${fd}`)))) owns = true; } catch { /* 閉じたfdは読み飛ばす */ }
      }
    } catch { continue; }
    if (!owns) continue;
    let executable: string;
    let args: string[];
    try {
      executable = await io.readlink(`/proc/${pid}/exe`);
      args = (await io.readCmdline(pid)).toString("utf8").split("\0").filter((arg) => arg.length > 0);
    } catch { throw new Error("専用Chromeのprocess情報を取得できません"); }
    processes.push({ pid, command: args.join(" "), executable, args });
  }
  if (processes.length === 0) throw new Error("専用Chromeのprocess情報を取得できません");
  return processes;
}

export const hideProcess = (pid: number, timeout: number) => windowAction(pid, "hide", timeout);
export const revealProcess = (pid: number, timeout: number) => windowAction(pid, "show", timeout);
export const activateProcess = (pid: number, timeout: number) => windowAction(pid, "activate", timeout);
export async function verifyWindowVisibility(pid: number, visible: boolean, timeout: number): Promise<void> {
  try { await windowAction(pid, visible ? "visible" : "hidden", timeout); }
  catch (cause) { throw new ConnectorError("RUNTIME_DRIFT", "専用ChromeのLinux表示状態を確認できませんでした。", undefined, { cause }); }
}

export function chromeOwnerPids(rootPid: number, listPids: () => readonly string[] = () => {
  try { return readdirSync("/proc"); } catch { return []; }
}, readStatus: (pid: string) => string | undefined = (pid) => {
  try { return readFileSync(`/proc/${pid}/status`, "utf8"); } catch { return undefined; }
}): Set<number> {
  const children = new Map<number, number[]>();
  for (const pidText of listPids()) {
    if (!/^\d+$/.test(pidText)) continue;
    const status = readStatus(pidText);
    const parent = status ? Number(/^PPid:\s*(\d+)/m.exec(status)?.[1]) : Number.NaN;
    if (!Number.isSafeInteger(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(Number(pidText));
    children.set(parent, list);
  }
  const owned = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (owned.has(child)) continue;
      owned.add(child);
      queue.push(child);
    }
  }
  return owned;
}

async function windowAction(pid: number, action: "hide" | "show" | "activate" | "visible" | "hidden", timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("PIDが不正です");
  const owners = chromeOwnerPids(pid);
  let display = await LinuxX11.connectForChrome(pid, owners).catch((cause: unknown) => { throw new Error("X11へ接続できませんでした。", { cause }); });
  const wantVisible = action === "show" || action === "activate" || action === "visible";
  try {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let sawWindow = false;
    do {
      let windows = await display.googleChromeWindows(owners);
      if (windows.length === 0) {
        const next = await LinuxX11.connectForChrome(pid, owners);
        display.close();
        display = next;
        windows = await display.googleChromeWindows(owners);
      }
      if (windows.length > 0) sawWindow = true;
      if (action === "hide") for (const window of windows) if (window.viewable) await display.unmap(window.id);
      if (action === "show") for (const window of windows) if (!window.viewable) await display.map(window.id);
      if (action === "show" || action === "activate") {
        const target = windows.find((window) => window.viewable) ?? windows[0];
        if (target) await display.activate(target.id);
      }
      windows = await display.googleChromeWindows(owners);
      if (windows.length > 0) sawWindow = true;
      const viewable = windows.filter((window) => window.viewable).length;
      if (sawWindow && windows.length > 0 && (wantVisible ? viewable > 0 : viewable === 0)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
    throw new Error(sawWindow ? "専用Chromeの表示状態が収束しません" : `専用Chromeのwindowがありません（探索DISPLAY=${display.display}）`);
  } finally { display.close(); }
}

function isOfficialChrome(executable: string): boolean {
  const parts = posix.normalize(executable).split("/");
  if (parts.at(-1) !== "chrome" || executable.endsWith(" (deleted)")) return false;
  return parts.some((part, index) => part === "opt" && parts[index + 1] === "google" && parts[index + 2] === "chrome");
}

function matchesChromeArgv0(arg: string | undefined, executable: string): boolean {
  if (!arg) return false;
  if (posix.normalize(arg) === posix.normalize(executable)) return true;
  const base = posix.basename(arg);
  return base === "chrome" || base === "google-chrome" || base === "google-chrome-stable";
}

function ipv4(hex: string): string {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return "";
  const value = Number.parseInt(hex, 16);
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff].join(".");
}

function socketInode(target: string): string { return /^socket:\[(\d+)\]$/.exec(target)?.[1] ?? ""; }

const realProcIo: ProcIo = {
  readText: (path) => readFile(path, "utf8"),
  listPids: () => readdir("/proc"),
  listFds: (pid) => readdir(`/proc/${pid}/fd`),
  readlink: (path) => readlink(path),
  readCmdline: (pid) => readFile(`/proc/${pid}/cmdline`),
};
