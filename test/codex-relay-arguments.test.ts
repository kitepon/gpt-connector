import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexServerArguments } from "../src/codex-relay-arguments.js";
import { preparePosixRelayLaunch } from "../src/codex-steer-launcher.js";
import { codexRelayLauncher as baseline } from "./fixtures/codex-relay/macos-launcher-0.8.0.js";

const cases: string[][] = [
  [], ["--version"], ["exec", "app-server"], ["app-server"],
  ["-c", 'x="app-server"', "app-server", "--stdio", "--analytics-default-enabled"],
  ["app-server", "proxy"], ["app-server", "daemon"], ["app-server", "daemon", "status"],
  ["app-server", "--listen", "stdio://"], ["app-server", "--listen=stdio://"],
  ["app-server", "--listen", "ws://localhost:9999"], ["app-server", "--listen=bad"],
  ["app-server", "--listen"], ["app-server", "--listen=bad", "--help"],
  ["app-server", "--config", "--help"], ["--listen", "stdio://", "app-server"],
  ["app-server", "--ws-token-file", "token"], ["--config=--help", "app-server"],
  ["app-server", "--config", "空白 ' 引用\n改行"], ["app-server", "--config"], ["-c\nx", "app-server"],
];

test("Macの受付条件をWindows専用の禁止・除外条件で変えない", () => {
  assert.deepEqual(codexServerArguments(["app-server", "daemon"]), ["app-server", "daemon"]);
  assert.deepEqual(codexServerArguments(["app-server", "--ws-token-file", "token"]), ["app-server", "--ws-token-file", "token"]);
  assert.equal(codexServerArguments(["app-server", "--listen=bad", "--help"]), null);
  assert.throws(() => codexServerArguments(["app-server", "--listen"]), /変更できません/);
  assert.deepEqual(codexServerArguments(["-c\nx", "app-server"]), ["-c\nx", "app-server"]);
});

test("旧Mac shellと共通化後で、実際に公式CLIへ渡す引数と拒否条件が一致する", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-args-"));
  const capture = join(root, "arguments.json");
  const binary = join(root, "official");
  const relay = join(root, "relay.mjs");
  const recorder = join(root, "record.mjs");
  const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  writeFileSync(recorder, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.GPT_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o700 });
  writeFileSync(relay, "// 起動形式だけを観測する模擬中継。\n");
  const launcher = join(root, "legacy");
  writeFileSync(launcher, baseline({ binary, node: process.execPath, relay, socket_root: join(root, "s") }), { mode: 0o700 });
  const options = { encoding: "utf8" as const, env: { ...process.env, GPT_CAPTURE: capture } };
  const normalized = () => (JSON.parse(readFileSync(capture, "utf8")) as string[]).map(value => value.startsWith("unix://") ? "unix://socket" : value);
  try {
    for (const args of cases) {
      const before = spawnSync(launcher, args, options);
      if (before.status !== 0) {
        assert.throws(() => preparePosixRelayLaunch(join(root, "s"), binary, process.execPath, relay, "12345", args), /変更できません/, JSON.stringify(args));
        continue;
      }
      const expected = normalized();
      const command = preparePosixRelayLaunch(join(root, "s"), binary, process.execPath, relay, "12345", args);
      const after = spawnSync("/bin/sh", ["-c", command], options);
      assert.equal(after.status, 0, after.stderr);
      assert.deepEqual(normalized(), expected, JSON.stringify(args));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
