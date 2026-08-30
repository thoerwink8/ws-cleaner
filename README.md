# WorkspaceCleaner · 工作区清理器

盘点本机代码项目 / git worktree / AI 会话，删除闲置项。
UI 与工程结构同源 miraquota（Electron 单窗口，深/浅色主题，自绘标题栏）。

## 用途

- **项目**：扫描根目录下的所有 git 仓库与 worktree，标记闲置 / 使用中 / 有改动
- **Worktree**：`git worktree remove` 硬删（有未提交改动时须勾选「强制删除」）
- **AI 会话**：pi / claude / codex / orca 四类会话统一管理，硬删前可**预览**历史（只读粗览）
- **一键清理**：勾选所有超过 N 天的过期会话（默认 30 天），一次删除

## 删除语义（设计树拍板）

| 对象 | 动作 | 二次确认 |
|---|---|---|
| 项目（仓库根目录） | **移入系统回收站**（可恢复） | 永远弹确认，且必须勾选「我确认删除」 |
| Worktree | git worktree remove（硬删） | 有改动时须勾选「强制删除」 |
| AI 会话 | 直接删文件（硬删） | 勾了「免二次确认」则直接删 |
| 使用中的项（有活跃会话的工作目录落在其中） | **拒绝删除** | — |

## 开发

```bash
pnpm install
pnpm dev
```

## 打包

```bash
pnpm dist        # 版本号自动 = <major.minor>.<git 提交数>
```

## 数据位置

- 设置：`~/.ws-cleaner/settings.json`
- 扫描缓存：`~/.ws-cleaner/cache.json`
