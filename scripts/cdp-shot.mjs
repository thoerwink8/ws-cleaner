/**
 * CDP 驱动 + PrintWindow 截图的辅助脚本。
 * 用法：node scripts/cdp-shot.mjs <动作> <输出文件>
 * 动作：proj | sess | preview | settings | confirm | clean | hover-del
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TMP_DIR = join(ROOT, '_tmp');
const SHOT_PS1 = join(HERE, 'shot.ps1');

const action = process.argv[2] || 'proj';
const out = process.argv[3] || join(TMP_DIR, 'shot.png');

mkdirSync(TMP_DIR, { recursive: true }); // 临时产物统一落 _tmp/

// 1) CDP 驱动界面
async function cdpEval(expression) {
  const list = await (await fetch('http://127.0.0.1:9334/json')).json();
  const page = list.find((t) => t.type === 'page');
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function send(method, params) {
    return new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      sock.send(JSON.stringify({ id: i, method, params }));
    });
  }
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  };
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  sock.close();
  return r?.result?.value;
}

// 各动作的 JS
const ACTIONS = {
  proj: `document.getElementById('tabProj').click(); '项目页'`,
  sess: `document.getElementById('tabSess').click(); '会话页'`,
  preview: `
    (async () => {
      document.getElementById('tabSess').click();
      await new Promise(r => setTimeout(r, 300));
      const btn = document.querySelector('.item .act[data-preview]');
      if (!btn) return '无预览按钮';
      btn.click();
      await new Promise(r => setTimeout(r, 1200));
      return '预览面板打开';
    })()
  `,
  settings: `document.getElementById('btnSettings').click(); '设置弹窗'`,
  confirm: `
    (async () => {
      document.getElementById('tabProj').click();
      await new Promise(r => setTimeout(r, 300));
      // 勾选第一个非锁定的项目
      const cb = document.querySelector('.item input[type=checkbox]:not(:disabled)');
      if (!cb) return '无可用勾选';
      cb.click();
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('btnDelSel').click();
      await new Promise(r => setTimeout(r, 400));
      return '确认弹窗';
    })()
  `,
  clean: `
    (async () => {
      document.getElementById('tabSess').click();
      await new Promise(r => setTimeout(r, 300));
      document.getElementById('btnClean').click();
      await new Promise(r => setTimeout(r, 400));
      return '一键清理已勾选';
    })()
  `,
};

(async () => {
  const js = ACTIONS[action];
  if (!js) { console.error('未知动作：' + action); process.exit(1); }
  const result = await cdpEval(js);
  console.log('CDP:', result);
  await new Promise((r) => setTimeout(r, 800)); // 等渲染
  // 2) PrintWindow 截图
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SHOT_PS1, out], { stdio: 'inherit' });
})();
