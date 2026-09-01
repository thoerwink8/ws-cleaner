/**
 * 打包封装：版本号从 git 自动生成后调 electron-builder，不手改 package.json。
 * 规则：<major.minor 取自 package.json> . <git 提交数>。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from '../app/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD_ARTIFACT = /^WorkspaceCleaner(?: Setup)? [0-9.]+\.exe(?:\.blockmap)?$/;

const args = process.argv.slice(2);
const versionAt = args.indexOf('--version');
const explicitVersion = versionAt >= 0 ? args[versionAt + 1] : null;
if (versionAt >= 0 && !/^\d+\.\d+\.\d+$/.test(explicitVersion || '')) {
  console.error('[dist] --version 需要 x.y.z 格式');
  process.exit(2);
}
const version = explicitVersion || resolveVersion(ROOT);
const passthrough = versionAt >= 0
  ? args.filter((_arg, index) => index !== versionAt && index !== versionAt + 1)
  : args;
console.log(`[dist] version ${version}`);

// --publish never：CI 里 electron-builder 检测到 CI 就想自己发包，缺 GH_TOKEN 直接报错退出。
// 发布由 .github/workflows/release.yml 的 gh release 负责，这里只打包。放在 passthrough 之前，
// 手动想让它发包时 `pnpm dist --publish always` 仍能覆盖（yargs 后者胜）。
const r = spawnSync('pnpm', ['exec', 'electron-builder', '--win', '--publish', 'never',
  `-c.extraMetadata.version=${version}`, ...passthrough],
  { cwd: ROOT, stdio: 'inherit', shell: true });

if (r.status === 0) {
  const distDir = join(ROOT, 'dist');
  const keep = new Set([
    `WorkspaceCleaner ${version}.exe`,
    `WorkspaceCleaner Setup ${version}.exe`,
    `WorkspaceCleaner Setup ${version}.exe.blockmap`,
  ]);
  let removed = 0;
  for (const name of readdirSync(distDir)) {
    if (keep.has(name)) continue;
    if (!OLD_ARTIFACT.test(name)) continue;
    unlinkSync(join(distDir, name));
    removed += 1;
    console.log(`[dist] 清理旧产物 ${name}`);
  }
  if (removed) console.log(`[dist] 已删除 ${removed} 个历史安装包，仅保留 ${version}`);
}

process.exit(r.status ?? 1);
