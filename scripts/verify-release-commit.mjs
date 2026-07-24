#!/usr/bin/env node

// publishする成果が、既定ブランチへ着地済みのcommitから作られていることを保証する。
// 着地していないbranchからpublishすると、そのbranchが取り残された時点で公開物が
// 後続releaseから消え、統合契約だけが存在しない面を指し続ける。
// 共通憲法「publish・本番deployの対象commitは所有repoの既定ブランチの祖先だけ」の機械gate。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const git = (...args) => {
  const result = spawnSync('git', args, { cwd: projectDirectory, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
};

const head = git('rev-parse', 'HEAD');
assert.ok(head.ok, 'git HEAD を解決できません');

// 既定ブランチはorigin/HEADのsymbolic refから取る。未設定の環境ではmainへ落とす。
const originHead = git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
const defaultRef = originHead.ok && originHead.stdout
  ? originHead.stdout.replace('refs/remotes/', '')
  : 'origin/main';

const defaultResolved = git('rev-parse', '--verify', `${defaultRef}^{commit}`);
assert.ok(
  defaultResolved.ok,
  `既定ブランチ ${defaultRef} を解決できません。git fetch origin を先に実行してください。`,
);

const isAncestor = git('merge-base', '--is-ancestor', head.stdout, defaultRef);
assert.ok(
  isAncestor.ok,
  `publish対象 ${head.stdout.slice(0, 12)} が ${defaultRef} の祖先ではありません。`
    + ' 先に既定ブランチへ着地させてpushしてから publish してください。',
);

// payloadはworking treeから作られるため、dirtyなtreeで出すとどのcommitにも対応しない
// 成果物が公開される。ignore済みのdist/やbuild/は対象外。
const dirty = git('status', '--porcelain', '--untracked-files=no');
assert.equal(
  dirty.stdout,
  '',
  `working treeに未commitの変更があります。publish対象commitとpayloadが一致しません:\n${dirty.stdout}`,
);

console.log(`release commit ${head.stdout.slice(0, 12)} is landed on ${defaultRef}.`);
