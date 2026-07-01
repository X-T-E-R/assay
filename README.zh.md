# Assay

**Study many. Grow your own.**

一个命令行工作台,面向那些你想借鉴的系统、工具和工作流 —— 把它们作为持续变化的来源来观察,用评估视角逐一鉴别,再把值得保留的模式提炼进你自己的系统。

> English version: [README.md](README.md)

## 工作原理

Assay 管理一个项目工作区,把"研究外部事物"和"构建自己的东西"合成一条可追踪的循环:

```text
references -> analyses -> systems -> iterations -> knowledge
```

你添加或吸收一个来源、分析它、把值得保留的部分并入自己的系统、迭代这个系统,再把可复用的结论提炼进 knowledge。每一步都是一条写入事件的 CLI 命令 —— 工作区记录的是你研究了什么、决定了什么,而不只是产生了哪些文件。

两个设置决定工作区的行为:

- **archetype(项目类型)** —— 这是哪种项目:`research`(研究多个对象)、`contest`(攻克单一问题)、`library`(构建可复用系统)。它决定开启哪些能力包。
- **mode(模式)** —— 吸收的来源落在哪里:`learning` 把外部来源作为 reference 来研究;`absorption` 把来源当作项目本身,材料落在 `problem/`。当整个工作区就是为了重建或解决某个具体对象而存在时,用 absorption。

两者都在 `init` 时选定,之后随时用 `assay archetype` 读回。

## 快速开始

安装依赖并构建 TypeScript 包:

```bash
pnpm install
pnpm build
```

`pnpm build` 在 `packages/assay-cli/dist/cli.js` 生成 CLI。两种方式都能运行:

- 直接运行:`node /path/to/assay/packages/assay-cli/dist/cli.js <command>`
- 在 `packages/assay-cli` 里 `npm link` 后,作为全局 `assay` 命令运行。

下面的示例用 `assay` 以便阅读。创建并检查你的第一个工作区:

```bash
mkdir ../assay-demo
cd ../assay-demo
assay init --name Assay --archetype research --mode learning
assay check
assay status
```

接着添加一个会继续变化的外部来源:

```bash
assay source add /path/to/some-project some-project
assay source status some-project
assay source sync some-project
assay source diff some-project
```

`source add` 会创建 `references/<alias>/`:里面有 `source.yaml`、当前 `checkout/`、精选 `materials/`、`history.md`,以及内部 `.assay/` observation 账本。对 Git 来源,`checkout/` 本身就是仓库根目录,所以 `references/<alias>/checkout/.git` 是预期状态。

为这个来源 observation 打开并关闭 analysis:

```bash
assay analysis new "Review some-project" --for-source some-project
# 在打开的 analysis 里填写 ## Key observations 和对应决策段
assay analysis close analyses/references/<file>.md --exit adopt
assay check
assay status
```

`analysis close` 默认拒绝空 analysis 壳。关闭绑定到 living source 的 analysis 会把对应 observation 标记为已审阅,这样 `check` 才能清掉 major 变化的 stale-risk 警告。

旧的完整快照“冻结并打开 analysis”流程仍然可用:

```bash
assay absorb /path/to/some-project --name some-project
# 在打开的 analysis 里填写 ## Key observations / ## Adopt / ## Reject
assay analysis close analyses/<file>.md --exit adopt
```

`absorb` 一步完成:冻结来源、写入案例文件、打开一份预填的 analysis。关闭 analysis 才会把这个 reference 标记为已分析并记录决定 —— 冻结了却没有 analysis 的来源是未完成的工作,`assay check` 会把它标出来。

## 常用命令

这些命令在工作区内运行,会向上查找 `.framework/manifest.json`。要操作别处的工作区,传 `--root <dir>`。

```bash
# 工作区生命周期
assay init --name <project> --archetype research|contest|library --mode learning|absorption
assay check                              # 结构 + 内容健康校验
assay status                             # 系统、未关闭的 iteration、knowledge 计数
assay update --dry-run                   # 应用前预览受管文件升级
assay migrate-layout --dry-run           # 规划旧布局迁移(v2 -> v3)

# 循环
assay source add <repo-or-dir> [alias] [--branch <branch>] [--capture checkout|thin|metadata|archive]
assay source sync [alias] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--sync]
assay source status [alias]
assay source diff <alias> [--since <observation>]
assay source log <alias>
assay absorb <source-dir> [--name <name>] [--as problem|intake]
assay reference add <source-dir> <name>  # 旧式/完整快照冻结,不开 analysis
assay analysis new "Title" [--for-source <alias>] [--observation <id>] [--for-reference <path>]
assay analysis close <path> --exit adopt|reject|experiment|adr [--allow-empty]
assay iteration start "Title"
assay iteration close <selector> --result applied|rejected|retest
assay knowledge add <type> "Title"

# 系统、ADR、注册表
assay system register <path> [--primary] [--vcs independent-git|embedded|none]
assay system promote|archive|list|show <selector>
assay adr new|accept|supersede|deprecate|list|show
assay projects list|scan|show|forget|prune
```

## 接管已有项目

当前目录已经是一个普通项目、而你想在它外面套一个干净的 Assay 工作区时,用 `adopt`。务必先 dry-run。

```bash
cd /path/to/existing-project
assay adopt --dry-run
assay adopt --apply --name ExistingProject --analyze
```

`--apply` 把当前根目录归档进带时间戳的 `.old/`,保留 `.git/` 原位,并创建标准结构。`--analyze` 会打开一份接管清单,列出每个归档条目及建议去向。方向明确后,把归档内容移进新结构;只要 `.old/` 还有未迁移内容,`assay check` 就会告警。

`assay init` 和成功的 `assay update` 会把工作区登记到用户级注册表 `~/.assay/projects`。`assay projects` 系列命令只管理注册表元数据 —— 绝不删除项目文件。

## 工作区包含什么

```text
.framework/   版本、manifest、事件、迁移、备份、注册表
references/   活的外部来源、intake 笔记与旧式 frozen 快照
problem/      正在重建或解决的来源(absorption 模式)
analyses/     reference 分析、gap 分析、候选 pattern
systems/      你自己的系统实现
iterations/   对自己系统的计划性改动
knowledge/    已接受、可复用的知识 —— 包括 knowledge/decisions/ 下的 ADR
data/         样本、评估数据、实验输入与输出
releases/     发布说明、打包产物、迁移指南
```

`assay-core` 负责受管模板、manifest、更新规划和迁移逻辑;CLI 只是它之上的薄适配层。你的文件由 manifest、哈希校验、dry-run 更新和迁移规划保护 —— 除非你传 `--force`,否则 `update` 会跳过你改过的文件。

## 作为 agent skill 使用

仓库在 `skills/assay-builder` 提供一个面向 agent 的 skill,直接运行本仓库的 CLI —— 没有打包副本。克隆仓库并运行安装脚本即可,它会构建工作区,并把 skill 链接进你的 skills 目录:

```bash
git clone <repo-url> assay
cd assay
node scripts/install.mjs            # 构建 + 链接进 ~/.agents/skills
```

保持克隆的仓库在原地,链接好的 skill 会解析回它。参数和调用细节见 `skills/assay-builder/references/cli-setup.zh.md`。

## 开发 Assay

```text
packages/assay-core/      框架操作、schema、模板、更新/迁移逻辑
packages/assay-cli/       core 之上的 Commander CLI 适配层
skills/assay-builder/     面向 agent 的 skill
examples/framework-template/   一个脱敏的、生成出来的工作区
docs/decisions/           本仓库自己的 ADR 和迁移说明
docs/background/          设计笔记,以及影响了框架的参考
scripts/                  校验与安装辅助脚本
```

本地开发脚本:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

提交改动前跑完整的仓库检查:

```bash
./scripts/check.sh        # Windows PowerShell 上用  .\scripts\check.ps1
```

该检查会跑构建、typecheck、lint、测试,以及一条覆盖 help、init、adopt dry-run/apply、check、status、update dry-run、项目列举和迁移 dry-run 的 CLI 冒烟流程。

保持仓库可发布:可复用的代码、模板、文档和脱敏示例属于这里;运行时日志、私有参考、本机绝对路径、密钥和构建产物(`dist/`)留在外面。未来的 GUI 代码应直接引用 `assay-core`,而不是去 shell 调用 CLI。
