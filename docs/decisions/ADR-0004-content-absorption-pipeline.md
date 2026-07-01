# ADR-0004：从「目录生命周期」转向「内容吸纳管线」

- 状态：Proposed
- 日期：2026-06-20

## 背景

Assay 的早期实现更像一套目录与元数据生命周期管理器：它能创建结构、复制来源、写事件和生成模板，但这些动作本身不会保证外部内容已经被理解、分析或转化成本地能力。

这会造成一个危险的健康假象：来源已经被保存，工作区结构也完整，但分析仍是空壳，待处理来源没有关闭，`check` 却可能只看到目录存在。对用户来说，「已归档」不等于「已吸纳」。

## 根因

### 回路只描述去向，缺少内容出口

`references → analyses → systems → iterations → knowledge` 是正确的主链路，但每一步还需要说明什么内容才算完成。仅把文件移动到下一层，不足以证明来源已经被提炼成可执行判断。

### CLI 只操作容器，未绑定未完成工作

早期命令能复制来源、创建 analysis 模板、初始化 workspace，却没有稳定绑定「这个来源需要哪份分析」「这份分析关闭后哪个来源才算已处理」。跨命令的未完成工作因此不够可见。

### Skill 指令过度防御，缺少正向转化要求

防止误放外部内容、保护用户数据、避免覆盖实现文件都是必要的规则。但如果只有防御规则，agent 容易把「不碰内容」误判为合规，把「冻结来源 + 写空文档」误判为完成。

## 决策

Assay 将「内容推进」做成显式、可检查的状态机。吸纳不是一个目录动作，而是一条从来源到分析、再到系统或知识的闭环。

### D1：用 manifest 记录项目身份

工作区身份由 `.framework/manifest.json` 中的 `project.archetype` 和 `project.mode` 表示：

- `learning`：外部对象是被研究的参考，主要进入 `references/`。
- `absorption`：外部对象就是项目本体，主要进入 `problem/`。

`assay init --archetype <archetype> --mode <mode>` 写入这些字段；运行时应读取 manifest，而不是读取旧的独立配置文件。

### D2：为内容出口设门槛

- Frozen reference：必须被 analysis 引用，或显式标记为已分析。
- Living source observation：必须保留 provenance、fingerprint、manifest 和 change classification；重大变化在绑定分析关闭前保持可见。
- Analysis：`## Key observations` 不能是空壳；采纳或拒绝需要写明依据。
- Iteration：关闭为 applied 时，应说明实际落到哪个系统或知识条目。

### D3：CLI 绑定来源与分析

- `assay source add` 用于会继续变化的外部来源，并把 observation 记录在来源自己的 ledger 中。
- `assay source sync` 追加新的 observation，并让重大变化继续显示为待复核工作。
- `assay absorb` 保留 freeze-and-open-analysis 流程：按 mode 把来源落到 `references/frozen/` 或 `problem/`，并打开可关闭的 analysis。
- `assay analysis new --for-reference <path>` 和 source-observation 绑定分析应预填来源信息，避免 analysis 与证据脱节。
- `assay analysis close` 负责关闭对应 reference 或 observation 的待处理状态。

### D4：Skill 工作流要求主动转化

Agent-facing Skill 应把吸纳写成强制管线：

```text
source/absorb → analysis with observations → close with adopt/reject/experiment/adr → knowledge or system change
```

最终报告不能只列出创建了哪些文件，还要说明哪些来源仍未分析、哪些 analysis 仍是 draft，以及哪些重大 observation 仍需复核。

## 分阶段实施

1. 内容健康检查：让 `assay check` 报告未分析 reference、空 analysis、遗留 adoption work 和未关闭的重大 source observation。
2. Reference/analysis 绑定：让新增和关闭 analysis 能更新对应来源的状态。
3. Living source 模型：用 `source add/sync/status/diff/log` 表达会继续变化的外部来源。
4. Mode 路由：用 manifest-backed mode 决定 `absorb` 输出到 `references/frozen/` 还是 `problem/`。
5. Skill 与文档：把 public docs、skill references 和 examples 对齐到当前命令、包名和 manifest 模型。

## 后果

正面：

- 用户可以区分「已保存来源」和「已完成分析」。
- `check` 能暴露真实未完成工作，而不是只验证文件存在。
- learning 与 absorption 两种项目身份减少来源落点误判。
- agent 工作流必须把来源推进到分析或明确遗留为 open work。

代价：

- 首次在旧 workspace 上运行新版 `check` 时，可能出现更多 warning。
- `analysis close` 需要更严格地判断正文是否有实际内容。
- 新的 source-observation 状态会增加一点元数据复杂度。

## 翻转条件

- 如果 learning/absorption 二分仍不足以表达用户项目，后续应引入更细的 source type，而不是继续扩大 mode 的含义。
- 如果自动预填 analysis 的质量不稳定，CLI 应只做绑定和可见性，把内容提炼交给 Skill 流程。

## 实施状态

本 ADR 已落入 Assay 的当前方向：workspace identity 迁到 manifest，living source model 成为默认学习路径，frozen references 保留为 legacy/full-capture 用法，文档和 examples 应继续避免旧命令名、私有验证材料和本机路径泄漏。
