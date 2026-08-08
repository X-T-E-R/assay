# Assay

**Study many. Grow your own.**

Assay 把来源研究、实验和 AI 辅助构建变成你的仓库能记住的决策。

可以作为独立工作台运行，也可以私有地 attach 到你正在发布的仓库上。

> English version: [README.md](README.md)

## Assay 做什么

你的 agent 一个下午能看二十个仓库。没有工作台，有价值的东西会消失在聊天记录里：什么重要、什么失败、采纳了什么、为什么下一个 agent 不该从零开始。


循环很简单：

```text
来源 / 实验 / 目标
        -> 结构化分析 + 检查
        -> 知识、系统和有边界的 Task
```

它不是笔记应用，不是 agent 运行时，也不是 prompt 集合。它是"这个项目有点意思"变成"我们抄了这个模式、否了那个说法、并且以后能解释为什么"的地方。

## 选择启动方式

Assay 适配你代码现有的存在方式。

| 模式 | 什么时候用 | Assay 写在哪里 | Git 策略 |
| --- | --- | --- | --- |
| `standalone` | 你想要一个独立的研究 / 评估 / 攻关工作区。 | `.assay/` 存 Assay 状态，`tasks/`、`sources/`、`analyses/`、`knowledge/`、`systems/` 在工作区根目录。 | 工作区 Git 可选。独立系统保留自己的 Git。 |
| `overlay` | 你已经有产品仓库，想让它的根目录作为主系统。 | 一个私有的 `.assay/` 文件夹，包含 Assay 状态和工作目录。产品文件不动。 | 产品 Git 默认忽略 `.assay/`；Assay 状态可选地在 `.assay/` 里建自己的 Git。 |

## 选择要构建的工作区

Archetype 决定工作区结构和默认约定。它是**结构 + 约定 + 通用动词**，不是一组单独命令。

| 想做的事 | 起步 archetype | Assay 给你 |
| --- | --- | --- |
| 学习外部项目且不丢失来源 | `study` | 活体来源、参考分析、模式笔记、决策出口 |
| 攻克一个可衡量目标 | `solve` | 目标、intake、attempts、benchmarks、tools |
| 探索多个可能方向 | `explore` | approaches、trials、对比笔记 |


## 让同一个结果跨上下文继续

`assay task` 给一个有边界的结果分配稳定身份。换 session、换 agent、发生
compaction，或针对同一结果继续尝试时，仍使用同一个 Task。Task 是普通目录：
`task.json` 只保存机器 envelope 和兼容元数据，`prd.md` 是人和模型直接编辑
的任务合同。只有真的要把当前状态交给另一个 session 或 agent 时，才添加
`handoff.md`。

standalone 把 Task 存在 `tasks/<id>/`，overlay 存在
`.assay/tasks/<id>/`。同一工作区可以同时有多个 Task，也允许重名；命令始终用
Task 使用 `task-0001-<slug>` 形式的可读稳定 ID 寻址。`finish` 只更新生命周期状态，不会自动 archive、提交 Git、
验收结果、修改 roadmap 或推进 Relay。

`current` 也不猜：显式 Task id 优先，其次读取
`.assay/task-contexts.json` 中完全匹配的 host context binding；都没有就返回
none。Assay 不按 active 数量、创建时间或标题推断。文件合同、生命周期、关系
和权限边界见 [Task records](docs/task.md)。

## 明确 Project、Roadmap 与 Spec 的 authority

每个工作区都恰有一个原生 Project：standalone 位于 `project/`，overlay 位于 `.assay/project/`。Project 使用 `project-<slug>`。Roadmap Item 位于 `roadmap/<roadmap-id>/`：`item.yaml` 保存封闭机器状态，`outcome.md` 保存读者可直接编辑且生命周期命令不会重写的结果说明；根 `roadmap/README.md` 只作说明，不生成动态索引。原生 Spec 按需位于 `specs/<spec-id>/{spec.yaml,specification.md}`，可从 Analysis 或 Task 显式提升当前约束而不修改来源。Project 选择的 `relay/` 与 `extensions/` 也按需创建。Source、Analysis、Task、System 与 `.assay/` 运行时状态继续拥有各自独立的 authority。详见 [Native specifications](docs/spec.md)。


## 注册外部插件元数据

外部插件由 Assay 之外的 host 安装、激活和执行。工作区创建后，可以注册独立发布的 descriptor：

```bash
assay init ../product-assay --name Product
assay plugin register ./assay-plugin.json
assay plugin observe ./host-observation.json
assay plugin list
assay plugin check
assay plugin disable <external-id>
assay plugin enable <external-id>
assay plugin remove <external-id>
```

Assay 把精确 descriptor 与 artifact 元数据锁定在 `.assay/external-plugins.json`（schema 1），并分别呈现 descriptor verification、Assay enablement、host installation/activation 和 health。这些命令不会安装、激活、停用、卸载、导入或执行外部 package；host-owned locator 始终是不透明元数据，Assay 不解析也不删除。

manifest schema 3 继续允许可选的通用 `plugins` 与 `bindings` 字段，但 core 不再根据它们安装或 reconcile built-in。新建工作区不会创建 built-in plugin receipt state。

本仓库包含未发布的 metadata/control-plane descriptor：`packages/assay-plugin-ponytail/assay-plugin.json`。它只引用外部 Ponytail artifact，不安装或执行 Ponytail，也不表示上游项目认可。

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
assay init ../assay-study --name AssayStudy --archetype study --no-track
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

`assay check` 默认只检查工作区结构和持久化记录完整性。需要查看未完成草稿、待处理队列、迁移归档或来源大版本变化等提醒时，显式运行 `assay check --advisories`。这些提醒不会把普通工作状态变成失败。

如果以后想把 overlay 拆成独立工作台，不用动产品仓库就能 detach：

```bash
assay convert --to standalone --target ../existing-repo-assay
```

## 作为 Agent Skill 使用

仓库提供面向 agent 的 Skill：`skills/assay-builder`。它直接调用当前克隆仓库里的 CLI，所以安装后要保留这个克隆目录：

```bash
git clone https://github.com/X-T-E-R/assay.git assay
cd assay
node scripts/install.mjs
```


安装参数和调用细节见 `skills/assay-builder/sources/cli-setup.zh.md`。

## Git 模型

Assay 把系统代码和 Assay 记忆分开。


`overlay` 模式下，Assay 默认不进入你的产品仓库。`assay attach --privacy private` 把 `/.assay/` 写入仓库本地的 `.git/info/exclude`，不动已跟踪的项目文件。如果想让 Assay 记忆有版本历史又不污染产品提交，用 `--privacy private-git` 在 `.assay/` 里初始化一个独立的 Git 仓库。

## Assay 故意不做的事


## 了解更多

- [布局模式](docs/layout-modes.md)
- [命令参考](docs/commands.md)
- [Task 记录](docs/task.md)
- [Source Adoption](docs/source-adoption.md)
- [工作区结构](docs/workspace-layout.md)
- [贡献指南](CONTRIBUTING.md)

如果 Assay 帮你少读了一遍同样的来源，给它点个 star，让其他 agent 构建者也能找到。
