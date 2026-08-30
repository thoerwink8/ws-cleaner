/**
 * 工作区清理器 · 删除/预览/体积 动作（主进程侧，全部带防御性校验）。
 *
 * 删除语义（设计树已拍板）：
 *  - 项目（仓库根目录）→ 移入系统回收站（软删除，可恢复）
 *  - worktree → git worktree remove（硬删；脏时须 force，由界面确认框把关）
 *  - AI 会话 → 直接删文件（硬删；orca 同）
 *  - 使用中的项（有活跃会话的工作目录落在其中）一律拒绝删除
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, unlink, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

const execFileP = promisify(execFile);
const GIT_TIMEOUT = 10000;

function git(repo, args) {
  return execFileP('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT, windowsHide: true })
    .then((r) => r.stdout.trim());
}

/** 路径小写归一（跨盘符比较用） */
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
const covers = (proj, cwd) => {
  if (!cwd) return false;
  const p = norm(proj), c = norm(cwd);
  return c === p || c.startsWith(p + '/');
};

/**
 * 校验：会话/项目 是否正被活跃会话占用。
 * @param {{path:string, cwd?:string}} item
 * @param {{sessions:any[], inUseMin:number}} ctx
 */
export function checkInUse(item, ctx) {
  const now = Date.now() / 1000;
  const win = (ctx.inUseMin ?? 15) * 60;
  // 会话自身活跃
  if (item.kind === 'session') {
    const active = item.lastActivityAt != null && now - item.lastActivityAt <= win;
    return active ? `该会话 ${Math.round(win / 60)} 分钟内还有活动，疑似正在使用` : null;
  }
  // 项目/worktree：活跃会话的工作目录落在其中
  for (const s of ctx.sessions ?? []) {
    if (s.lastActivityAt == null) continue;
    if (now - s.lastActivityAt > win) continue;
    if (!s.cwd) continue;
    if (item.path && covers(item.path, s.cwd)) {
      return `有活跃会话（${s.agent}）的工作目录位于此项目内，删除会破坏进行中的会话`;
    }
  }
  return null;
}

/** 移到系统回收站（软删除）。Windows 用 PowerShell + Microsoft.VisualBasic。 */
async function toRecycleBin(target) {
  const abs = target.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${abs}','OnlyErrorDialogs','SendToRecycleBin')`,
  ].join('; ');
  try {
    await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 30000, windowsHide: true });
    return true;
  } catch (e) {
    throw new Error('移入回收站失败：' + (e?.message || e));
  }
}

/**
 * 删除单个项目（仓库根目录）→ 回收站。
 * 若该项目登记了 worktree，先一并把 worktree 目录移入回收站，避免留下坏引用。
 */
export async function deleteProject(item, ctx) {
  const busy = checkInUse(item, ctx);
  if (busy) return { ok: false, message: busy };

  // 找出登记在案的 worktree，一并回收
  const wtDirs = (ctx.projects ?? []).filter((p) => p.isWorktree && p.mainRepo && norm(p.mainRepo) === norm(item.path));
  for (const wt of wtDirs) {
    if (existsSync(wt.path)) {
      try { await toRecycleBin(wt.path); } catch (e) {
        return { ok: false, message: `主仓库未删：其 worktree（${wt.path}）回收失败：${e.message}` };
      }
    }
  }
  if (existsSync(item.path)) await toRecycleBin(item.path);
  return { ok: true, message: wtDirs.length ? `已连同 ${wtDirs.length} 个工作树移入回收站` : '已移入回收站' };
}

/** 删除 worktree（git 硬删）；dirty 且未 force 时拒绝 */
export async function deleteWorktree(item, ctx) {
  const busy = checkInUse(item, ctx);
  if (busy) return { ok: false, message: busy };
  const main = item.mainRepo;
  if (!main) return { ok: false, message: '无法确定该 worktree 的主仓库，已中止（请手动 git worktree remove）' };
  if (item.dirty && !item.force) {
    return { ok: false, message: '该工作树有未提交改动，删除会丢弃改动（需在确认框勾选「强制删除」）' };
  }
  const args = ['worktree', 'remove'];
  if (item.force) args.push('--force');
  args.push(item.path);
  try {
    await git(main, args);
    return { ok: true, message: '工作树已删除' };
  } catch (e) {
    return { ok: false, message: 'git worktree remove 失败：' + (e?.message || e) };
  }
}

/** 删除 AI 会话文件（硬删）。pi 的会话目录删除后顺手清空目录。 */
export async function deleteSession(item) {
  const busy = checkInUse(item, { inUseMin: 15 });
  if (busy) return { ok: false, message: busy };
  try {
    await unlink(item.path);
  } catch (e) {
    return { ok: false, message: '删除失败：' + (e?.message || e) };
  }
  // pi：会话目录里可能只剩这个文件，空了就一起删
  if (item.agent === 'pi' && item.dir) {
    try {
      const rest = await readdir(item.dir);
      if (rest.length === 0) await rm(item.dir, { recursive: true, force: true });
    } catch { /* 目录非空或已被占用，留着 */ }
  }
  return { ok: true, message: '会话已删除' };
}

/** 目录体积（懒加载用）。跳过 .git 之外的常见大目录以提速。 */
const SKIP_SIZE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', 'venv', '__pycache__', 'target']);
export async function sizeOf(path, { fast = true } = {}) {
  let total = 0;
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (SKIP_SIZE.has(e.name)) continue;
          if (depth < 4) await walk(full, depth + 1);
        } else if (e.isSymbolicLink()) {
          // 不跟进链接
        } else {
          const st = await stat(full);
          total += st.size;
        }
      } catch { /* 权限/占用跳过 */ }
    }
  };
  await walk(path, 0);
  return total;
}
