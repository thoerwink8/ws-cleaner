/**
 * 扫描引擎冒烟测试（不依赖真实目录，用临时 git 仓库验证发现逻辑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { discoverRepos } from '../core/scan.mjs';

function git(dir, args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

test('discoverRepos 找到主仓库与 worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wsc-test-'));
  try {
    const main = join(root, 'main');
    mkdirSync(main);
    git(main, ['init', '-q']);
    git(main, ['config', 'user.email', 't@t']);
    git(main, ['config', 'user.name', 't']);
    writeFileSync(join(main, 'a.txt'), 'x');
    git(main, ['add', '.']);
    git(main, ['commit', '-qm', 'init']);

    const wt = join(root, 'wt');
    git(main, ['worktree', 'add', '-q', wt, '-b', 'feature']);

    const repos = await discoverRepos([root]);
    assert.ok(repos.length >= 2, `应发现主仓库+worktree，实际 ${repos.length}`);
    const wtRepo = repos.find((r) => r.path === wt);
    assert.ok(wtRepo, 'worktree 应在结果里');
    assert.equal(wtRepo.isWorktree, true);
    // 主仓库路径可能有 8.3 短名/长名差异，归一化后比较
    assert.ok(
      wtRepo.mainRepo.replace(/\\/g, '/').toLowerCase().endsWith('main') &&
      wtRepo.mainRepo.includes('wsc-test-'),
      `主仓库应正确解析，实际 ${wtRepo.mainRepo}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
