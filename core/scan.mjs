/**
 * 工作区清理器 · 扫描引擎（纯 Node，无外部依赖）。
 *
 * 职责：
 *  - 在固定根目录下发现 git 仓库（项目）与 git worktree（标记主仓库）
 *  - 扫描四类 AI 会话存储：pi / claude / codex / orca
 *  - 交叉标注：使用中（有活跃会话的工作目录落在其中）、闲置（最后活动超过阈值）
 *
 * 约定：
 *  - 体积一律不预计算（懒加载，见 actions.sizeOf）
 *  - 所有 git 调用带超时，失败的项目降级为「信息不完整」而非整单失败
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname, resolve, normalize, sep } from 'node:path';
import { homedir } from 'node:os';

const execFileP = promisify(execFile);
const GIT_TIMEOUT = 8000;

/** 遍历时直接跳过的大目录名（区分大小写，Windows 常见形态都列上） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.venv', 'venv', '__pycache__',
  '.next', '.turbo', '.nuxt', '.output', 'dist', 'build', 'out', 'target',
  '.idea', '.vscode', '.vs', 'coverage', '.cache', 'AppData', '.local',
  'site-packages', '.gradle', '.m2', '.terraform', '.terragrunt-cache',
  '.pnpm-store', 'bower_components', 'vendor', 'Library',
]);

const MAX_DEPTH = 5;

/** 编码名解码：Claude Code 的会话目录名（C:\Users\A\B → C--Users-A-B），尽力还原路径 */
function decodeEncodedPath(name) {
  const m = String(name).match(/^([A-Za-z]):-(.*)$/) || String(name).match(/^(?:--)?([A-Za-z])--(.*)$/);
  if (!m) return null;
  const [, drive, rest] = m;
  // 约定：`:` 与 `\` 都折成 `-`（Windows 短名 ~ 也折成 -，无法可靠还原，尽力而为）
  return `${drive}:\\${rest.replace(/-/g, '\\')}`;
}

/** 判断目录是不是 git 仓库（.git 是目录=主仓库，是文件=worktree） */
async function isGitRepo(dir) {
  try {
    const st = await stat(join(dir, '.git'));
    return st.isDirectory() || st.isFile();
  } catch { return false; }
}

function git(repo, args) {
  return execFileP('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT, windowsHide: true })
    .then((r) => r.stdout.trim());
}

/**
 * 发现所有 git 仓库（含 worktree）。
 * @param {string[]} roots 扫描根目录
 * @param {(repo: any) => void} onRepo 每发现一个仓库回调（流式上屏用）
 */
export async function discoverRepos(roots, onRepo = () => {}) {
  const found = new Map(); // resolved path -> repo

  // 1) 广度遍历根目录找 .git
  const queue = roots.map((r) => ({ dir: resolve(r), depth: 0 }));
  const visited = new Set();
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    const subdirs = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      subdirs.push(full);
    }
    // 本目录是否是仓库
    if (await isGitRepo(dir)) {
      if (!found.has(dir)) {
        const repo = await enrichRepo(dir);
        found.set(dir, repo);
        onRepo(repo);
      }
      continue; // 是仓库就不往下钻（避免把仓库内的子目录当独立项目）
    }
    if (depth >= MAX_DEPTH) continue;
    for (const s of subdirs) queue.push({ dir: s, depth: depth + 1 });
  }

  // 2) 对每个仓库问 worktree list，补全 worktree 身份与主仓库
  for (const repo of [...found.values()]) {
    try {
      const out = await git(repo.path, ['worktree', 'list', '--porcelain']);
      const wtPaths = out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
      for (const wt of wtPaths) {
        const p = resolve(wt);
        if (found.has(p)) continue; // 主仓库路径不算
        const repo2 = await enrichRepo(p, repo.path);
        found.set(p, repo2);
        onRepo(repo2);
      }
    } catch { /* 仓库不可用就跳过 worktree 补全 */ }
  }
  return [...found.values()];
}

/** 单个仓库的信息补全 */
async function enrichRepo(path, mainRepo = null) {
  const base = { path, name: basename(path) };
  // worktree 身份：gitdir 里含 /.git/worktrees/ 即是 worktree
  let gitDir = null;
  try { gitDir = await git(path, ['rev-parse', '--git-dir']); } catch { /* 仓库损坏 */ }
  const isWt = mainRepo != null || (gitDir && /[\\/]\.git[\\/]worktrees[\\/]/.test(gitDir));
  if (isWt && mainRepo == null && gitDir) {
    // D:/frank/repo/.git/worktrees/foo → 主仓库 = D:/frank/repo
    mainRepo = resolve(dirname(dirname(dirname(gitDir))));
  }

  const [branch, lastCommit, commonDir] = await Promise.all([
    git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    git(path, ['log', '-1', '--format=%ct']).catch(() => null),
    git(path, ['rev-parse', '--git-common-dir']).catch(() => null),
  ]);

  // 脏标记：git status --porcelain 非空
  let dirty = false;
  try {
    const st = await git(path, ['status', '--porcelain']);
    dirty = st.length > 0;
  } catch { /* 忽略 */ }

  const lastActivityAt = lastCommit != null && /^\d+$/.test(lastCommit) ? Number(lastCommit) : null;
  return {
    ...base,
    kind: 'project',
    isWorktree: isWt,
    mainRepo,
    gitDir: gitDir || null,
    branch: branch || null,
    dirty,
    lastCommitAt: lastActivityAt,
    lastActivityAt,
    // 以下字段由 scanAll 交叉标注后填充
    inUse: false,
    idle: false,
    sessionCount: 0,
    sizeBytes: null,
  };
}

/** 读取 jsonl 文件首行，尽力取 cwd 字段 */
async function firstLineCwd(file) {
  try {
    const h = await readFile(file, { encoding: 'utf8' });
    const first = h.slice(0, 2048);
    const i = first.indexOf('"cwd"');
    if (i >= 0) {
      const m = first.slice(i).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 扫描 pi 会话（~/.pi/agent/sessions/<编码目录>/*.jsonl） */
async function scanPi(root) {
  const out = [];
  let dirs = [];
  try { dirs = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files.filter((f) => f.endsWith('.jsonl'))) {
      const path = join(dir, f);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      const cwd = await firstLineCwd(path);
      out.push({
        kind: 'session', agent: 'pi', path, dir,
        name: cwd ? basename(cwd) : d.name,
        cwd, sizeBytes: st.size,
        lastActivityAt: Math.floor(st.mtimeMs / 1000),
        startAt: null, endAt: null, messageCount: null,
        inUse: false, idle: false, previewable: true,
      });
    }
  }
  return out;
}

/** 扫描 claude 会话（~/.claude/projects/<编码目录>/*.jsonl） */
async function scanClaude(root) {
  const out = [];
  let dirs = [];
  try { dirs = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files.filter((f) => f.endsWith('.jsonl'))) {
      const path = join(dir, f);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      const cwd = decodeEncodedPath(d.name);
      out.push({
        kind: 'session', agent: 'claude', path, dir,
        name: cwd ? basename(cwd) : d.name,
        cwd, sizeBytes: st.size,
        lastActivityAt: Math.floor(st.mtimeMs / 1000),
        startAt: null, endAt: null, messageCount: null,
        inUse: false, idle: false, previewable: true,
      });
    }
  }
  return out;
}

/** 扫描 codex 会话（~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl） */
async function scanCodex(root) {
  const out = [];
  const walk = async (dir, depth) => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) await walk(full, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      const cwd = await firstLineCwd(full);
      out.push({
        kind: 'session', agent: 'codex', path: full, dir,
        name: cwd ? basename(cwd) : e.name.replace(/^rollout-/, '').slice(0, 24),
        cwd, sizeBytes: st.size,
        lastActivityAt: Math.floor(st.mtimeMs / 1000),
        startAt: null, endAt: null, messageCount: null,
        inUse: false, idle: false, previewable: true,
      });
    }
  };
  await walk(root, 0);
  return out;
}

/** 扫描 orca 会话（~/AppData/Roaming/orca/codex-session-backfill/*.jsonl）——无预览，仅可删 */
async function scanOrca(root) {
  const out = [];
  let files = [];
  try { files = await readdir(root); } catch { return out; }
  for (const f of files.filter((f) => f.endsWith('.jsonl'))) {
    const path = join(root, f);
    const st = await stat(path).catch(() => null);
    if (!st) continue;
    const cwd = await firstLineCwd(path);
    out.push({
      kind: 'session', agent: 'orca', path, dir: root,
      name: cwd ? basename(cwd) : f.replace(/\.jsonl$/, '').slice(0, 24),
      cwd, sizeBytes: st.size,
      lastActivityAt: Math.floor(st.mtimeMs / 1000),
      startAt: null, endAt: null, messageCount: null,
      inUse: false, idle: false, previewable: false,
    });
  }
  return out;
}

/** 路径归一化比较用：小写、正斜杠、去尾分隔符 */
function norm(p) {
  return String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/** 判断 sessPath（会话工作目录）是否落在 projectPath 内 */
function covers(projectPath, cwd) {
  if (!cwd) return false;
  const p = norm(projectPath), c = norm(cwd);
  return c === p || c.startsWith(p + '/');
}

/**
 * 全量扫描：项目 + 会话 + 交叉标注。
 * @returns {{ projects: any[], sessions: any[], summary: any }}
 */
export async function scanAll({ roots, sessionRoots, idleDays, inUseMin, onRepo, onSession, onProgress }) {
  const projects = await discoverRepos(roots, onRepo);
  let sessions = [];
  const sr = sessionRoots || {};
  if (sr.pi) sessions = sessions.concat(await scanPi(sr.pi));
  if (sr.claude) sessions = sessions.concat(await scanClaude(sr.claude));
  if (sr.codex) sessions = sessions.concat(await scanCodex(sr.codex));
  if (sr.orca) sessions = sessions.concat(await scanOrca(sr.orca));
  for (const s of sessions) onSession?.(s);

  // 交叉标注
  const now = Date.now() / 1000;
  const inUseWin = (inUseMin ?? 15) * 60;
  const inUseCwd = new Set(
    sessions.filter((s) => s.lastActivityAt != null && now - s.lastActivityAt <= inUseWin && s.cwd)
      .map((s) => norm(s.cwd))
  );
  const idleAfter = (idleDays ?? 90) * 86400;

  for (const p of projects) {
    p.sessionCount = sessions.filter((s) => covers(p.path, s.cwd)).length;
    p.inUse = [...inUseCwd].some((c) => covers(p.path, c) || norm(p.path) === c);
    p.idle = p.lastActivityAt != null && now - p.lastActivityAt > idleAfter;
  }
  for (const s of sessions) {
    s.inUse = s.lastActivityAt != null && now - s.lastActivityAt <= inUseWin;
    s.idle = s.lastActivityAt != null && now - s.lastActivityAt > idleAfter;
  }

  const totalBytes = sessions.reduce((a, s) => a + (s.sizeBytes || 0), 0);
  const summary = {
    projects: projects.length,
    worktrees: projects.filter((p) => p.isWorktree).length,
    sessions: sessions.length,
    sessionBytes: totalBytes,
    scannedAt: Date.now(),
  };
  return { projects, sessions, summary };
}

export { decodeEncodedPath };
