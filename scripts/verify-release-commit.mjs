#!/usr/bin/env node

// publishする成果が、既定ブランチへ着地済みのcommitから作られていることを保証する。
// 着地していないbranchからpublishすると、そのbranchが取り残された時点で公開物が
// 後続releaseから消え、統合契約だけが存在しない面を指し続ける。
// 共通憲法「publish・本番deployの対象commitは所有repoの既定ブランチの祖先だけ」の機械gate。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectDirectory = path.dirname(path.dirname(scriptPath));

export function verifyReleaseCommit({
  projectDirectory = defaultProjectDirectory,
  spawn = spawnSync,
} = {}) {
  const git = (...args) => {
    const result = spawn('git', args, { cwd: projectDirectory, encoding: 'utf8' });
    return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
  };

  const head = git('rev-parse', 'HEAD');
  assert.ok(head.ok, 'git HEAD を解決できません');

  const dirty = git('status', '--porcelain', '--untracked-files=normal');
  assert.equal(
    dirty.stdout,
    '',
    `working treeに未commitの変更があります。publish対象commitとpayloadが一致しません:\n${dirty.stdout}`,
  );

  const fetched = git('fetch', '--no-tags', 'origin', 'main');
  assert.ok(fetched.ok, 'origin/mainを更新できません。originへ到達できる環境で再実行してください。');

  const defaultRef = 'origin/main';
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

  return `release commit ${head.stdout.slice(0, 12)} is landed on ${defaultRef}.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  console.log(verifyReleaseCommit());
}
