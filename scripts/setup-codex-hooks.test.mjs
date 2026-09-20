import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureCodexSteer,mergeCodexParentHooks,codexHookCommand} from '../dist/src/setup-codex-hooks.js';
import {readCodexHookConfig} from '../dist/src/codex-hook-state.js';

function fixture(t) {
  const root=fs.mkdtempSync(join(tmpdir(),'gpt hook setup '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=join(root,'codex'); fs.mkdirSync(home);
  const hook=join(root,'hook.js'); fs.writeFileSync(hook,'');
  const events=[]; let legacy=null; let rows=[];
  const runtime={platform:'darwin',directory:join(root,'state'),codex_home:home,node:process.execPath,hook,
    findBinary:()=>'/official/codex',processes:()=>rows,legacy:()=>legacy,legacyOverride:()=>null,
    disableLegacy:async()=>{events.push('disable');legacy={...legacy,enabled:false};return {status:'restart_required'};},
    verify:async(config,approve)=>{events.push(approve?'approve':'read'); const value=JSON.parse(fs.readFileSync(join(home,'hooks.json'),'utf8'));assert(value.hooks.Stop.some(group=>group.hooks.some(hook=>hook.command===config.command)));}};
  return {root,home,hook,runtime,events,setLegacy:value=>{legacy=value;},setProcesses:value=>{rows=value;}};
}

test('公式hookの承認と読戻しを終えてから旧中継を解除する',async t=>{
  const f=fixture(t); f.setLegacy({enabled:true}); f.setProcesses([{pid:20,started_identity:'old',command:'/official/codex app-server'}]);
  assert.equal((await configureCodexSteer('enable',f.runtime)).status,'restart_required');
  assert.deepEqual(f.events,['approve','disable']);
  assert.equal((await configureCodexSteer('status',f.runtime)).status,'restart_required');
  f.setProcesses([{pid:20,started_identity:'new',command:'/official/codex app-server'}]);
  assert.equal((await configureCodexSteer('status',f.runtime)).status,'ready');
});

test('再実行でも他のhookと元の設定を保持し、解除では自分の登録だけを除く',async t=>{
  const f=fixture(t); const file=join(f.home,'hooks.json');
  const foreign={matcher:'Bash',hooks:[{type:'command',command:'other-hook',timeout:8}]};
  fs.writeFileSync(file,JSON.stringify({description:'他製品の設定',hooks:{Stop:[foreign],SessionStart:[foreign]}}));
  await configureCodexSteer('enable',f.runtime); const before=fs.readFileSync(file,'utf8');
  await configureCodexSteer('enable',f.runtime); assert.equal(fs.readFileSync(file,'utf8'),before);
  await configureCodexSteer('disable',f.runtime);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{description:'他製品の設定',hooks:{Stop:[foreign],SessionStart:[foreign]}});
  assert.equal(readCodexHookConfig(f.runtime.directory).enabled,false);
});

test('承認が拒否された時は旧中継を解除せず、readyを記録しない',async t=>{
  const f=fixture(t); f.setLegacy({enabled:true});
  await assert.rejects(configureCodexSteer('enable',{...f.runtime,verify:async()=>{throw new Error('承認拒否');}}),/承認拒否/);
  assert.deepEqual(f.events,[]); assert.equal(readCodexHookConfig(f.runtime.directory),null);
});

test('旧起動設定の解除失敗は新設定を残し、再実行で移行を続行する',async t=>{
  const f=fixture(t); f.setLegacy({enabled:true});
  await assert.rejects(configureCodexSteer('enable',{...f.runtime,disableLegacy:async()=>{throw new Error('解除失敗');}}),/解除失敗/);
  assert.equal(readCodexHookConfig(f.runtime.directory).enabled,true);
  assert.deepEqual(await configureCodexSteer('status',f.runtime),{status:'failed',reason_code:'codex_steer_migration_required'});
  assert.equal((await configureCodexSteer('enable',f.runtime)).status,'ready');
});

test('解除済み記録でもGUIに旧launcherが残っていれば移行を要求して解除する',async t=>{
  const f=fixture(t); await configureCodexSteer('enable',f.runtime);
  f.setLegacy({enabled:false,launcher:'/old/launcher'});
  f.runtime.legacyOverride=()=>'/old/launcher';
  assert.deepEqual(await configureCodexSteer('status',f.runtime),{status:'failed',reason_code:'codex_steer_migration_required'});
  f.events.length=0;
  await configureCodexSteer('enable',f.runtime);
  assert.deepEqual(f.events,['approve','disable']);
});

test('解除済み記録と異なる他製品のGUI設定は保持する',async t=>{
  const f=fixture(t); await configureCodexSteer('enable',f.runtime);
  f.setLegacy({enabled:false,launcher:'/old/launcher'});
  f.runtime.legacyOverride=()=>'/other/launcher';
  f.events.length=0;
  assert.equal((await configureCodexSteer('status',f.runtime)).status,'ready');
  await configureCodexSteer('enable',f.runtime);
  assert.deepEqual(f.events,['read','approve']);
});

test('不正な既存hook設定は書き換えない',t=>{
  const f=fixture(t); const file=join(f.home,'hooks.json');
  for(const text of ['{broken','[]','{"hooks":[]}','{"hooks":{"Stop":{}}}']) {
    fs.writeFileSync(file,text); assert.throws(()=>mergeCodexParentHooks(file,'ours'),/hook/); assert.equal(fs.readFileSync(file,'utf8'),text);
  }
});

test('Nodeが欠けてもdisableは実行でき、未対応OSのenableは設定しない',async t=>{
  const f=fixture(t);
  assert.equal((await configureCodexSteer('enable',{...f.runtime,platform:'linux'})).status,'unsupported');
  assert.equal(fs.existsSync(join(f.home,'hooks.json')),false);
  await configureCodexSteer('enable',f.runtime);
  await configureCodexSteer('disable',{...f.runtime,node:'/missing/node',hook:'/missing/hook'});
  assert.equal((await configureCodexSteer('status',f.runtime)).status,'disabled');
});

test('Windowsでも同じ導入順序と再起動判定を使い、PowerShell 7へ引数を正確に渡す',async t=>{
  const f=fixture(t); f.runtime.platform='win32'; f.runtime.findBinary=()=>String.raw`C:\Program Files\Codex\codex.exe`;
  f.setLegacy({enabled:true}); f.setProcesses([{pid:20,started_identity:'old',command:'"'+f.runtime.findBinary()+'" app-server'}]);
  assert.equal((await configureCodexSteer('enable',f.runtime)).status,'restart_required');
  assert.deepEqual(f.events,['approve','disable']);
  const command=codexHookCommand(String.raw`C:\Node path\node.exe`,String.raw`C:\quo's app\hook.js`,String.raw`C:\state path`,'win32');
  assert(command.startsWith('pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '));
  assert.equal(Buffer.from(command.split(' ').at(-1),'base64').toString('utf16le'),String.raw`& 'C:\Node path\node.exe' 'C:\quo''s app\hook.js' 'C:\state path'; exit $LASTEXITCODE`);
});

test('異なるCODEX_HOMEへの再導入は元の登録を保持して拒否する',async t=>{
  const f=fixture(t); await configureCodexSteer('enable',f.runtime);
  const other=join(f.root,'other'); fs.mkdirSync(other);
  await assert.rejects(configureCodexSteer('enable',{...f.runtime,codex_home:other}),error=>error.reasonCode==='codex_steer_configuration_conflict');
  assert.equal(fs.existsSync(join(other,'hooks.json')),false);
});

test('Desktop更新で実行pathが変わっても旧binaryの親を再起動対象として保持する',async t=>{
  const f=fixture(t); f.runtime.platform='win32'; f.runtime.findBinary=()=>String.raw`C:\cache\new\codex.exe`;
  f.setLegacy({enabled:true,binary:String.raw`C:\cache\old\codex.exe`});
  f.setProcesses([{pid:20,started_identity:'old',command:String.raw`"c:\CACHE\OLD\CODEX.EXE" app-server`}]);
  assert.equal((await configureCodexSteer('enable',f.runtime)).status,'restart_required');
  assert.equal((await configureCodexSteer('status',f.runtime)).status,'restart_required');
  assert.deepEqual(readCodexHookConfig(f.runtime.directory).stale_processes,[{pid:20,started_identity:'old'}]);
});
