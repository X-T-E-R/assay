# Assay

**Study many. Grow your own.**

Assay 是一个 CLI 工作台，用来把证据变成更好的系统：收集重要材料，放进结构里检验，记录决策，再让你自己的工作区持续长出可复用知识。

> English version: [README.md](README.md)

## Assay 做什么

Assay 在一个仓库式工作区里维护通用证据循环：

```text
证据进入 -> 结构化检验 -> 决策 -> 知识增长
```

当外部来源、实验、目标或多个方案需要变成可追踪的决策和可复用系统，而不是散落笔记时，就用 Assay。

## 工作原理

每个工作区都有一个 archetype。archetype 是**结构 + 约定 + 通用动词**（`source`、`analysis`、`iteration`、`adr`、`check`），不是一组专属命令。

内置 archetype：

| Archetype | 作用 |
| --- | --- |
| `library` | 保留 systems 和 knowledge 的共享基座。 |
| `study` | 逐个学习外部系统。 |
| `solve` | 围绕一个可衡量目标，用 attempts 和 benchmarks 迭代。 |
| `science` | 从 hypotheses 到 findings，运行证据导向实验。 |
| `evaluation` | 用 criteria、scorecards 和 ADR 比较外部候选。 |
| `explore` | 同时孵化多个本地方案，再选择方向。 |

`study`、`solve`、`explore` 是主要工作关系：研究外部样例、攻克已知目标，或在目标形态还没确定时先铺开多个方案。`evaluation` 对应 `study` 的横向外部比较；`science` 对应 `solve` 的证据驱动迭代。

自定义 archetype 是复制出来的 YAML 结构。把内置 YAML 复制到 `.framework/archetypes/<name>.yaml` 或 `~/.assay/archetypes/<name>.yaml`，再修改目录、模板、模块或 manifest mode。

## 快速开始

构建并链接 CLI：

```bash
pnpm install
pnpm build
cd packages/assay-cli && npm link && cd ../..
```

创建一个 `study` 工作区：

```bash
assay init ../assay-study --name AssayStudy --archetype study --no-track
cd ../assay-study
assay check
assay source add /path/to/project sample
assay analysis new "Review sample" --for-source sample
```

如果目标可衡量，改用 `solve`：

```bash
assay init ../assay-solve --name AssaySolve --archetype solve --no-track
```

## 作为 Agent Skill 使用

仓库提供面向 agent 的 Skill：`skills/assay-builder`。它直接调用当前克隆仓库里的 CLI，所以安装后要保留这个克隆目录：

```bash
git clone <repo-url> assay
cd assay
node scripts/install.mjs
```

安装参数和调用细节见 `skills/assay-builder/references/cli-setup.zh.md`。

## 了解更多

- [命令参考](docs/commands.md)
- [工作区结构](docs/workspace-layout.md)
- [贡献指南](CONTRIBUTING.md)
