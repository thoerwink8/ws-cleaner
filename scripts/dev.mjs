/**
 * 启动 electron 开发实例（pnpm dev 入口）。
 *
 * 关键：剔除 ELECTRON_RUN_AS_NODE 环境变量。
 * 该变量被某些 shell/工具全局导出（本机 MINGW64 就是），会让 electron 退化成纯 node：
 * `import electron from 'electron'` 拿到的变成 exe 路径字符串，`app` 为 undefined，
 * 报错 "Cannot read properties of undefined (reading 'whenReady')"。
 * 用 node 起子进程并在 spawn 时删掉它，`pnpm dev` 在任何 shell 下都能直接跑。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 纯 node 下 require('electron') 返回 electron.exe 的绝对路径（npm 包约定行为）
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on('error', (e) => {
  console.error('启动 electron 失败：', e.message);
  process.exit(1);
});
