import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensurePrivateDirectory } from "./state.js";
import { quotePowerShell, windowsPowerShell } from "./windows-powershell.js";
import { ConnectorError } from "../errors.js";

/** Internal source builder: callers own the private receipt directory; no task is created here. */
export function interactiveTaskSource(script: string, receipt: string, nonce: string, timeoutMs: number, deadlineUtcMs: number = Date.now() + timeoutMs): string {
  if (!/^gpt-connector-interactive-[a-f0-9-]{36}$/u.test(nonce) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(deadlineUtcMs) || deadlineUtcMs <= 0) throw new Error("interactive task input");
  const pending = receipt + ".pending";
  const guarded = `$ErrorActionPreference = 'Stop'
$value = @{ nonce = '${nonce}'; session_id = [Diagnostics.Process]::GetCurrentProcess().SessionId;
  owner_matches = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq '__GPT_SID__'); ok = $false }
try {
  if (!$value.owner_matches -or $value.session_id -ne __GPT_SESSION__ -or [DateTime]::UtcNow.Ticks -ge __GPT_DEADLINE__) { throw 'interactive_scope_or_deadline' }
  & ([scriptblock]::Create(${quotePowerShell(script)})) | Out-Null
  if ([DateTime]::UtcNow.Ticks -ge __GPT_DEADLINE__) { throw 'interactive_action_deadline' }
  $value.ok = $true
} catch { $value.error_code = 'interactive_action_failed'; $value.error_hresult = $_.Exception.HResult }
[IO.File]::WriteAllText(${quotePowerShell(pending)}, ($value | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
[IO.File]::Move(${quotePowerShell(pending)}, ${quotePowerShell(receipt)})`;
  return `
$name = ${quotePowerShell(nonce)}
$expires = [DateTimeOffset]::FromUnixTimeMilliseconds(${deadlineUtcMs}).UtcDateTime
$created = $false; $cleaned = $false; $targetSession = $null; $failure = $null; $folder = $null
try {
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ownSessions = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object {
  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
  if ($owner.Sid -eq $sid -and $_.SessionId -gt 0) { [int]$_.SessionId }
} | Sort-Object -Unique)
$callerSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ($callerSession -gt 0 -and $ownSessions -contains $callerSession) { $targetSession = $callerSession }
elseif ($ownSessions.Count -eq 1) { $targetSession = [int]$ownSessions[0] }
else { throw 'interactive_session_missing_or_ambiguous' }
$guarded = ${quotePowerShell(guarded)}
$guarded = $guarded.Replace('__GPT_SID__', $sid).Replace('__GPT_SESSION__', [string]$targetSession).Replace('__GPT_DEADLINE__', [string]$expires.Ticks)
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($guarded))
$service = New-Object -ComObject 'Schedule.Service'; $service.Connect(); $folder = $service.GetFolder('\\')
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = $name
$definition.Principal.UserId = $sid; $definition.Principal.LogonType = 3; $definition.Principal.RunLevel = 0
$definition.Settings.Enabled = $true; $definition.Settings.AllowDemandStart = $true
$definition.Settings.ExecutionTimeLimit = 'PT${Math.ceil(timeoutMs / 1000) + 3}S'
$definition.Settings.DisallowStartIfOnBatteries = $false; $definition.Settings.StopIfGoingOnBatteries = $false
$action = $definition.Actions.Create(0); $action.Path = (Get-Command pwsh.exe).Source
$action.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded
  $task = $folder.RegisterTaskDefinition($name, $definition, 2, $sid, $null, 3, ('D:P(A;;FA;;;SY)(A;;FA;;;' + $sid + ')'))
  $created = $true
  $principal = $task.Definition.Principal.UserId
  if ($principal -like 'S-1-*') { $principalSid = ([Security.Principal.SecurityIdentifier]::new($principal)).Value }
  else { $principalSid = ([Security.Principal.NTAccount]::new($principal)).Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($principalSid -ne $sid -or $task.Definition.Principal.LogonType -ne 3 -or $task.Definition.Principal.RunLevel -ne 0) { throw 'interactive_task_principal_mismatch' }
  [void]$task.RunEx($null, 4, $targetSession, $null)
  while (!(Test-Path -LiteralPath ${quotePowerShell(receipt)})) {
    if ([DateTime]::UtcNow -ge $expires) { throw 'interactive_task_timeout' }
    Start-Sleep -Milliseconds 25
  }
  if ([DateTime]::UtcNow -ge $expires) { throw 'interactive_receipt_deadline' }
} catch { $failure = 'interactive_task_failed' } finally {
  if ($created) {
   try {
    $own = $folder.GetTask($name)
    if ($own.Definition.RegistrationInfo.Description -ne $name) { throw 'interactive_task_ownership_mismatch' }
    $ownPrincipal = $own.Definition.Principal.UserId
    if ($ownPrincipal -like 'S-1-*') { $ownSid = ([Security.Principal.SecurityIdentifier]::new($ownPrincipal)).Value }
    else { $ownSid = ([Security.Principal.NTAccount]::new($ownPrincipal)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($ownSid -ne $sid) { throw 'interactive_task_owner_changed' }
    if ($own.State -eq 4) { $own.Stop(0) }
    $folder.DeleteTask($name, 0)
    $cleaned = $true
   } catch { $failure = 'interactive_task_cleanup_failed' }
  }
}
@{ ok = ($null -eq $failure); error_code = $failure; task_removed = (!$created -or $cleaned); target_session = $targetSession } | ConvertTo-Json -Compress
`;
}

export interface InteractiveSessionPorts {
  runPowerShell(script: string, timeoutMs: number, receipt: { path: string; nonce: string }): Promise<string>;
  now(): number;
}
const defaultPorts: InteractiveSessionPorts = { runPowerShell: (script, timeout) => windowsPowerShell(script, timeout), now: Date.now };

/** Same-SID InteractiveToken only. No S4U/password/elevation/service or cross-user fallback. */
export async function runInInteractiveSession(script: string, timeoutMs: number, ports: InteractiveSessionPorts = defaultPorts): Promise<void> {
  const deadlineUtcMs = ports.now() + timeoutMs;
  const directory = await mkdtemp(join(tmpdir(), "gpt-connector-interactive-"));
  const receipt = join(directory, "receipt.json"), nonce = `gpt-connector-interactive-${randomUUID()}`;
  let cleanupConfirmed = false;
  try {
    ensurePrivateDirectory(directory);
    const output = await ports.runPowerShell(interactiveTaskSource(script, receipt, nonce, timeoutMs, deadlineUtcMs), Math.max(1, deadlineUtcMs - ports.now()) + 8_000, { path: receipt, nonce });
    const task = z.object({ ok: z.boolean(), error_code: z.string().nullable(), task_removed: z.boolean(), target_session: z.number().int().positive().nullable() }).strict().parse(JSON.parse(output));
    cleanupConfirmed = task.task_removed;
    if (!task.ok || !task.task_removed || task.target_session === null) throw new ConnectorError("CDP_UNAVAILABLE", "同一利用者の対話taskが失敗しました。", {
      interactiveSession: true, cleanupUnconfirmed: !cleanupConfirmed, reason: task.error_code });
    const result = z.object({ nonce: z.literal(nonce), session_id: z.literal(task.target_session), owner_matches: z.literal(true), ok: z.boolean(),
      error_code: z.literal("interactive_action_failed").optional(), error_hresult: z.number().optional() }).strict().parse(JSON.parse(await readFile(receipt, "utf8")));
    if (ports.now() >= deadlineUtcMs) throw new ConnectorError("CDP_UNAVAILABLE", "同一利用者の対話操作は元の期限内に完了を確認できませんでした。", {
      interactiveSession: true, reason: "interactive_task_deadline", cleanupUnconfirmed: !cleanupConfirmed });
    if (!result.ok) throw new ConnectorError("CDP_UNAVAILABLE", "同一利用者の対話sessionで専用Chromeの操作に失敗しました。", { interactiveSession: true });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("CDP_UNAVAILABLE", "同一利用者の対話session起動または所有taskの回収を確認できませんでした。", { interactiveSession: true, cleanupUnconfirmed: !cleanupConfirmed });
  } finally {
    // An unknown task lifetime retains its private receipt for explicit recovery; never claim cleanup on failure.
    if (cleanupConfirmed) await rm(directory, { recursive: true, force: true });
  }
}
