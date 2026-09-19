import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { windowsNativeProcessSource } from "../src/platform/windows-codex-native.js";
import { quotePowerShell, windowsPowerShell } from "../src/platform/windows-powershell.js";

test("Windows: 専用browserの起動処理は呼出元の終了jobを継承せず引数を保持する", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpt browser 寿命 "));
  const receipt = join(directory, "receipt.json");
  const fixture = join(directory, "child.mjs");
  const launcher = join(directory, "launcher.mjs");
  const args = ["日本語と 空白", '引用"文字', "末尾\\", "$(実行しない)`記号"];
  await writeFile(fixture, `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,args:process.argv.slice(3)}));setInterval(()=>{},1000);`);
  const adapter = new URL("../src/platform/windows-browser.ts", import.meta.url).href;
  await writeFile(launcher, `import {spawnDetached} from ${JSON.stringify(adapter)};await spawnDetached(process.execPath,${JSON.stringify([fixture, receipt, ...args])});`);
  try {
    const output = await windowsPowerShell(`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
${windowsNativeProcessSource}
'@
$lifetime = [GptNativeProcess+Lifetime]::new()
$child = $null
$ownedPid = $null
try {
  $child = [GptNativeProcess]::Start($PID, ${quotePowerShell(process.execPath)}, @('--import', ${quotePowerShell(import.meta.resolve("tsx"))}, ${quotePowerShell(launcher)}), $true, $lifetime)
  $code = $child.Wait()
  if ($code -ne 0) { throw "起動処理が失敗しました: $code" }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (!(Test-Path -LiteralPath ${quotePowerShell(receipt)})) {
    if ([DateTime]::UtcNow -gt $deadline) { throw '子の受付記録がありません' }
    Start-Sleep -Milliseconds 25
  }
  $ownedPid = (Get-Content -LiteralPath ${quotePowerShell(receipt)} -Raw | ConvertFrom-Json).pid
  $before = [bool](Get-Process -Id $ownedPid -ErrorAction SilentlyContinue)
  $lifetime.Dispose()
  Start-Sleep -Milliseconds 300
  $after = [bool](Get-Process -Id $ownedPid -ErrorAction SilentlyContinue)
  @{before=$before;after=$after} | ConvertTo-Json -Compress
} finally {
  if ($child) { $child.Dispose() }
  $lifetime.Dispose()
  if ($ownedPid -and (Get-Process -Id $ownedPid -ErrorAction SilentlyContinue)) { Stop-Process -Id $ownedPid -Force }
}`, 20_000);
    const result = JSON.parse(output);
    assert.equal(result.before, true);
    assert.equal(result.after, true, "呼出元jobの終了で独立起動した子まで終了した");
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")).args, args);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
