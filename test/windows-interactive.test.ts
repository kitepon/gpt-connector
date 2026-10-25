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

test("Windows same-user InteractiveToken requires an owned desktop session and removes finite task on success, action failure and deadline", { skip: process.platform !== "win32" }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-interactive-test-")), output = join(directory, "observed.json");
  ensurePrivateDirectory(directory);
  const before = await tasks();
  try {
    const sessions = JSON.parse(await windowsPowerShell(`
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$own = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object {
  if ($_.SessionId -gt 0 -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid) { [int]$_.SessionId }
} | Sort-Object -Unique)
@{ own = $own; current = [Diagnostics.Process]::GetCurrentProcess().SessionId } | ConvertTo-Json -Compress`)) as { own: number[]; current: number };
    context.diagnostic(JSON.stringify({ own_interactive_session_count: sessions.own.length, caller_owns_interactive_session: sessions.own.includes(sessions.current) }));
    if (sessions.own.length !== 1 && !sessions.own.includes(sessions.current)) {
      // A service runner is not the desktop user. Verify rejection, never switch to somebody else's Explorer.
      await assert.rejects(runInInteractiveSession("'must-not-run'", 10_000), error => error instanceof ConnectorError &&
        error.code === "CDP_UNAVAILABLE" && error.details?.reason === "interactive_session_missing_or_ambiguous" && error.details?.cleanupUnconfirmed === false);
      assert.deepEqual(await tasks(), before);
      return;
    }
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
