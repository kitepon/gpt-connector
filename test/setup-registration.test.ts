import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { parse } from "smol-toml";
import { mergeRegistration, registerClient, registrationPath, setupClients, setupTools } from "../src/setup-registration.js";

for (const client of setupClients) {
  test(`${client}: 初回登録と再実行は同じ登録を維持する`, () => {
    const first = mergeRegistration("", client, "/node", ["/gpt-connector/dist/src/mcp.js"]);
    assert.equal(first.changed, true);
    assert.deepEqual(first.server.env, { GPT_CONNECTOR_CDP_ENDPOINT: "http://127.0.0.1:9223" });
    const again = mergeRegistration(first.text, client, "/node", ["/gpt-connector/dist/src/mcp.js"]);
    assert.equal(again.changed, false);
    assert.equal(again.text, first.text);
  });
}

test("Codex: 工場登録へ不足契約だけを追加し、利用者env・モデル・他MCPを維持する", () => {
  const source = `model = "user-model"\nmodel_reasoning_effort = "high"\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers.gpt_connector]\ncommand = "gpt-connector-mcp"\nstartup_timeout_sec = 40\ntool_timeout_sec = 900\nenabled = false\nrequired = true\nenabled_tools = ["sessions"]\n[mcp_servers.gpt_connector.env]\nGPT_CONNECTOR_CDP_ENDPOINT = "http://127.0.0.1:9444"\nGPT_CONNECTOR_STATE_DIR = "/user/state"\nTOKEN = "fixture-token"\n`;
  const result = mergeRegistration(source, "codex", "/node", ["/gpt-connector/dist/src/mcp.js"]);
  const expected = parse(source, { integersAsBigInt: true });
  (expected.mcp_servers as Record<string, Record<string, unknown>>).gpt_connector!.args = [];
  assert.deepEqual(parse(result.text, { integersAsBigInt: true }), expected);
  const fresh = parse(mergeRegistration("", "codex", "/node", ["/gpt-connector/dist/src/mcp.js"]).text);
  assert.deepEqual((fresh.mcp_servers as Record<string, Record<string, unknown>>).gpt_connector!.enabled_tools, setupTools);
});

test("Grok: inline envと大きな整数を保持する", () => {
  const result = mergeRegistration('model = "chosen"\nserial = 9223372036854775807\n[mcp_servers.gpt_connector]\ncommand = "gpt-connector-mcp"\nenv = { PATH = "/usr/bin", SECRET = "fixture" }\n', "grok", "/node", ["/gpt-connector/dist/src/mcp.js"]);
  const data = parse(result.text, { integersAsBigInt: true });
  assert.equal(data.model, "chosen");
  assert.equal(data.serial, 9223372036854775807n);
  assert.deepEqual(result.server.env, { GPT_CONNECTOR_CDP_ENDPOINT: "http://127.0.0.1:9223", PATH: "/usr/bin", SECRET: "fixture" });
});

test("TOMLのコメント・複数行文字列・既存値の表記を変更しない", () => {
  const source = '# 利用者の設定\nmodel = "chosen" # keep\nnotes = """\n[mcp_servers.gpt_connector]\nnot a table\n"""\n[mcp_servers.gpt_connector]\ncommand = \'gpt-connector-mcp\' # keep command\n[mcp_servers.gpt_connector.env]\nTOKEN = \'fixture\' # keep env\n[mcp_servers.other]\ncommand = \'other\'\n';
  const result = mergeRegistration(source, "codex", "/node", []);
  assert.equal(parse(result.text).model, "chosen");
  for (const line of source.split("\n")) assert.ok(result.text.includes(line), `既存行が変わりました: ${line}`);
  assert.equal(mergeRegistration(result.text, "codex", "/node", []).changed, false);
});

test("rootのinline serverへ不足keyだけを追加する", () => {
  const source = 'model = "chosen"\nmcp_servers = { gpt_connector = { command = "gpt-connector-mcp", env = { TOKEN = "fixture" } }, other = { command = "other" } } # keep\n';
  const result = mergeRegistration(source, "codex", "/node", []);
  const data = parse(result.text);
  assert.equal((data.mcp_servers as Record<string, Record<string, unknown>>).other!.command, "other");
  assert.ok(result.text.includes('# keep'));
  assert.equal(mergeRegistration(result.text, "codex", "/node", []).changed, false);
});

test("ClaudeとCursor: 認証・他MCP・disabled設定を保持する", () => {
  for (const client of ["claude", "cursor"] as const) {
    const original = { oauth: { account: "fixture" }, model: "chosen", mcpServers: { other: { command: "other" }, gpt_connector: { command: "gpt-connector-mcp", disabled: true, env: { SECRET: "fixture" } } } };
    const result = mergeRegistration(JSON.stringify(original), client, "/node", ["/gpt-connector/dist/src/mcp.js"]);
    const actual = JSON.parse(result.text);
    assert.deepEqual(actual.oauth, original.oauth);
    assert.equal(actual.model, original.model);
    assert.deepEqual(actual.mcpServers.other, original.mcpServers.other);
    assert.equal(actual.mcpServers.gpt_connector.disabled, true);
    assert.equal(actual.mcpServers.gpt_connector.env.SECRET, "fixture");
  }
});

test("不正な設定とremote登録を破壊しない", () => {
  assert.throws(() => mergeRegistration("[broken", "codex", "/node", []));
  assert.throws(() => mergeRegistration('{"mcpServers":[]}', "claude", "/node", []));
  assert.throws(() => mergeRegistration('{"mcpServers":{"gpt_connector":{"url":"https://example.com"}}}', "cursor", "/node", []));
});

test("既存設定をtarへ保存し、再実行では追加書込みしない", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "mcp.json");
  const source = '{"mcpServers":{"other":{"command":"other"}}}\n';
  await writeFile(path, source, { mode: 0o600 });
  const backupDirectory = join(root, "backups");
  const first = await registerClient("cursor", process.execPath, ["/gpt-connector/dist/src/mcp.js"], path, backupDirectory);
  assert.ok(first.backup?.endsWith(".tar"));
  const after = await readFile(path, "utf8");
  const second = await registerClient("cursor", process.execPath, ["/gpt-connector/dist/src/mcp.js"], path, backupDirectory);
  assert.equal(second.status, "unchanged");
  assert.equal(second.backup, null);
  assert.equal(await readFile(path, "utf8"), after);
  assert.equal((await readdir(backupDirectory)).filter((file) => file.endsWith(".tar")).length, 1);
});

test("設定ディレクトリの環境変数を尊重する", () => {
  assert.equal(registrationPath("codex", "/home/user", { CODEX_HOME: "/custom/codex" }), join("/custom/codex", "config.toml"));
  assert.equal(registrationPath("grok", "/home/user", { GROK_HOME: "/custom/grok" }), join("/custom/grok", "config.toml"));
});

test("Windows: GitのtarがPATHの先頭でも設定を標準tarへ正しく保存する", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-backup-"));
  const previousPath = process.env.PATH;
  t.after(async () => { process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); });
  process.env.PATH = `${join(process.env.ProgramFiles!, "Git", "usr", "bin")};${previousPath}`;
  const source = 'model = "利用者のモデル"\n';
  const path = join(root, "config.toml");
  await writeFile(path, source);
  // 同じ引数でGit付属tarがドライブ文字を接続先と解釈することを先に確認する。
  assert.throws(() => execFileSync("tar", ["-cf", join(root, "broken.tar"), "-C", root, "config.toml"], { stdio: "pipe" }), /Cannot connect to/);
  const result = await registerClient("codex", process.execPath, [], path, join(root, "backups"));
  assert.equal(result.status, "registered");
  const archived = execFileSync(join(process.env.SystemRoot!, "System32", "tar.exe"), ["-xOf", result.backup!, "config.toml"], { encoding: "utf8" });
  assert.equal(archived, source);
});

test("symlinkの登録先はリンクを保ったまま実体へ反映する", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "real"));
  const actual = join(root, "real", "config.toml");
  await writeFile(actual, 'model = "chosen"\n');
  const link = join(root, "config.toml");
  await symlink(actual, link);
  await registerClient("codex", process.execPath, ["/gpt-connector/dist/src/mcp.js"], link, join(root, "backups"));
  assert.equal(await readFile(link, "utf8"), await readFile(actual, "utf8"));
});
