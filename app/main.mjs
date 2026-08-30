/**
 * WorkspaceCleaner 主进程：单窗口（无托盘），miraquota 同款工程结构。
 *
 * 架构：
 *  - core/scan.mjs     扫描引擎（项目/worktree/会话，流式回调）
 *  - core/actions.mjs  删除动作（回收站/硬删）+ 体积 + 使用中校验
 *  - core/preview.mjs  会话只读预览
 *  - core/settings.mjs 设置持久化（~/.ws-cleaner/settings.json）
 *
 * 行为要点（设计树拍板）：
 *  - 打开即显示上次缓存，后台静默重扫（流式上屏）
 *  - 关窗即退出（无托盘常驻）
 */
import electron from 'electron';
const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = electron;
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolveVersion } from './version.mjs';
import { scanAll } from '../core/scan.mjs';
import { loadSettings, saveSettings, settingsFile } from '../core/settings.mjs';
import { deleteProject, deleteWorktree, deleteSession, sizeOf } from '../core/actions.mjs';
import { previewSession } from '../core/preview.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_VERSION = resolveVersion(ROOT);

// 缓存：上次扫描结果（打开即显，后台刷新）
const CACHE_DIR = join(homedir(), '.ws-cleaner');
const CACHE_FILE = join(CACHE_DIR, 'cache.json');

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}
function writeCache(data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch { /* 忽略 */ }
}

let win = null;
let scanSeq = 0; // 扫描令牌：新扫描开始会让旧扫描的推送失效

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 静默后台扫描：结果流式上屏，结束时写缓存
 *  @param {{ streamUnenriched?: boolean }} [opts]
 *    streamUnenriched=false：等补完 turnCount 再推会话（删除后立刻重扫必须关，否则半成品会把轮次盖空）
 */
async function runScan(settings, opts = {}) {
  const seq = ++scanSeq;
  const streamUnenriched = opts.streamUnenriched !== false;
  const push = (kind, items) => {
    if (seq !== scanSeq) return; // 已有更新的扫描，丢弃旧推送
    send('scan:batch', { kind, items });
  };
  const onRepo = (repo) => push('projects', [repo]);
  const onSession = (s) => push('sessions', [s]);

  try {
    const result = await scanAll({
      roots: settings.roots,
      sessionRoots: activeSessionRoots(settings),
      idleDays: settings.idleDays,
      inUseMin: settings.inUseMin,
      onRepo, onSession,
      streamUnenriched,
    });
    if (seq !== scanSeq) return;
    writeCache(result);
    send('scan:done', { summary: result.summary, scannedAt: Date.now() });
  } catch (e) {
    if (seq !== scanSeq) return;
    send('scan:error', { message: String(e?.message || e) });
  }
}

function activeSessionRoots(settings) {
  const out = {};
  for (const [agent, cfg] of Object.entries(settings.sessionRoots ?? {})) {
    if (cfg?.enabled && cfg?.path) out[agent] = cfg.path;
  }
  return out;
}

// 主题（与 miraquota 同机制：nativeTheme.themeSource → 渲染进程 prefers-color-scheme）
const THEMES = ['system', 'light', 'dark'];
function applyTheme(v) {
  const t = THEMES.includes(v) ? v : 'system';
  nativeTheme.themeSource = t;
  return t;
}

function createWindow() {
  const work = electron.screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 900,
    height: Math.min(720, work.height - 60),
    minWidth: 720,
    minHeight: 520,
    frame: false,
    backgroundColor: '#1b1b1f',
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(join(HERE, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    // 无托盘：关闭即退出
    if (!app.isQuitting) { app.isQuitting = true; app.quit(); }
  });
}

app.whenReady().then(async () => {
  const settings = loadSettings();
  applyTheme(settings.theme);
  createWindow();

  ipcMain.handle('app:version', () => APP_VERSION);
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = saveSettings(patch);
    applyTheme(next.theme);
    return next;
  });
  ipcMain.handle('settings:file', () => settingsFile());

  // 打开即显缓存，随后后台静默重扫
  ipcMain.handle('scan:start', () => {
    const cached = readCache();
    if (cached?.projects || cached?.sessions) {
      send('scan:cache', cached);
    }
    runScan(loadSettings());
    return { started: true };
  });

  // 体积（懒加载，会话行直接带 size，项目行点按才算）
  ipcMain.handle('size:get', (_e, path) => sizeOf(path, { fast: true }));

  // 预览
  ipcMain.handle('preview:session', (_e, { path, agent }) => previewSession(path, agent));

  // 删除（多选批量；逐项返回结果）
  ipcMain.handle('delete:items', async (_e, { items }) => {
    const settings = loadSettings();
    const ctx = {
      sessions: [], // 删除前的会话快照用于使用中校验；随后由前端触发重扫
      projects: [], // 删除前项目快照
      inUseMin: settings.inUseMin,
    };
    const cached = readCache();
    ctx.sessions = cached?.sessions ?? [];
    ctx.projects = cached?.projects ?? [];

    const results = [];
    for (const it of items) {
      let r;
      if (it.kind === 'session') {
        r = await deleteSession(it, ctx).catch((e) => ({ ok: false, message: String(e?.message || e) }));
      } else if (it.kind === 'worktree') {
        r = await deleteWorktree(it, ctx).catch((e) => ({ ok: false, message: String(e?.message || e) }));
      } else if (it.kind === 'project') {
        r = await deleteProject(it, ctx).catch((e) => ({ ok: false, message: String(e?.message || e) }));
      } else {
        r = { ok: false, message: '未知类型：' + it.kind };
      }
      results.push({ item: { kind: it.kind, path: it.path, name: it.name }, ...r });
    }
    // 同步剔除缓存里已删项，再后台重扫（前端可乐观更新，缓存不倒退）
    const cached2 = readCache();
    if (cached2) {
      const gone = new Set(results.filter((r) => r.ok).map((r) => `${r.item.kind}|${r.item.path}`));
      if (gone.size) {
        cached2.projects = (cached2.projects ?? []).filter((p) => !gone.has(`${p.kind}|${p.path}`) && !gone.has(`project|${p.path}`) && !gone.has(`worktree|${p.path}`));
        cached2.sessions = (cached2.sessions ?? []).filter((s) => !gone.has(`session|${s.path}`));
        writeCache(cached2);
      }
    }
    runScan(loadSettings(), { streamUnenriched: false });
    return results;
  });

  // 文件定位
  ipcMain.handle('shell:reveal', (_e, path) => shell.showItemInFolder(path));
  ipcMain.handle('shell:openPath', (_e, path) => shell.openPath(path));

  ipcMain.on('win:min', () => win.minimize());
  ipcMain.on('win:max', () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
  ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });
  // 扫描由渲染进程 scan:start 驱动（会先推缓存再重扫），避免启动时双重扫描
});

app.on('window-all-closed', () => app.quit());
