# ADR-0001：Framework 结构采用“外部资料 → 分析 → 本地系统 → 迭代”主链路

- 状态：Accepted
- 日期：2026-06-13

## 背景

项目目标不是简单保存资料，而是构建一个能持续学习外部系统并反哺本地系统能力的 framework。主链路围绕四个动作设计：

```text
保存外部资料、进行分析、构建本地系统、迭代本地系统
```

原有结构 `systems/references/data/experiments/knowledge` 有价值，但动作语义不够直接，尤其缺少一等 `analyses/`，且 `experiments/` 不能清晰表达“迭代本地 framework”。

## 决策

采用以下推荐结构：

```text
<framework-root>/
├── .framework/                 # framework runtime：版本、manifest、events、migrations、backups
├── references/                 # 外部项目、资料、快照，只读为主
│   ├── intake/                 # 候选收集与筛选
│   └── frozen/YYYYMM/<name>/   # 冻结快照
├── analyses/                   # 进行分析：把 reference 转化为可决策材料
│   ├── references/             # 单个外部系统分析
│   ├── gaps/                   # 与当前系统的差距分析
│   └── patterns/               # 待验证模式
├── systems/                    # 活跃 framework/skill/CLI/system
│   └── <core>/
├── iterations/                 # 本地系统迭代：每轮改造、实验、结果、回滚
├── knowledge/                  # 已验证、已采纳、可复用知识
├── data/                       # 样本、评测输入输出、研究数据
└── releases/                   # 发布包、release notes、升级说明
```

## Artifact 生命周期

```text
reference_candidate
  → frozen_reference
  → reference_analysis
  → candidate_pattern
  → iteration
  → adoption_decision
  → system_change
  → knowledge_entry
```

每个 artifact 都必须有明确出口：采纳、拒绝、继续实验、写 ADR、进入 roadmap。

## 为什么不是继续五区模型

五区模型的问题不是错，而是太“资源分类”。MetaSystem Kit 更需要“工作流分类”。`analyses/` 和 `iterations/` 一旦成为一等目录，AI 与人都更容易知道当前工作处于哪一环。

## 后果

正面：

- 结构直接服务核心目标；
- 分析不会埋在 knowledge 或 experiments；
- 本地系统迭代会被持续记录；
- 后续 update/migration 有清晰 protected 边界。

代价：

- 需要从旧结构迁移；
- 短期内会与旧文档里的 `experiments/` 命名不一致；
- 需要 CLI 提供 `migrate-layout`，避免手工搬目录造成丢失。

## protected 边界

以下目录默认视为用户数据，update 不自动覆盖正文：

```text
references/frozen/
analyses/references/
analyses/gaps/
analyses/patterns/
systems/<core>/src 或实际实现目录
iterations/
knowledge/
data/
```

只有 `.framework/`、README、模板、索引和 core docs 中被 manifest 标记为 managed 的文件，才进入模板 update 分类。
