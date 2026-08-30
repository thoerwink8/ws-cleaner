# Agent.md · WorkspaceCleaner 交接说明

> 给新 agent 的入口文档：项目定位、铁律、约定、环境坑。改代码前先读。

**项目**：本机（Windows）的「AI 会话 + git worktree + 闲置项目」统一清理器。
**形态**：Electron 单窗口（无托盘常驻，关窗即退出），UI 视觉与工程结构同源 `D:\frank\miraquota-win`。
**核心诉求**：mirasim 删除 worktree / AI 会话太麻烦，做桌面工具统一点击删除。

## 快速上手

```bash
cd /d/frank/ws-cleaner
pnpm dev                     # 启动器已自动剔除 ELECTRON_RUN_AS_NODE
pnpm test                    # node --test（扫描引擎）
pnpm dist                    # 打包（版本自动 = <major.minor>.<git 提交数>）
```

## 架构

```
app/
  main.mjs             主进程：窗口、IPC、扫描调度、缓存
  preload.cjs          window.wsCleaner.* 桥
  renderer/index.html  全部 UI（单文件，设计令牌与 miraquota 同源）
  version.mjs          版本 = <major.minor>.<git 提交数>
core/
  scan.mjs             扫描引擎（项目/worktree/会话 + 交叉标注，流式回调）
  actions.mjs          删除动作（回收站/硬删）+ 体积 + 使用中校验
  preview.mjs          会话只读预览解析（pi/claude/codex）
  settings.mjs         设置持久化（~/.ws-cleaner/settings.json）
scripts/
  dist.mjs             打包（electron-builder，自动清旧产物）
  gen-icon.mjs         垃圾桶图标生成（纯 Node，postinstall 跑）
  cdp-shot.mjs / shot.ps1   调试截图工具（输出落 _tmp/）
test/scan.test.mjs     扫描引擎测试（临时目录用系统 os.tmpdir）
```

数据流：启动 → 读缓存（`~/.ws-cleaner/cache.json`）立即显示 → 后台重扫（流式上屏）→ 写缓存。

## 铁律（用户拍板，勿改）

| 对象 | 动作 | 二次确认 |
|---|---|---|
| 项目（仓库根目录） | **移入系统回收站**（软删，可恢复） | 永远弹确认 + 必须勾选「我确认删除」 |
| Worktree | `git worktree remove`（硬删） | 有未提交改动时须勾选「强制删除」 |
| AI 会话 | 直接删文件（硬删） | 勾了「免二次确认」则直接删 |
| 使用中的项（活跃会话工作目录落在其中，15 分钟窗口） | **拒绝删除** | — |

其余决策：不做后台定时删除（一键清理是半自动）；应用内不做回收站页签（用系统回收站）；orca 会话不预览但可删。

## 约定

- **临时文件一律放 `_tmp/`**（已 gitignore，不入库）。截图、调试产物、一次性的中间文件都写这里，不许散落到仓库根目录；用完可随手删。
  - `scripts/cdp-shot.mjs` / `scripts/shot.ps1` 的默认输出就是 `_tmp/shot.png`，路径按脚本自身位置解析，不硬编码本机绝对路径。
- 全中文 UI，无国际化。
- 版本号从 git 提交数自动生成（`scripts/dist.mjs`），不手改 package.json。
- 主题三态：跟随系统/亮/暗，走 `nativeTheme.themeSource`。
- 会话存储格式（已实测）：pi 内容在 `rec.message`；codex 消息体就是 `payload` 本身；claude 目录名 `C:\` → `C--`。详见 README「会话存储格式」。

## 环境坑

1. **`ELECTRON_RUN_AS_NODE=1`**（本机 MINGW64 全局导出）会让 `electron .` 退化成纯 node。`pnpm dev` 走 `scripts/dev.mjs` 启动器自动删除该变量；直接跑 `electron .` 需先 `unset`。
2. electron 二进制可能需手动拷贝：从 `D:\frank\miraquota-win\node_modules\electron\dist` 复制，并写 `node_modules/electron/path.txt`（内容 `electron.exe`，不带换行）。重装 node_modules 需重做。
3. 截图用 PrintWindow（`scripts/shot.ps1`），**别用 CopyFromScreen**——远程会话下是空白伪影。调试开 `electron . --remote-debugging-port=9334` + CDP 读真实 DOM。
4. electron-builder 网络缓存：`~/AppData/Local/electron/Cache/`、`~/AppData/Local/electron-builder/Cache/`。

## 数据位置

- 设置：`~/.ws-cleaner/settings.json`
- 扫描缓存：`~/.ws-cleaner/cache.json`

## 已知限制

- claude 会话目录名解码尽力而为（`~` 短名与 `-` 有歧义）
- 使用中判定靠文件 mtime 启发式，非进程级检测
- 项目体积懒加载（点按计算），无全量汇总
