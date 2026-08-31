<div align="center">
  <img src="docs/assets/hero.svg" alt="Assay — 原料进，知识出" width="880" />

  <h1>Assay</h1>

  <p><em>assay /əˈseɪ/，动词——化验矿石，确定它的成分。</em></p>

  <h3>Absorb anything. Build your own. 什么都能吸纳，自成一体。</h3>

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

Assay 是一个命令行工作台，由两个半边组成：

- **[absorb-anything](https://github.com/NB-Corp/absorb-anything)** 是研读半边。你正在吸纳的任何东西——一个代码库、一个准备借鉴的库、论文的配套仓库——都得到一个家：checkout、观察记录、分析和沉淀下来的知识在这里积累，而不是随会话蒸发。
- **[own-work](https://github.com/NB-Corp/own-work)** 是建设半边。带稳定身份的 Task、Roadmap、Spec 和注册 System，跨会话、跨 agent、跨上下文压缩依然可寻址。

两个半边各自都是独立产品、可单独使用。Assay 把它们缝合进一个 `assay` 二进制、一个工作区——给想要完整闭环（*研读它、对它下判断、建你自己的*）的人。

## 工作方式

```text
sources/   →   analyses/   →   systems/  +  knowledge/  +  tasks/
 观察            解读             构建          记忆          推进
```

Assay 把这条闭环放进你的版本控制里。纪律很小，但很严格：每个事实只有一个权威来源，每个决策都被记录而不是被记住，所有东西都是 `.assay/` 工作区里你仓库拥有的普通文件。

## 快速开始

需要 Node.js >=22.13.0。

```bash
npm install -g @nb-corp/assay    # scoped 包名；装出来的二进制就叫 assay

# 建一个工作台（默认 standalone；--overlay 叠加进现有仓库）
assay init my-study --name MyStudy
```

想改代码的话，把三个仓库并排 clone（`NB-Corp/absorb-anything`、`NB-Corp/own-work`、`X-T-E-R/assay`），在 `assay` 里 `pnpm install && pnpm build`。典型的一次会话，全在一个二进制里：

```bash
assay add https://github.com/some/framework                 # 研读半边：给它安个家
assay analysis new "Framework review" --for-source framework
assay analysis close analyses/<file>.md --exit adopt --note "Pattern X is worth reusing"
assay knowledge add pattern "Pattern X"
assay task create --title "Port pattern X" --priority P1    # 建设半边：推进工作
assay status                                                # 两个半边的合并视图
```

AI 会话开局跑一次 `assay prime`——一屏讲清工作区里的每个对象，两个半边都在。

## 工作区

`assay init` 建的是 **standalone** 工作台：状态收在 `.assay/`，工作区域在根目录。`assay init --overlay` 则把一切收进现有仓库的 `.assay/` 里。

磁盘格式与两个半边完全同一套。这意味着 `absorb` 和 `ownwork` 可以对 Assay 工作区原地读写——Assay 也能操作它们的。一个工作区、三个可互换的工具、彼此之间零迁移。

## 里面有什么

| 对象 | 给你什么 | 半边 |
| --- | --- | --- |
| **Project** | 工作区唯一的 id/name 权威。 | 共享 |
| **Source** | 外部材料：append-only 观察账本、漂移报告、决策需要时的字节捕获。 | 研读 |
| **Analysis / Knowledge** | 带明确决策出口的解读，以及不混进收件箱的已晋升结论。 | 研读 |
| **Task** | 持久的有界结果（`task-0001-<slug>`），reader-owned `prd.md` 与交接检查点。 | 建设 |
| **Roadmap** | 状态与视野分离的项目结果，与 Task 关联但不耦合生命周期。 | 建设 |
| **Spec** | 封闭的机器信封 + reader-owned 正文，晋升时记录出处。 | 建设 |
| **System** | 独立版本化 system 的注册表，带 primary/superseded 谱系。 | 建设 |

## Assay 0.15 是换底，不是搬家

0.15 用两个组件包上的薄层替换了单体实现。0.14 的大部分命令面原样保留；值得注意的差异：

- Source 命令提到顶层（`assay add`，不再是 `assay source add`）。
- `init` 对已有工作区复用补缺而不是拒绝，且默认 standalone。
- Source adoption、upstream 触达、init 之外的模板、插件、workspace 索引（`attach` / `convert` / `workspace ...`）**暂缓**——它们需要在新 core 上重新安家。今天依赖这些流程的话请留在 [v0.14.0](https://github.com/X-T-E-R/assay/releases/tag/v0.14.0)；0.15 CLI 无论如何都能对 0.14 工作区原地读写。

完整账本见 [releases/NEXT.md](releases/NEXT.md)。

## 我该装哪个？

- 只研读外部材料，或想在现有仓库里留最轻的足迹？**absorb-anything**（`.absorb/` 信封，默认 overlay）。
- 只跟踪任务、路线图和 spec？**own-work**。
- 想要一个二进制里的两个半边，或者你已经有 `.assay/` 工作区？**Assay**。

三者共用一套磁盘契约，这个选择随时可逆。

## 文档

- [Commands](docs/commands.md) —— 合并后的 CLI 命令面与权威边界
- [Workspace layout](docs/workspace-layout.md) · [Layout modes](docs/layout-modes.md)
- [Source reference](docs/source-reference.md) —— clone 一次，处处引用
- [Design principles](docs/background/design-principles.md) —— Assay 为什么这样设计
- [examples/framework-template](examples/README.md) —— 一个净化过的生成工作区

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前跑完整检查：

```bash
pnpm check
```

## License

[MIT](LICENSE) © Assay contributors
