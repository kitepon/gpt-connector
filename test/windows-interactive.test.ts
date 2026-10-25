import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensurePrivateDirectory } from "../src/platform/state.js";
import { runInInteractiveSession } from "../src/platform/windows-interactive.js";
import { quotePowerShell, windowsPowerShell } from "../src/platform/windows-powershell.js";
import { ConnectorError } from "../src/errors.js";

const tasks = async (): Promise<string[]> => JSON.parse(await windowsPowerShell(`
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$service = New-Object -ComObject Schedule.Service; $service.Connect()
$names = @($service.GetFolder('\\').GetTasks(0) | Where-Object { $_.Name -like 'gpt-connector-interactive-*' } | ForEach-Object { $_.Name })
ConvertTo-Json -InputObject $names -Compress`));

test("Windows same-user InteractiveToken executes in desktop session and removes finite task on success, action failure and deadline", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-interactive-test-")), output = join(directory, "observed.json");
  ensurePrivateDirectory(directory);
  const before = await tasks();
  try {
    await runInInteractiveSession(`
@{ session_id = [Diagnostics.Process]::GetCurrentProcess().SessionId; sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } |
  ConvertTo-Json -Compress | Set-Content -LiteralPath ${quotePowerShell(output)} -Encoding utf8`, 10_000);
    const actual = JSON.parse((await readFile(output, "utf8")).replace(/^\uFEFF/u, ""));
    assert.ok(actual.session_id > 0);
    const expectedSid = await windowsPowerShell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
    assert.equal(actual.sid, expectedSid);
    assert.deepEqual(await tasks(), before);
    await assert.rejects(runInInteractiveSession("throw 'synthetic-action-failure'", 10_000), error => error instanceof ConnectorError && error.code === "CDP_UNAVAILABLE");
    assert.deepEqual(await tasks(), before);
    await assert.rejects(runInInteractiveSession("Start-Sleep -Seconds 10", 2500), error => error instanceof ConnectorError && error.code === "CDP_UNAVAILABLE" && error.details?.cleanupUnconfirmed === false);
    assert.deepEqual(await tasks(), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
