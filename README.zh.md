<div align="center">
  <img src="docs/assets/hero.svg" alt="Assay — 原料进，知识出" width="880" />

  <h1>Assay</h1>

  <p><em>assay /əˈseɪ/，动词——化验矿石，确定它的成分。</em></p>

  <h3>Study many. Build your own. 博采众长，自成一体。</h3>

  <p>
    <a href="https://github.com/X-T-E-R/assay/actions/workflows/ci.yml"><img src="https://github.com/X-T-E-R/assay/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen" alt="Node.js >=22.13" /></a>
  </p>

  <p>
    <a href="https://x-t-e-r.github.io/assay/">介绍站</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="docs/README.md">文档</a> ·
    <a href="CONTRIBUTING.md">贡献指南</a> ·
    <a href="README.md">English</a>
  </p>
</div>

Assay 是一个命令行工作台，为"靠研究来建造"的人而生：

- **Study many.** 把框架、库、模式、想法捕获为可观察的 Source，在留档的 Analysis 里逐一检验，每个评估都以明确的采纳 / 拒绝 / 暂缓决策和证据关闭。几个月后你依然能回答：拿了什么、为什么、现在是否还成立。
- **Build your own.** 把验证过的成果推进你自己的 System 与 Knowledge，并用带稳定身份的 Task、Roadmap、Spec 推动工作——跨会话、跨 agent、跨上下文压缩依然可寻址。

## 工作方式

```text
sources/   →   analyses/   →   systems/  +  knowledge/
 观察            解读             构建          记忆
```

Assay 把这条闭环放进你的版本控制里。纪律很小，但很严格：每个事实只有一个权威来源，每次对外部材料的采纳都留着证据，每个决策都被记录而不是被记住。

## 最好用的场景

Assay 是一个通用工作台，但有三类场景最能发挥它的价值：

- **评估和引进外部框架。** 把一个仓库加为 living 或 frozen Source，在 Analysis 中评审，记录 `adopt` / `reject` / `experiment` 出口。Source adoption 收据随后把"你搬进自己系统的材料"与证据、accept/reject/defer 决策绑定——一年后的你能精确知道每块东西来自哪里、为什么。
- **和 AI 助手一起跑的长期项目。** Task 有稳定 id、reader-owned PRD 和交接 checkpoint；Roadmap 与 Spec 承载方向与验收。它们都能跨会话、跨 agent、跨上下文压缩存活。
- **任何证据驱动的探索。** 一次性 Template 为不同类型的工作搭建闭环：`study`（评估外部系统）、`solve`（目标、尝试、基准）、`explore`（并行方案与试验）。自定义 Template 就是普通 YAML。

## 原则

工作流是打包好的，但思想可以用在任何地方：

- **一个事实，一个权威。** Assay 不会从标题或数量猜"当前 Task"，也绝不维护同一份真相的两个副本。
- **证据先于观点。** 复制了一个目录不等于完成了评估；没有显式出口，Analysis 就不算关闭。
- **建议式，而非关卡。** Assay 记录事实与决策，然后让开路。它只在防止数据丢失或损坏时拒绝操作——绝不强制仪式流程。
- **助手无关的内核。** 工件模型独立成立；受管理的 `AGENTS.md` 块与内置的 `assay-builder` skill 只是适配器，工作台不依赖任何一个助手存活。
- **文件优于服务。** Git 友好，用你已有的工具就能检查——没有任何东西能把你的数据扣作人质。

## 快速开始

要求 Node.js >=22.13.0 与仓库固定的 pnpm 11.3.0。

```bash
git clone https://github.com/X-T-E-R/assay.git
cd assay
pnpm install && pnpm build

# 创建一个工作台
node packages/assay-cli/dist/cli.js init ../my-study --name MyStudy --template study
node packages/assay-cli/dist/cli.js status --root ../my-study
node packages/assay-cli/dist/cli.js check  --root ../my-study
```

文档中的 `assay` 均指这个构建出的 CLI（package 暴露了 `assay` bin）。想在 AI 助手中驱动它，运行 `node scripts/install.mjs`——它会构建仓库并把内置的 `assay-builder` skill 链接进你的 skills 目录。

一个典型会话：

```bash
assay source add https://github.com/some/framework --mode frozen
assay analysis new "Framework review" --for-source framework
assay analysis close analyses/<file>.md --exit adopt --note "模式 X 值得复用"
assay knowledge add pattern "模式 X" --from-analysis analyses/<file>.md
assay task create --title "移植模式 X" --description "带验收标准的有界成果"
```

## 内置对象

| 对象 | 提供的能力 |
| --- | --- |
| **Project** | 唯一的 id/name 权威，持有 roadmap 与验收。 |
| **Task** | 可持久寻址的有界成果（`task-0001-<slug>`），reader-owned `prd.md`、交接 checkpoint、类型化 lineage 关系与显式 host-context 绑定。 |
| **Roadmap** | 项目成果，state（`candidate` → `committed` → `realized`）与 horizon（`now` / `next` / `later`）分离，可链接 Task 但不耦合生命周期。 |
| **Spec** | 封闭式 machine envelope + reader-owned 正文；从 Analysis 或 Task 显式 promote 并记录来源。 |
| **Source** | living/frozen 外部材料，不可变 observation 账本、漂移报告与 checkout 数据丢失防护。 |
| **Source adoption** | 上游材料进入自有系统的可追溯采用关系，含证据记录与 accept / reject / defer 决策。 |
| **Analysis / Knowledge** | 带显式决策出口的解读，以及被提升后不再堆在 inbox 里的结论。 |
| **System** | 独立版本化系统的注册表（可以是各自独立的 Git 仓库），含 primary/superseded 谱系。 |

## 两种布局，同一模型

- **Standalone** — Assay 状态在 `.assay/` 下，工作区在根目录。
- **Overlay** — 一切收进已有产品仓库的 `.assay/` 内；产品仓库根仍是 primary System。

```bash
assay attach --root ../product --name Product --template study --privacy private
assay convert --root ../product --to standalone --target ../product-workbench --copy
```

除非你显式 opt-in workspace 索引（`assay workspace track|discover|list|forget`），Assay 不触碰任何全局状态。

## 工作区契约

Assay 0.13 只接受 `0.13.0+s4+l8+r3` envelope，对旧版或畸形工作区 fail closed。兼容升级走原生 `assay update` 路径，只触碰 managed receipt 记录的框架文件。当 Assay 报告 `assay-cutover:<observed>-><required>` locator 时，按[工作区跨边界 cutover](docs/legacy-cutover.md)处理。

## 文档

- [命令](docs/commands.md)——完整 CLI 面与权威边界
- [工作区布局](docs/workspace-layout.md) · [布局模式](docs/layout-modes.md)
- [Task](docs/task.md) · [Roadmap](docs/roadmap.md) · [Spec](docs/spec.md)
- [Source adoption](docs/source-adoption.md)——关系、证据、决策
- [设计原则](docs/background/design-principles.md)——Assay 为什么这样工作
- [examples/framework-template](examples/README.md)——脱敏的生成工作区示例

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前运行完整检查：

```bash
pnpm check
```

## License

[MIT](LICENSE) © Assay contributors
