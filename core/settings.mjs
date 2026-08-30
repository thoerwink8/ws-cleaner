/**
 * 工作区清理器 · 设置存储。
 * 数据落在 ~/.ws-cleaner/settings.json（与 miraquota 的 ~/.miraquota 同款约定）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), '.ws-cleaner');
const FILE = join(DIR, 'settings.json');

const DEFAULTS = {
  // 项目扫描根目录
  roots: [join('D:', 'frank')],
  // 会话存储开关与路径
  sessionRoots: {
    pi: { enabled: true, path: join(homedir(), '.pi', 'agent', 'sessions') },
    claude: { enabled: true, path: join(homedir(), '.claude', 'projects') },
    codex: { enabled: true, path: join(homedir(), '.codex', 'sessions') },
    orca: { enabled: true, path: join(homedir(), 'AppData', 'Roaming', 'orca', 'codex-session-backfill') },
  },
  idleDays: 90,        // 闲置标记阈值
  cleanupDays: 30,     // 一键清理阈值
  inUseMin: 15,        // 「使用中」判定窗口（分钟）
  skipConfirm: false,  // 勾上后 worktree/会话删除不再二次确认；项目删除永远要确认
  theme: 'system',
};

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(readFileSync(FILE, 'utf8')) ?? {}; } catch { /* 首次运行 */ }
  cache = deepMerge(structuredClone(DEFAULTS), saved);
  return cache;
}

export function saveSettings(patch) {
  const s = loadSettings();
  const next = deepMerge(s, patch);
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch { /* 忽略 */ }
  cache = next;
  return next;
}

export function settingsFile() { return FILE; }

function deepMerge(base, patch) {
  if (patch == null || typeof patch !== 'object') return base;
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] != null) {
      base[k] = deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
