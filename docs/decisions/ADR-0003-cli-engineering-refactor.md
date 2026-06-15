# ADR-0003：CLI 拆分为 TypeScript core 与 Commander adapter

- 状态：Accepted
- 日期：2026-06-14

## 背景

MetaSystem Kit 的 CLI 会创建、检查、更新并迁移用户工作区。把这些行为直接写在命令处理器里，会让未来 GUI、测试和更新预览都被迫依赖终端进程。

## 决策

CLI 使用两个 TypeScript workspace package：

```text
packages/
├── metasystem-framework-core/
│   └── src/        # framework 行为、模板、manifest、事件、update/migration
└── metasystem-framework-cli/
    └── src/        # Commander 命令、参数映射、格式化、退出码
```

`metasystem-framework-core` 暴露可复用 API；`metasystem-framework-cli` 只负责把 argv 转成 core options，再把结构化结果格式化到 stdout/stderr。

## CLI 命令面

```bash
metasystem init [target] --name <project> [--git]
metasystem adopt --root <root> --name <project> [--dry-run|--apply]
metasystem check --root <root>
metasystem status --root <root>
metasystem update --root <root> [--dry-run|--force|--skip-all|--create-new]
metasystem migrate-layout --root <root> [--dry-run|--apply]
metasystem reference add <source-dir> <name> --root <root>
metasystem analysis new <title> --root <root>
metasystem iteration start <title> --root <root>
metasystem event capture --kind observation --text "..." --root <root>
```

`init` defaults to the current working directory. Other workspace commands also
default to the current framework root; `--root` is for out-of-tree operations.

## 测试要求

最小测试覆盖：

1. init 创建新结构和 manifest；
2. adopt 默认 dry-run，不移动文件；apply 会把已有内容移动到 `.old/<timestamp>/`，保留 `.git/` 并生成新 scaffold；
3. 用户修改 managed 文件后 update 默认不覆盖；
4. 用户删除 managed 文件后 update 默认不恢复；
5. reference add 会复制并写事件；
6. migrate-layout 默认 dry-run 不改文件；
7. CLI help、init/adopt/check/status/update dry-run/migration dry-run 可通过构建后的 Node 入口运行。

## 兼容策略

Skill 和仓库检查脚本直接调用构建后的 TypeScript CLI：

```bash
node packages/metasystem-framework-cli/dist/cli.js --help
```

GUI 或其他自动化应导入 `metasystem-framework-core`，不要 shell out 到 `metasystem`。

## 后果

正面：

- core 行为可测试、可复用；
- CLI adapter 边界清晰；
- update/migration 结果可被 GUI 预览；
- repository smoke 不依赖旧运行时。

代价：

- 需要先 `pnpm install` 和 `pnpm build`；
- package 边界需要持续维护，避免把业务逻辑写回 CLI adapter。
