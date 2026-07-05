# Assay

把 AI 研究变成你的仓库能记住的决策。

可以作为独立工作台运行，也可以私有地 attach 到你正在发布的仓库上。

> English version: [README.md](README.md)

## Assay 做什么

你的 agent 一个下午能看二十个仓库。没有工作台，有价值的东西会消失在聊天记录里：什么重要、什么失败、采纳了什么、为什么下一个 agent 不该从零开始。

Assay 是一个面向证据驱动、AI 辅助构建的 CLI 工作台。它把来源、实验、分析、ADR 和可复用知识保存在普通文件里，让决策能撑过上下文重置。

循环很简单：

```text
来源 / 实验 / 目标
        -> 结构化分析 + 检查
        -> 采纳 / 拒绝 / 实验 / ADR
        -> 知识、系统、下一轮迭代
```

它不是笔记应用，不是 agent 运行时，也不是 prompt 集合。它是"这个项目有点意思"变成"我们抄了这个模式、否了那个说法、并且以后能解释为什么"的地方。

## 布局模式

Assay 适配你代码现有的存在方式。

| 模式 | 什么时候用 | Assay 写在哪里 | Git 策略 |
| --- | --- | --- | --- |
| `standalone` | 你想要一个独立的研究 / 评估 / 攻关工作区。 | `.assay/` 存 Assay 状态，`references/`、`analyses/`、`iterations/`、`knowledge/`、`systems/` 在工作区根目录。 | 工作区 Git 可选。独立系统保留自己的 Git。 |
| `overlay` | 你已经有产品仓库，想让它的根目录作为主系统。 | 一个私有的 `.assay/` 文件夹，包含 Assay 状态和工作目录。产品文件不动。 | 产品 Git 默认忽略 `.assay/`；Assay 状态可选地在 `.assay/` 里建自己的 Git。 |

隐藏状态目录是 `.assay/`。旧文档和旧布局用 `.framework/`；新布局把它当作遗留迁移输入。

## 快速开始

从本仓库构建并链接 CLI：

```bash
git clone https://github.com/X-T-E-R/assay.git
cd assay
pnpm install
pnpm build
cd packages/assay-cli && npm link && cd ../..
```

创建一个 standalone study 工作区：

```bash
assay init ../assay-study --name AssayStudy --archetype study --layout standalone --no-track
cd ../assay-study
assay check
assay source add https://github.com/<owner>/<project> sample
assay analysis new "Review sample" --for-source sample
assay event capture --kind decision --text "采纳 hero + before/after；否掉没有依据的 benchmark 说法"
assay check
```

把 Assay 私有 attach 到一个根目录作为主系统的仓库：

```bash
cd /path/to/existing-repo
assay attach --name ExistingRepo --archetype study --privacy private
assay check
```

overlay 模式下，产品仓库还是产品仓库。Assay 把仓库根目录注册为主系统，自己的工作放在 `.assay/` 里。产品 Git 忽略 `.assay/`，所以 `git status` 保持干净。

如果以后想把 overlay 拆成独立工作台，不用动产品仓库就能 detach：

```bash
assay convert --to standalone --target ../existing-repo-assay
```

## 能用来做什么

| 想做的事 | 起步 archetype | Assay 给你 |
| --- | --- | --- |
| 学习外部项目且不丢失来源 | `study` | 活体来源、参考分析、模式笔记、决策出口 |
| 攻克一个可衡量目标 | `solve` | 目标、intake、attempts、benchmarks、迭代 |
| 跑证据导向实验 | `science` | hypotheses、experiments、datasets、findings |
| 比较工具、库或方案 | `evaluation` | candidates、criteria、scorecards、可转 ADR 的决策 |
| 探索多个可能方向 | `explore` | approaches、trials、对比笔记、迭代路径 |
| 保存持久的可复用知识 | `library` | 共享 systems 和 knowledge 作为基座 |

命令面很小：`source`、`analysis`、`iteration`、`adr`、`knowledge`、`system`、`check`。

## Git 模型

Assay 把系统代码和 Assay 记忆分开。

`standalone` 模式下，工作区 Git 是可选的。当分析、ADR、观察和知识需要评审或团队历史时再用。独立系统保留在自己的 Git 仓库里；工作台记录契约和决策，不记录它们的源码历史。

`overlay` 模式下，Assay 默认不进入你的产品仓库。`assay attach --privacy private` 把 `/.assay/` 写入仓库本地的 `.git/info/exclude`，不动已跟踪的项目文件。如果想让 Assay 记忆有版本历史又不污染产品提交，用 `--privacy private-git` 在 `.assay/` 里初始化一个独立的 Git 仓库。

## 作为 Agent Skill 使用

仓库提供面向 agent 的 Skill：`skills/assay-builder`。它直接调用当前克隆仓库里的 CLI，所以安装后要保留这个克隆目录：

```bash
git clone https://github.com/X-T-E-R/assay.git assay
cd assay
node scripts/install.mjs
```

让 agent 在任务需要来源研究、证据捕获、ADR、迭代或可复用知识时使用 Assay Builder skill。心智模型很简单：别只是"看几个例子"；打开一个来源、分析它、关闭决策、把持久的发现沉淀成知识。

安装参数和调用细节见 `skills/assay-builder/references/cli-setup.zh.md`。

## Assay 故意不做的事

Assay 不会替你跑模型、不会把文件藏进数据库、也不会让你信任一个黑盒 agent 循环。你的工作始终是普通文件。价值在于结构：来源可追踪、分析必须带观察、重要选择能变成 ADR 或可复用知识，而不是口口相传。

## 了解更多

- [布局模式](docs/layout-modes.md)
- [命令参考](docs/commands.md)
- [工作区结构](docs/workspace-layout.md)
- [贡献指南](CONTRIBUTING.md)

如果 Assay 帮你少读了一遍同样的来源，给它点个 star，让其他 agent 构建者也能找到。
