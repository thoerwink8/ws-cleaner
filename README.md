# WorkspaceCleaner · 工作区清理器

本机（Windows）的「AI 会话 + git worktree + 闲置项目」统一清理器。
UI 视觉与工程结构同源 **miraquota**（`D:\frank\miraquota-win`，Electron 单窗口、自绘标题栏、暗/亮双主题）。

**核心诉求**：mirasim 删除 worktree / AI 会话太麻烦，做一个桌面工具统一点击删除。
**形态**：Electron 单窗口（无托盘常驻，关窗即退出）。

---

## 功能

- **项目页**：扫描根目录下所有 git 仓库与 worktree，标注 闲置（默认 90 天）/ 使用中 / 有改动
- **会话页**：pi / claude / codex / orca 四类 AI 会话统一管理，按 agent 分组，删除前可**预览**历史（只读粗览）
- **一键清理**：勾选所有超过 N 天（默认 30）的过期会话
- **多选删除** + 主题三态（跟随系统/亮/暗）

## 删除语义（用户拍板，勿改）

| 对象 | 动作 | 二次确认 |
|---|---|---|
| 项目（仓库根目录） | **移入系统回收站**（软删，可恢复） | 永远弹确认 + 必须勾选「我确认删除」 |
| Worktree | `git worktree remove`（硬删） | 有未提交改动时须勾选「强制删除」 |
| AI 会话 | 直接删文件（硬删） | 勾了「免二次确认」则直接删 |
| 使用中的项（活跃会话工作目录落在其中，15 分钟窗口） | **拒绝删除** | — |

其余决策：不做后台定时删除（一键清理是半自动）；应用内不做回收站页签（用系统回收站）；orca 会话不预览但可删。

## 架构

```
app/
  main.mjs             主进程：窗口、IPC、扫描调度、缓存
  preload.cjs          window.wsCleaner.* 桥
  renderer/index.html  全部 UI（单文件，设计令牌与 miraquota 同源）
  version.mjs          版本 = <major.minor>.<git 提交数>
core/
  scan.mjs             扫描引擎（项目/worktree/会话 + 交叉标注）
  actions.mjs          删除动作（回收站/硬删）+ 体积 + 使用中校验
  preview.mjs          会话只读预览解析（pi/claude/codex）
  settings.mjs         设置持久化（~/.ws-cleaner/settings.json）
scripts/
  dist.mjs             打包（electron-builder）
  gen-icon.mjs         垃圾桶图标生成（纯 Node）
  cdp-shot.mjs / shot.ps1   调试截图工具
test/scan.test.mjs     扫描引擎测试
```

数据流：启动 → 读缓存（`~/.ws-cleaner/cache.json`）立即显示 → 后台重扫（流式上屏）→ 写缓存。

## 会话存储格式（已实测）

| agent | 路径 | 关键格式 |
|---|---|---|
| pi | `~/.pi/agent/sessions/<编码目录>/*.jsonl` | `{"type":"message","message":{role,content:[…]}}` —— **内容在 `rec.message` 里** |
| claude | `~/.claude/projects/<编码目录>/*.jsonl` | `{"type":"user"/"assistant","message":{content:[…]}}`；目录名 `C:\` → `C--` |
| codex | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` | `{"type":"response_item","payload":{type:'message',role,content}}` —— **消息体就是 `payload` 本身** |
| orca | `~/AppData/Roaming/orca/codex-session-backfill/*.jsonl` | 可删，不预览 |

## 开发

```bash
cd /d/frank/ws-cleaner
unset ELECTRON_RUN_AS_NODE   # 关键！本环境该变量会让 electron 退化成纯 node
pnpm dev                     # 或 ./node_modules/electron/dist/electron.exe .
pnpm test                    # node --test
pnpm dist                    # 打包（版本自动 = 0.1.<提交数>）
```

## 环境坑（新环境必读）

1. **`ELECTRON_RUN_AS_NODE=1`** 会让 `electron .` 变成纯 node（`require('electron')` 返回路径字符串）。启动前 unset。
2. **electron 二进制曾手动拷贝**：网络下载失败时，从 `D:\frank\miraquota-win\node_modules\electron\dist` 复制到本项目 `node_modules/electron/dist`，并写 `node_modules/electron/path.txt`（内容 `electron.exe`，不带换行）。缓存 zip 在 `~/AppData/Local/electron/Cache/electron-v38.8.6-win32-x64.zip`。重装 node_modules 需重做。
3. electron postinstall 被 pnpm 拦截的问题已在 `pnpm-workspace.yaml`（`allowBuilds: electron: true`）解决。
4. 调试：`electron . --remote-debugging-port=9334` + CDP 读真实 DOM；`scripts/shot.ps1` 用 PrintWindow 抓窗口（**别用 CopyFromScreen**，远程会话下是空白伪影）。
5. `pnpm dist` 尚未实跑验证（网络问题可能重现，打包时用 `ELECTRON_BUILDER_CACHE` 或镜像兜底）。

## 已知限制

- claude 会话目录名解码尽力而为（`~` 短名与 `-` 有歧义）
- 使用中判定靠文件 mtime 启发式，非进程级检测
- 项目体积懒加载（点按计算），无全量汇总
- 全中文 UI，无国际化

## 数据位置

- 设置：`~/.ws-cleaner/settings.json`
- 扫描缓存：`~/.ws-cleaner/cache.json`
