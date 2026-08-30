#!/usr/bin/env node

import { GptConnector } from "./connector.js";
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
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write("usage: gpt-connector --version | browser <start|show> | models | doctor | factory-diagnostics --json | chat --prompt <text> | image --prompt <text> --slug <id> --workspace-root <abs> --output <relative.png> --model <id> | consult --prompt <text> --slug <id> | sessions --slug <id> | close --session-id <uuid>\n");
    return;
  }
  if (argv[0] === "runtime-errors") {
    writeJson(runtimeErrors(argv.slice(1)));
    return;
  }
  if (argv[0] === "browser") {
    if (argv.length !== 2 || !["start", "show"].includes(argv[1]!)) throw new Error("usage: gpt-connector browser <start|show>");
    writeJson(argv[1] === "start" ? await startBrowser() : await showBrowser());
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
  if (command === "doctor" || command === "diagnostics") {
    const diagnostics = await GptConnector.doctor({ endpoint, stateDirectory });
    writeJson(diagnostics);
    if (diagnostics.overall !== "ready") process.exitCode = 1;
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
        slug,
        files: stringArgs(values, "file"),
        workspaceRoot: stringArg(values, "workspace-root"),
        model: stringArg(values, "model"),
        effort: stringArg(values, "effort"),
        keepOpen: flagArg(values, "keep-open"),
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
