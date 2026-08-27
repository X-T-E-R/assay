# 历史方案：稳定 Source Home V1

> 状态：历史设计稿。其“Source 留在原地、其他工作区引用”的核心被 V2 保留；“System 是唯一局部作用域”和 Task 的强制物理分区不再与 Source Reference 捆绑发布。

## 当时的结论

上一轮设计在推翻 Workset、Source Store 与 Capsule 后，收敛为四个概念：

- Assay 是研究或建设边界；
- System 是局部作用域；
- Task 跟着 Project 或 System 作用域放置；
- Source 的实体留在稳定位置，由其他 Assay 以轻量 alias 引用。

```text
Assay
├── Project
├── Systems（少量）
│   └── 每个 System 声明自己常用的 Source aliases
├── Tasks
│   ├── project/
│   └── systems/<system-id>/
└── Sources
    ├── owned source home
    └── aliases pointing to source homes elsewhere
```

## 为什么要推翻 Workset

Workset 与已有 System、Task、Source 的语义重叠。它迫使用户额外回答：

- 当前工作属于 System 还是 Workset；
- Source 属于 Workspace、System 还是 Workset；
- 一个跨 System Task 应该进入哪个 Workset；
- 当前激活的 Workset 是什么。

这些问题不是原始需求，而是新抽象制造的。Assay 本来就鼓励一个工作区只保留少量 System；真正需要的是轻量组织，而不是另一个上下文容器。

## Task 设计

Task 小、归属明确、移动成本低，因此可以按作用域物理整理：

```text
tasks/
├── project/
│   └── task-0012-compare-systems/
└── systems/
    ├── compiler-a/
    │   └── task-0004-fix-parser/
    └── compiler-b/
        └── task-0010-measure-latency/
```

规则只有两条：

1. 明确服务单个 System 的 Task 放在该 System 下；
2. 跨 System、研究性或 Project 级 Task 放在 `project/` 下。

Task ID 不随目录移动而变化。一个 Task 不做多 System 归属；真正跨 System 的 Task 就是 Project Task。

## System 与 Source

每个 System 可声明一组常用 Source aliases：

```yaml
system: compiler-a
sources:
  - llvm
  - mlir
  - benchmark-suite
```

它只决定默认展示与上下文建议，不是权限边界。同一 Source alias 可以被多个 System 使用，System 也不“拥有” Source。

## Source Home

一个已经存在的完整 Source 目录被视为 Source Home：

```text
some-assay/
└── sources/
    └── qiskit/
        ├── source.yaml
        ├── checkout/
        ├── materials/
        ├── observations/
        ├── manifests/
        └── brief.md（可选）
```

它拥有唯一物理 checkout、lineage、observations、materials 与对该 Source 的通用简报。

另一个 Assay 使用该 Source 时，不重新 clone，也不要求把它搬进公共仓库；只保存一条指向 Source Home 的关系。Source 字节始终留在原处。

## 只读还是可写

V1 倾向把 consumer 看作只读视图：

- Source Home 所在 Assay 是 owner；
- 其他 Assay 只读取；
- sync、switch 等动作回到 owner 一侧执行；
- 若项目需要独立分支或独立更新节奏，则另建一份 Source。

这条在 V2 中被重新评估。V2 采用更接近路径 alias 的“显式写穿透”语义：Source-native 命令可以作用于 home，但必须在输出中明确真实目标；删除 reference 只删除本地空壳。

## Token 复用

V1 不再引入 Capsule。Source Home 中使用一份简单的 `brief.md` 记录：

- Source 是什么；
- 入口与目录结构；
- 关键术语；
- 已确认的通用结论；
- 相关 Analysis；
- 最近一次依据的 observation。

另一个 Assay 首先读取 `brief.md`、materials 与 observations，不再从整个 checkout 开始建立认知。

项目相关判断仍留在当前 Assay，例如：

- 这个 Source 对当前产品有什么价值；
- 哪些内容应采用到 System A；
- 当前约束下应如何改造。

## V1 的价值与局限

V1 的价值是识别出真正稳定的复用单位是 **Source Home**，并明确大文件不应围绕上下文频繁搬动。

它的局限是仍然把 System 作用域与 Source 复用绑在同一轮设计中，而且“consumer 只读”会让用户频繁切换目录。V2 因此保留 Source Home，取消工作区角色和强制上下文模型，并把引用明确建模为 Source entry 的第二种物理形态。
