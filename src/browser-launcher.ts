import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient, discoverChatGptTarget } from "./cdp.js";
import { GptConnector } from "./connector.js";
import { ConnectorError } from "./errors.js";
import { browserPlatform, type BrowserPlatform, type ListenerProcess } from "./platform/browser.js";

export interface BrowserLaunchResult { readonly ok: true; readonly status: "already_ready" | "started"; readonly endpoint: "http://127.0.0.1:9223"; }
export interface BrowserShowResult { readonly ok: true; readonly status: "shown"; readonly endpoint: "http://127.0.0.1:9223"; }
type Spawned = { readonly once: (event: "error", listener: (error: Error) => void) => unknown; };
type Spawn = (command: string, args: readonly string[]) => Spawned;
type Readiness = () => Promise<boolean>;
type ProcessInspector = () => Promise<readonly ListenerProcess[]>;
interface BrowserLock { release(): Promise<void>; }
type LockAcquirer = (profile: string, waitDeadlineMs: number) => Promise<BrowserLock>;
type WindowPreparer = () => Promise<"ready">;
type ColdTargetCreator = () => Promise<string>;
type ColdWindowVerifier = (targetId: string) => Promise<"ready">;
type WindowShower = () => Promise<"normal">;
type ProcessHider = (pid: number, timeoutMs: number) => Promise<void>;
type ProcessRevealer = (pid: number, timeoutMs: number) => Promise<void>;
type ProcessActivator = (pid: number, timeoutMs: number) => Promise<void>;
type WindowVisibilityVerifier = (pid: number, expectedVisible: boolean, timeoutMs: number) => Promise<void>;
interface BrowserOptions {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly spawn?: Spawn;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly endpointReady?: Readiness;
  readonly appReady?: Readiness;
  readonly connectorProbe?: Readiness;
  readonly processInspector?: ProcessInspector;
  readonly lockAcquirer?: LockAcquirer;
  readonly windowPreparer?: WindowPreparer;
  readonly coldTargetCreator?: ColdTargetCreator;
  readonly coldWindowVerifier?: ColdWindowVerifier;
  readonly windowShower?: WindowShower;
  readonly existingTargetAbsent?: Readiness;
  readonly processHider?: ProcessHider;
  readonly processRevealer?: ProcessRevealer;
  readonly processActivator?: ProcessActivator;
  readonly windowVisibilityVerifier?: WindowVisibilityVerifier;
  readonly probeTimeoutMs?: number;
  readonly appProbeTimeoutMs?: number;
  readonly readyDeadlineMs?: number;
  readonly ownershipProbeGraceMs?: number;
  readonly windowVisibilityGraceMs?: number;
}

const endpoint = "http://127.0.0.1:9223" as const;
const chatGptUrl = "https://chatgpt.com/";
const probeTimeoutMs = 500;
const appProbeTimeoutMs = 3_000;
const readyDeadlineMs = 30_000;
const ownershipProbeGraceMs = 3_000;
const windowVisibilityGraceMs = 5_000;
const lockWaitMarginMs = 1_000;
let inFlight: Promise<BrowserLaunchResult> | undefined;

export async function startBrowser(options: BrowserOptions = {}): Promise<BrowserLaunchResult> {
  if (inFlight === undefined) {
    inFlight = startBrowserOnce(options).finally(() => { inFlight = undefined; });
  }
  return inFlight;
}

export async function showBrowser(options: BrowserOptions = {}): Promise<BrowserShowResult> {
  const adapter = browserPlatform(options.platform);
  const { inspectListenerProcesses, revealProcess, activateProcess, verifyWindowVisibility } = adapter;
  const profile = resolve(join(options.home ?? homedir(), ".gpt-connector", "browser-profile"));
  const timeout = options.probeTimeoutMs ?? probeTimeoutMs;
  const fetcher = timedFetch(options.fetch ?? globalThis.fetch, timeout);
  const endpointReady = options.endpointReady ?? (() => endpointIsReady(fetcher));
  const inspect = ownedProcessInspector(profile, options.processInspector ?? inspectListenerProcesses, adapter);
  const ownershipReady = () => ownsEndpoint(inspect);
  if (!await bounded(endpointReady(), timeout, "CDP endpoint確認がtimeoutしました")) throw new ConnectorError("CDP_UNAVAILABLE", "専用ChromeのCDP endpointを確認できませんでした。");
  const showTimeout = options.appProbeTimeoutMs ?? appProbeTimeoutMs;
  const ownershipTimeout = Math.max(timeout, options.ownershipProbeGraceMs ?? adapter.ownershipProbeTimeoutMs ?? ownershipProbeGraceMs);
  if (!await bounded(ownershipReady(), ownershipTimeout, "CDP endpoint所有確認がtimeoutしました")) throw new ConnectorError("RUNTIME_DRIFT", "9223番ポートはgpt-connector専用profileのChromeが所有していません（ポート衝突）。");
  await showOwnedWindow(inspect, options.windowShower ?? (() => showChatGptWindow(fetcher, showTimeout)), options.processRevealer ?? revealProcess, options.processActivator ?? activateProcess, options.windowVisibilityVerifier ?? verifyWindowVisibility, showTimeout, "専用Chromeを表示可能状態へ復帰できませんでした。", "CDP_UNAVAILABLE");
  return { ok: true, status: "shown", endpoint };
}

async function startBrowserOnce(options: BrowserOptions): Promise<BrowserLaunchResult> {
  const adapter = browserPlatform(options.platform);
  const profile = resolve(join(options.home ?? homedir(), ".gpt-connector", "browser-profile"));
  await (adapter.prepareProfile ?? ensurePrivateProfile)(profile);
  const lockWaitDeadlineMs = (options.readyDeadlineMs ?? readyDeadlineMs) + lockWaitMarginMs;
  let lock: BrowserLock;
  try {
    lock = await (options.lockAcquirer ?? acquireBrowserLock)(profile, lockWaitDeadlineMs);
  } catch (error) {
    throw launcherError("CDP_UNAVAILABLE", "専用Chrome起動lockを取得できませんでした。", error);
  }
  let result: BrowserLaunchResult | undefined;
  let launchError: unknown;
  try {
    result = await startBrowserLocked(options, profile, adapter);
  } catch (error) {
    launchError = error;
  }
  try {
    await lock.release();
  } catch (error) {
    if (launchError === undefined) throw launcherError("CDP_UNAVAILABLE", "専用Chrome起動lockを解放できませんでした。", error);
  }
  if (launchError !== undefined) throw launchError;
  return result!;
}

async function startBrowserLocked(options: BrowserOptions, profile: string, adapter: BrowserPlatform): Promise<BrowserLaunchResult> {
  const { chromeLaunchCommand, spawnDetached, hideProcess, revealProcess, activateProcess, verifyWindowVisibility } = adapter;
  const timeout = options.probeTimeoutMs ?? probeTimeoutMs;
  const appTimeout = options.appProbeTimeoutMs ?? appProbeTimeoutMs;
  const deadline = options.readyDeadlineMs ?? readyDeadlineMs;
  const ownershipGrace = options.ownershipProbeGraceMs ?? adapter.ownershipProbeTimeoutMs ?? ownershipProbeGraceMs;
  const visibilityGrace = options.windowVisibilityGraceMs ?? windowVisibilityGraceMs;
  const fetcher = timedFetch(options.fetch ?? globalThis.fetch, timeout);
  const endpointReady = options.endpointReady ?? (() => endpointIsReady(fetcher));
  const processInspector = ownedProcessInspector(profile, options.processInspector ?? adapter.inspectListenerProcesses, adapter);
  const ownershipReady = () => ownsEndpoint(processInspector);
  const appReady = options.appReady ?? options.connectorProbe ?? (() => ready(fetcher, timeout, appTimeout));
  const windowPreparer = options.windowPreparer ?? (() => prepareChatGptWindow(fetcher, appTimeout));
  const coldTargetCreator = options.coldTargetCreator ?? (() => createBackgroundChatGptTarget(fetcher, appTimeout));
  const coldWindowVerifier = options.coldWindowVerifier ?? ((targetId) => verifyCreatedChatGptWindow(fetcher, appTimeout, targetId));
  const windowShower = options.windowShower ?? (() => showChatGptWindow(fetcher, appTimeout));
  const existingTargetAbsent = options.existingTargetAbsent ?? (() => chatGptTargetAbsent(fetcher));
  const processHider = options.processHider ?? hideProcess;
  const processRevealer = options.processRevealer ?? revealProcess;
  const visibilityVerifier = options.windowVisibilityVerifier ?? verifyWindowVisibility;
  const processActivator = options.processActivator ?? activateProcess;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const readyDeadline = Date.now() + deadline;
  const visibilityTimeout = () => Math.max(visibilityGrace, Math.max(1, readyDeadline - Date.now()));
  const authShow = () => showOwnedWindow(processInspector, windowShower, processRevealer, processActivator, visibilityVerifier, visibilityTimeout(), "認証復帰のため専用Chrome windowを表示できませんでした。", "AUTH_REQUIRED");

  const endpointExists = await bounded(endpointReady(), timeout, "CDP endpoint確認がtimeoutしました")
    .catch((error: unknown) => { throw launcherError("CDP_UNAVAILABLE", "CDP endpointを確認できませんでした。", error); });
  if (endpointExists) {
    const owned = await bounded(ownershipReady(), Math.max(timeout, ownershipGrace), "既存CDP endpointの所有確認がtimeoutしました")
      .catch((error: unknown) => { throw launcherError("CDP_UNAVAILABLE", "既存CDP endpointの所有者を確認できませんでした。", error); });
    if (!owned) {
      throw new ConnectorError("RUNTIME_DRIFT", "9223番ポートはgpt-connector専用profileのChromeが所有していません（ポート衝突）。");
    }
    if (await existingTargetAbsent()) {
      await createAndVerifyTarget(coldTargetCreator, coldWindowVerifier);
      const pid = await hideOwnedProcess(processInspector, processHider, Math.max(1, readyDeadline - Date.now()));
      const result = await waitForReadyWithAuthRecovery(appReady, sleep, appTimeout, Math.max(1, readyDeadline - Date.now()), authShow, "already_ready"); await visibilityVerifier(await stableOwnedListenerPid(processInspector, pid), false, visibilityTimeout()); return result;
    }
    await prepareReadyWindow(windowPreparer);
    const pid = await hideOwnedProcess(processInspector, processHider, Math.max(1, readyDeadline - Date.now()));
    const result = await waitForReadyWithAuthRecovery(appReady, sleep, appTimeout, Math.max(1, readyDeadline - Date.now()), authShow, "already_ready"); await visibilityVerifier(await stableOwnedListenerPid(processInspector, pid), false, visibilityTimeout()); return result;
  }

  const launch = chromeLaunchCommand(profile);
  const spawn = options.spawn ?? spawnDetached;
  try { await spawnError(spawn(launch.command, launch.args)); } catch (error) { throw launcherError("CDP_UNAVAILABLE", "専用Chromeを起動できませんでした。", error); }
  if (!await waitForOwnedEndpoint(endpointReady, ownershipReady, sleep, Math.max(timeout, adapter.ownershipProbeTimeoutMs ?? 0), Math.max(1, readyDeadline - Date.now()))) {
    throw new ConnectorError("CDP_UNAVAILABLE", "専用ChromeのCDP endpointと所有者を確認できるまで待機がtimeoutしました。");
  }
  await createAndVerifyTarget(coldTargetCreator, coldWindowVerifier);
  const pid = await hideOwnedProcess(processInspector, processHider, Math.max(1, readyDeadline - Date.now()));
  const result = await waitForReadyWithAuthRecovery(appReady, sleep, appTimeout, Math.max(1, readyDeadline - Date.now()), authShow, "started"); await visibilityVerifier(await stableOwnedListenerPid(processInspector, pid), false, visibilityTimeout()); return result;
}

async function createAndVerifyTarget(create: ColdTargetCreator, verify: ColdWindowVerifier): Promise<void> { try { const targetId = await create(); if (targetId.length === 0) throw new Error("CDP targetIdが不正です"); if (await verify(targetId) !== "ready") throw new Error("CDP windowを確認できません"); } catch (error) { throw browserWindowError("専用ChromeのChatGPT targetを作成・確認できませんでした。", error); } }
async function showOwnedWindow(inspect: ProcessInspector, shower: WindowShower, reveal: ProcessRevealer, activate: ProcessActivator, verify: WindowVisibilityVerifier, timeoutMs: number, message: string, code: "AUTH_REQUIRED" | "CDP_UNAVAILABLE"): Promise<void> { try { await shower(); const pid = await ownedListenerPid(inspect); await reveal(pid, timeoutMs); await activate(pid, timeoutMs); await verify(pid, true, timeoutMs); } catch (error) { throw new ConnectorError(code, message, undefined, { cause: error }); } }
async function waitForReadyWithAuthRecovery(appReady: Readiness, sleep: (milliseconds: number) => Promise<void>, timeout: number, deadline: number, recover: () => Promise<void>, status: BrowserLaunchResult["status"]): Promise<BrowserLaunchResult> {
  try {
    if (await waitForApp(appReady, sleep, timeout, deadline)) return { ok: true, status, endpoint };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "AUTH_REQUIRED") {
      await recover();
    }
    throw error;
  }
  throw new ConnectorError("CDP_UNAVAILABLE", "専用ChromeのChatGPTが利用可能になるまで待機がtimeoutしました。");
}

function launcherError(code: "CDP_UNAVAILABLE" | "RUNTIME_DRIFT", message: string, cause: unknown): ConnectorError {
  return cause instanceof ConnectorError ? cause : new ConnectorError(code, message, undefined, { cause });
}

async function prepareReadyWindow(prepare: WindowPreparer): Promise<void> {
  try {
    if (await prepare() !== "ready") throw new Error("CDP windowを確認できません");
  } catch (error) {
    throw browserWindowError("専用ChromeのChatGPT windowを確認できませんでした。", error);
  }
}

function browserWindowError(message: string, cause: unknown): ConnectorError {
  if (cause instanceof ConnectorError) {
    if (cause.code === "CDP_UNAVAILABLE" || cause.code === "RUNTIME_DRIFT") return cause;
    if (cause.code === "CHAT_FAILED") return new ConnectorError("RUNTIME_DRIFT", message, undefined, { cause });
  }
  return new ConnectorError("RUNTIME_DRIFT", message, undefined, { cause });
}

interface WindowForTarget { readonly windowId?: unknown; }
interface WindowBounds { readonly bounds?: { readonly windowState?: unknown; }; }
interface BrowserVersion { readonly webSocketDebuggerUrl?: unknown; }
interface CreatedTarget { readonly targetId?: unknown; }
async function prepareChatGptWindow(fetcher: typeof globalThis.fetch, timeoutMs: number): Promise<"ready"> {
  const target = await discoverChatGptTarget(endpoint, fetcher);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, timeoutMs);
  try {
    const window = await client.call<WindowForTarget>("Browser.getWindowForTarget", { targetId: target.id }, timeoutMs);
    if (typeof window.windowId !== "number") throw new Error("CDP windowIdが不正です");
    const before = await client.call<WindowBounds>("Browser.getWindowBounds", { windowId: window.windowId }, timeoutMs);
    const state = before.bounds?.windowState;
    if (state !== "normal" && state !== "maximized" && state !== "minimized" && state !== "fullscreen") throw new Error("CDP windowStateが不正です");
    return "ready";
  } finally {
    client.close();
  }
}

async function showChatGptWindow(fetcher: typeof globalThis.fetch, timeoutMs: number): Promise<"normal"> {
  const target = await discoverChatGptTarget(endpoint, fetcher);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, timeoutMs);
  try {
    const window = await client.call<WindowForTarget>("Browser.getWindowForTarget", { targetId: target.id }, timeoutMs);
    if (typeof window.windowId !== "number") throw new Error("CDP windowIdが不正です");
    const before = await client.call<WindowBounds>("Browser.getWindowBounds", { windowId: window.windowId }, timeoutMs);
    if (!["minimized", "maximized", "fullscreen", "normal"].includes(String(before.bounds?.windowState))) throw new Error("CDP windowStateが不正です");
    await client.call("Browser.setWindowBounds", { windowId: window.windowId, bounds: { windowState: "normal" } }, timeoutMs);
    await client.call("Page.bringToFront", {}, timeoutMs);
    return "normal";
  } finally { client.close(); }
}

async function createBackgroundChatGptTarget(fetcher: typeof globalThis.fetch, timeoutMs: number): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(`${endpoint}/json/version`);
  } catch (error) {
    throw new ConnectorError("CDP_UNAVAILABLE", "CDP browser endpointを取得できませんでした。", undefined, { cause: error });
  }
  if (!response.ok) throw new Error("CDP browser endpointを取得できませんでした");
  const version = await response.json() as BrowserVersion;
  if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("CDP browser WebSocket URLが不正です");
  const client = await CdpClient.connect(version.webSocketDebuggerUrl, timeoutMs);
  try {
    const created = await client.call<CreatedTarget>("Target.createTarget", { url: chatGptUrl, newWindow: true, background: true, windowState: "minimized" }, timeoutMs);
    if (typeof created.targetId !== "string" || created.targetId.length === 0) throw new Error("CDP targetIdが不正です");
    return created.targetId;
  } finally {
    client.close();
  }
}

async function verifyCreatedChatGptWindow(fetcher: typeof globalThis.fetch, timeoutMs: number, targetId: string): Promise<"ready"> {
  const target = await discoverChatGptTarget(endpoint, fetcher);
  if (target.id !== targetId) throw new Error("作成したChatGPT targetと一致しません");
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, timeoutMs);
  try {
    const window = await client.call<WindowForTarget>("Browser.getWindowForTarget", { targetId }, timeoutMs);
    if (typeof window.windowId !== "number") throw new Error("CDP windowIdが不正です");
    const result = await client.call<WindowBounds>("Browser.getWindowBounds", { windowId: window.windowId }, timeoutMs);
    if (!["normal", "maximized", "minimized", "fullscreen"].includes(String(result.bounds?.windowState))) throw new Error("CDP windowStateが不正です");
    return "ready";
  } finally {
    client.close();
  }
}

function timedFetch(fetcher: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function waitForApp(appReady: Readiness, sleep: (milliseconds: number) => Promise<void>, timeoutMs: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  let lastRuntimeDrift: ConnectorError | undefined;
  while (Date.now() < deadline) {
    try {
      if (await bounded(appReady(), Math.min(timeoutMs, Math.max(1, deadline - Date.now())), "ChatGPT app確認がtimeoutしました")) return true;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "AUTH_REQUIRED") throw error;
      if (error instanceof ConnectorError && error.code === "RUNTIME_DRIFT") lastRuntimeDrift = error;
      // SPA初期化中のbridge/catalog probe timeoutは全体deadlineまで再試行する。
    }
    await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
  if (lastRuntimeDrift !== undefined) throw lastRuntimeDrift;
  return false;
}

async function waitForOwnedEndpoint(endpointReady: Readiness, ownershipReady: Readiness, sleep: (milliseconds: number) => Promise<void>, timeoutMs: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      if (await bounded(endpointReady(), Math.min(timeoutMs, remaining), "CDP endpoint確認がtimeoutしました")
        && await bounded(ownershipReady(), Math.min(timeoutMs, remaining), "CDP endpoint所有確認がtimeoutしました")) return true;
    } catch {
      // ChromeのCDP起動中は全体deadlineまで再試行する。
    }
    await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
  return false;
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function endpointIsReady(fetcher: typeof globalThis.fetch): Promise<boolean> { try { return (await fetcher(`${endpoint}/json/version`)).ok; } catch { return false; } }
async function chatGptTargetAbsent(fetcher: typeof globalThis.fetch): Promise<boolean> {
  const response = await fetcher(`${endpoint}/json/list`);
  if (!response.ok) throw new ConnectorError("CDP_UNAVAILABLE", "CDP target一覧の取得に失敗しました。");
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new ConnectorError("RUNTIME_DRIFT", "CDP target一覧の形式が不正です。");
  const count = raw.filter((value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "page" && (() => { try { return new URL(String((value as { url?: unknown }).url)).origin === "https://chatgpt.com"; } catch { return false; } })()).length;
  if (count > 1) throw new ConnectorError("CDP_UNAVAILABLE", "ChatGPT page targetが複数あります。専用Chromeでは1tabだけ開いてください。");
  return count === 0;
}
function ownedProcessInspector(profile: string, inspect: ProcessInspector, adapter: BrowserPlatform): ProcessInspector {
  return async () => {
    const listeners = await inspect();
    return listeners.length === 1 && adapter.isOwnedChromeProcess(listeners[0]!, profile) ? listeners : [];
  };
}
async function ownsEndpoint(inspect: ProcessInspector): Promise<boolean> {
  try {
    const listeners = await inspect();
    return listeners.length === 1 && /^\d+$/.test(listeners[0]!.pid);
  } catch { return false; }
}
async function ownedListenerPid(inspect: ProcessInspector): Promise<number> {
  const listeners = await inspect();
  if (listeners.length !== 1 || !/^\d+$/.test(listeners[0]!.pid)) throw new ConnectorError("RUNTIME_DRIFT", "9223番ポートはgpt-connector専用profileのChromeが所有していません（ポート衝突）。");
  return Number(listeners[0]!.pid);
}
async function stableOwnedListenerPid(inspect: ProcessInspector, expectedPid: number): Promise<number> { const pid = await ownedListenerPid(inspect); if (pid !== expectedPid) throw new ConnectorError("RUNTIME_DRIFT", "専用Chromeの9223所有PIDが起動中に交代しました。"); return pid; }
async function hideOwnedProcess(inspect: ProcessInspector, hide: ProcessHider, timeoutMs: number): Promise<number> {
  const pid = await ownedListenerPid(inspect);
  try { await hide(pid, timeoutMs); return pid; } catch (error) { throw launcherError("CDP_UNAVAILABLE", "専用Chromeをhidden状態へ移行できませんでした。", error); }
}
async function acquireBrowserLock(profile: string, waitDeadlineMs: number): Promise<BrowserLock> {
  const file = join(profile, "browser-launch.lock");
  const deadline = Date.now() + waitDeadlineMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return { release: async () => { const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile()) throw new Error("browser launch lockが不正です"); await unlink(file); } };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("browser launch lockが不正です", { cause: error });
      const pid = (await readFile(file, "utf8")).trim();
      if (!/^\d+$/.test(pid)) throw new Error("browser launch lockのPIDが不正です", { cause: error });
      if (!isLiveProcess(Number(pid))) { await unlink(file); continue; }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("browser launch lockの取得がtimeoutしました");
}
function isLiveProcess(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: unknown) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
async function ready(fetcher: typeof globalThis.fetch, cdpTimeoutMs: number, operationTimeoutMs: number): Promise<boolean> { let connector: GptConnector | undefined; try { connector = await GptConnector.connect({ endpoint, fetch: fetcher, cdpTimeoutMs, operationTimeoutMs, pollIntervalMs: 100, readOnlyJobs: true }); await connector.models(); return true; } catch (error) { if (error instanceof ConnectorError && (error.code === "AUTH_REQUIRED" || error.code === "RUNTIME_DRIFT")) throw error; return false; } finally { connector?.close(); } }
async function spawnError(child: Spawned): Promise<void> { await new Promise<void>((resolve, reject) => { child.once("error", reject); setTimeout(resolve, 0); }); }
async function ensurePrivateProfile(profile: string): Promise<void> { try { const info = await lstat(profile); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("browser profile pathが不正です"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(profile, { recursive: true, mode: 0o700 }); } await chmod(profile, 0o700); }
