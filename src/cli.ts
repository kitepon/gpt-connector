#!/usr/bin/env node

import { GptConnector } from "./connector.js";
import { GrokConnector } from "./grok-connector.js";
import { ConsultJobStore } from "./consult-job-store.js";
import { ConnectorError } from "./errors.js";
import { factoryDiagnostics } from "./factory-diagnostics.js";
import {
  acknowledgeRuntimeErrors,
  compactRuntimeErrors,
  getRuntimeErrorDiagnostics,
  readRuntimeErrorSnapshot,
  reopenRuntimeError,
  recordRuntimeErrorBestEffort,
  resolveRuntimeError,
  runtimeErrorStoreDiagnostic,
} from "./runtime-error-store.js";
import { packageVersion } from "./version.js";
import { showBrowser, startBrowser } from "./browser-launcher.js";
import { setup } from "./setup.js";
import { setupClients, type SetupClient } from "./setup-registration.js";
import { installSetupPackage } from "./platform/setup-package.js";
import { isAbsolute, join } from "node:path";
import { configureCodexSteer, type CodexSteerAction } from "./setup-codex-steer.js";
import { CodexSteerSetupError } from "./codex-steer-config.js";
import { CodexDeliveryError } from "./codex-delivery-error.js";
import { receiveCursorAnswer } from "./cursor-parent.js";
import { handleCursorHookInput } from "./cursor-hook.js";
import { defaultConsultStateDirectory } from "./platform/state.js";

interface ParsedArgs {
  readonly command: string | undefined;
  readonly values: ReadonlyMap<string, readonly string[] | true>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const [command, ...rest] = args;
  const values = new Map<string, string[] | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]!;
    if (!current.startsWith("--")) throw new Error(`不明な引数: ${current}`);
    const key = current.slice(2);
    const next = rest[index + 1];
    const existing = values.get(key);
    if (next === undefined || next.startsWith("--")) {
      if (existing !== undefined) throw new Error(`重複したflag: --${key}`);
      values.set(key, true);
    } else {
      if (existing === true) throw new Error(`値とflagを混在できません: --${key}`);
      values.set(key, [...(existing ?? []), next]);
      index += 1;
    }
  }
  return { command, values };
}

function stringArg(
  values: ReadonlyMap<string, readonly string[] | true>,
  name: string,
): string | undefined {
  const value = values.get(name);
  if (value === undefined) return undefined;
  if (value === true || value.length !== 1) throw new Error(`--${name}は1つの値が必要です。`);
  return value[0];
}

function stringArgs(
  values: ReadonlyMap<string, readonly string[] | true>,
  name: string,
): string[] | undefined {
  const value = values.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name}には値が必要です。`);
  return [...value];
}

function flagArg(
  values: ReadonlyMap<string, readonly string[] | true>,
  name: string,
): boolean {
  const value = values.get(name);
  if (value === undefined) return false;
  if (value !== true) throw new Error(`--${name}は値なしflagです。`);
  return true;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "setup" && argv[1] === "--help" && argv.length === 2) {
    process.stdout.write("usage: gpt-connector setup [--ai claude,codex,grok,cursor] [--codex-config <absolute-config.toml>] [--check] [--codex-steer enable|status|disable]\n");
    return;
  }
  if (argv[0] === "setup") {
    const { values } = parseArgs(argv);
    if ([...values.keys()].some((key) => !["ai", "codex-config", "check", "codex-steer"].includes(key))) throw new Error("setupの引数が不正です。");
    const steer = stringArg(values, "codex-steer");
    if (steer && (!["enable", "status", "disable"].includes(steer) || values.has("check"))) throw new Error("--codex-steerはenable/status/disableを指定し、--checkとは併用しません。");
    if (steer === "status" || steer === "disable") {
      if (values.size !== 1) throw new Error("Steerの確認・解除は単独で指定してください。");
      try {
        const result = await configureCodexSteer(steer as CodexSteerAction);
        writeJson({ schema: "gpt-connector.codex-steer.v1", ...result });
        process.exitCode = result.status === "ready" || result.status === "disabled" ? 0 : result.status === "restart_required" ? 3 : 1;
      } catch (error) {
        writeJson({ schema: "gpt-connector.codex-steer.v1", status: "failed", reason_code: error instanceof CodexSteerSetupError ? error.reasonCode : "codex_steer_failed" });
        process.exitCode = 1;
      }
      return;
    }
    const clients = stringArg(values, "ai")?.split(",") ?? [...setupClients];
    if (steer === "enable" && !clients.includes("codex")) throw new Error("Steer導入にはCodexを含めてください。");
    if (clients.length === 0 || clients.some((client) => !setupClients.includes(client as SetupClient))) throw new Error("--aiはclaude,codex,grok,cursorから指定してください。");
    const check = flagArg(values, "check");
    const codexConfig = stringArg(values, "codex-config");
    if (codexConfig !== undefined && (!isAbsolute(codexConfig) || !clients.includes("codex"))) throw new Error("--codex-configはCodex設定の絶対pathが必要です。");
    let installed: number | null;
    try { installed = check ? null : installSetupPackage(argv.slice(1)); } catch {
      writeJson({ schema: "gpt-connector.setup.v1", overall: "failed", stage: "package", code: "SETUP_PACKAGE_FAILED" });
      process.exitCode = 1;
      return;
    }
    if (installed !== null) { process.exitCode = installed; return; }
    const result = await setup({ clients: [...new Set(clients)] as SetupClient[], codexConfig, check });
    writeJson(result);
    process.exitCode = result.overall === "ready" ? 0 : result.overall === "partial" ? 2 : 1;
    return;
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write("usage: gpt-connector setup [--check] [--ai claude,codex,grok,cursor] | --version | browser <start|show> [--provider grok] | models | doctor | factory-diagnostics --json | chat --prompt <text> [--level <段階名>] | image --prompt <text> --slug <id> --workspace-root <abs> --output <relative.png> --model <id> | consult --prompt <text> --slug <id> [--level <段階名>] [--keep-open] [--session-id <uuid>] | sessions --slug <id> | close --session-id <uuid> | grok-modes | grok-doctor | grok-chat --prompt <text> | grok-consult --prompt <text> --slug <id> | grok-sessions --slug <id> | grok-close --session-id <uuid>\n");
    return;
  }
  if (argv[0] === "runtime-errors") {
    writeJson(runtimeErrors(argv.slice(1)));
    return;
  }
  if (argv[0] === "browser") {
    if (!["start", "show"].includes(argv[1]!) ||
        !(argv.length === 2 || (argv.length === 4 && argv[2] === "--provider" && argv[3] === "grok"))) {
      throw new Error("usage: gpt-connector browser <start|show> [--provider grok]");
    }
    const provider = argv[3] === "grok" ? "grok" : "chatgpt";
    writeJson(argv[1] === "start" ? await startBrowser({ provider }) : await showBrowser({ provider }));
    return;
  }
  const { command, values } = parseArgs(argv);
  if (command === "--version" || command === "version") {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }

  const endpoint = stringArg(values, "endpoint") ?? "http://127.0.0.1:9223";
  const stateDirectory = stringArg(values, "state-directory") ??
    process.env.GPT_CONNECTOR_STATE_DIR;
  if (command === "factory-diagnostics") {
    if (!flagArg(values, "json") || values.size !== 1) {
      throw new Error("usage: gpt-connector factory-diagnostics --json");
    }
    const diagnostics = await factoryDiagnostics({ endpoint, stateDirectory });
    writeJson(diagnostics);
    if (diagnostics.overall !== "ready") process.exitCode = 1;
    return;
  }
  if (command === "sessions") {
    const slug = stringArg(values, "slug");
    if (slug === undefined) throw new Error("sessionsには--slugが必要です。");
    const store = new ConsultJobStore({ stateDirectory, readOnly: true });
    await store.initialize();
    try {
      writeJson(store.get(slug));
    } finally {
      store.close();
    }
    return;
  }
  if (command === "grok-sessions") {
    const slug = stringArg(values, "slug");
    if (slug === undefined) throw new Error("grok-sessionsには--slugが必要です。");
    const store = new ConsultJobStore({ stateDirectory: join(stateDirectory ?? defaultConsultStateDirectory(), "grok"), readOnly: true });
    await store.initialize();
    try { writeJson(store.get(slug)); } finally { store.close(); }
    return;
  }
  if (command === "cursor-hook") {
    const root = stateDirectory ?? defaultConsultStateDirectory();
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const result = await handleCursorHookInput(raw.length > 0 ? raw : "{}", root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "cursor-receive") {
    const delivery = stringArg(values, "delivery");
    if (delivery === undefined) throw new Error("cursor-receiveには--deliveryが必要です。");
    const root = stateDirectory ?? defaultConsultStateDirectory();
    const parent = { socketRoot: join(root, "cp") };
    try {
      const message = await receiveCursorAnswer(parent, delivery);
      writeJson({
        deliveryId: message.deliveryId,
        outcome: message.outcome,
        text: message.text,
      });
      process.exitCode = message.outcome === "succeeded" ? 0 : 1;
    } catch (error) {
      const unknown = error instanceof CodexDeliveryError && error.outcomeUnknown;
      writeJson({
        deliveryId: delivery,
        outcome: "unknown",
        error: unknown ? "PARENT_DELIVERY_UNKNOWN" : "PARENT_DELIVERY_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 2;
    }
    return;
  }
  if (command === "doctor" || command === "diagnostics") {
    const diagnostics = await GptConnector.doctor({ endpoint, stateDirectory });
    writeJson(diagnostics);
    if (diagnostics.overall !== "ready") process.exitCode = 1;
    return;
  }
  if (["grok-modes", "grok-doctor", "grok-chat", "grok-consult", "grok-close"].includes(command ?? "")) {
    if (command === "grok-doctor") {
      const diagnostics = await GrokConnector.doctor({ endpoint, stateDirectory });
      writeJson(diagnostics);
      if (diagnostics.overall !== "ready") process.exitCode = 1;
      return;
    }
    if (endpoint === "http://127.0.0.1:9223") await startBrowser({ provider: "grok", stateDirectory });
    const grok = await GrokConnector.connect({ endpoint, stateDirectory });
    try {
      if (command === "grok-modes") writeJson(await grok.modes());
      else if (command === "grok-chat") {
        const prompt = stringArg(values, "prompt");
        if (!prompt) throw new Error("grok-chatには--promptが必要です。");
        writeJson(await grok.chat({ prompt, sessionId: stringArg(values, "session-id"), keepOpen: flagArg(values, "keep-open") }));
      } else if (command === "grok-consult") {
        const prompt = stringArg(values, "prompt");
        const slug = stringArg(values, "slug");
        if (!prompt || !slug) throw new Error("grok-consultには--promptと--slugが必要です。");
        const result = await grok.consult({ prompt, slug, sessionId: stringArg(values, "session-id"),
          keepOpen: flagArg(values, "keep-open"), dryRun: flagArg(values, "dry-run") });
        writeJson(result);
        if ("state" in result && result.state === "failed") process.exitCode = 1;
      } else {
        const sessionId = stringArg(values, "session-id");
        if (!sessionId) throw new Error("grok-closeには--session-idが必要です。");
        writeJson(await grok.closeSession({ sessionId }));
      }
    } finally { grok.close(); }
    return;
  }
  const connector = await GptConnector.connect({ endpoint, stateDirectory });

  try {
    if (command === "models") {
      writeJson(await connector.models());
      return;
    }

    if (command === "chat") {
      const prompt = stringArg(values, "prompt");
      if (prompt === undefined) throw new Error("chatには--promptが必要です。");
      const result = await connector.chat({
        prompt,
        level: stringArg(values, "level"),
        model: stringArg(values, "model"),
        effort: stringArg(values, "effort"),
        keepOpen: false,
      });
      writeJson(result);
      return;
    }

    if (command === "image") {
      const prompt = stringArg(values, "prompt");
      const slug = stringArg(values, "slug");
      const workspaceRoot = stringArg(values, "workspace-root");
      const output = stringArg(values, "output");
      const model = stringArg(values, "model");
      if (
        prompt === undefined ||
        slug === undefined ||
        workspaceRoot === undefined ||
        output === undefined ||
        model === undefined
      ) {
        throw new Error("imageには--prompt、--slug、--workspace-root、--output、--modelが必要です。");
      }
      const result = await connector.image({
        prompt,
        slug,
        workspaceRoot,
        output,
        model,
        effort: stringArg(values, "effort"),
      });
      writeJson(result);
      if (result.state === "failed") process.exitCode = 1;
      return;
    }

    if (command === "consult") {
      const prompt = stringArg(values, "prompt");
      const slug = stringArg(values, "slug");
      if (prompt === undefined || slug === undefined) {
        throw new Error("consultには--promptと--slugが必要です。");
      }
      writeJson(await connector.consult({
        prompt,
        level: stringArg(values, "level"),
        slug,
        files: stringArgs(values, "file"),
        workspaceRoot: stringArg(values, "workspace-root"),
        model: stringArg(values, "model"),
        effort: stringArg(values, "effort"),
        keepOpen: flagArg(values, "keep-open"),
        sessionId: stringArg(values, "session-id"),
        dryRun: flagArg(values, "dry-run"),
      }));
      return;
    }

    if (command === "close") {
      const sessionId = stringArg(values, "session-id");
      if (sessionId === undefined) throw new Error("closeには--session-idが必要です。");
      writeJson(await connector.closeSession({ sessionId }));
      return;
    }

    throw new Error(
      "usage: gpt-connector --version | models | doctor | chat --prompt <text> | image --prompt <text> --slug <id> --workspace-root <abs> --output <relative.png> --model <id> [--effort <id>] | consult --prompt <text> --slug <id> [--workspace-root <abs> --file <spec> ...] [--model <id> --effort <id>] [--dry-run] | sessions --slug <id> | close --session-id <uuid>",
    );
  } finally {
    connector.close();
  }
}

function runtimeErrors(argv: readonly string[]): unknown {
  const [command, ...rest] = argv;
  if (command === undefined || !["snapshot", "diagnostics", "ack", "resolve", "reopen", "compact"].includes(command)) {
    throw new Error("usage: gpt-connector runtime-errors <snapshot|diagnostics|ack|resolve|reopen|compact> [arguments] --json");
  }
  let json = false;
  let afterCursor = 0;
  let limit = 256;
  let value: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]!;
    if (current === "--json" && !json) { json = true; continue; }
    if (command === "snapshot" && (current === "--after-cursor" || current === "--limit")) {
      const next = rest[++index];
      if (next === undefined || !/^\d+$/u.test(next)) throw new Error("runtime-errors cursor/limitが不正です。");
      if (current === "--after-cursor") afterCursor = Number(next); else limit = Number(next);
      continue;
    }
    if (["ack", "resolve", "reopen"].includes(command) && value === undefined) { value = current; continue; }
    throw new Error("runtime-errorsの引数が不正です。");
  }
  if (!json) throw new Error("runtime-errorsには--jsonが必要です。");
  if (command === "snapshot") return readRuntimeErrorSnapshot({ afterCursor, limit });
  if (command === "diagnostics") return getRuntimeErrorDiagnostics();
  if (command === "compact") return compactRuntimeErrors();
  if (value === undefined) throw new Error("runtime-errorsの値が必要です。");
  if (command === "ack") return acknowledgeRuntimeErrors(Number(value));
  if (command === "resolve") return resolveRuntimeError(value);
  return reopenRuntimeError(value);
}

main().catch((error: unknown) => {
  const telemetry = error instanceof ConnectorError ? recordRuntimeErrorBestEffort(error.code) : "disabled";
  if (telemetry === "store_unavailable") process.stderr.write(runtimeErrorStoreDiagnostic);
  if (error instanceof ConnectorError) {
    process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
  } else {
    process.stderr.write(`${JSON.stringify({ code: "INVALID_INPUT", message: "CLI commandを実行できませんでした。" })}\n`);
  }
  process.exitCode = 1;
});
