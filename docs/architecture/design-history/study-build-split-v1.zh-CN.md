# 历史方案：Study / Build 显式拆分 V1

> 状态：历史设计稿，不再是当前推荐。它正确识别了“长期吸纳”和“目标工作”的生命周期差异，但错误地把这种差异固化成工作区类型、命令路由和一对一组合。V2 改为同形工作区与逐 Source 引用。

## 结论

把原来的 Assay 拆成两个可独立工作的边界是合理的，但只有在拆分保持**不对称、单向、无第三份存储**时才会更简单：

- **Study** 负责认识外部世界：Source、Source observation、通用 Analysis、Knowledge。
- **Build** 负责对目标采取行动：Project、System、Task、Spec、Roadmap，以及 Source adoption。
- **Assay** 不是第三种工作区，也不保存一套重复对象；它只是一个 Build 连接一个 Study 后形成的统一命令体验。

一个 Study 可以被多个 Build 复用。Study 不记录反向使用者，Build 只保存一条 Study 路径。现有大型 Source 和 checkout 留在原地；从旧工作区拆分时，只移动体积小、归属清晰的 Build 内容。

## 为什么比单体 Assay 更合理

旧模型把两种生命周期放在同一持久化边界中：

1. Source 的吸纳、观察与知识沉淀通常跨项目复用，生命周期长；
2. Task、Spec、System 与 adoption 强依赖当前目标，生命周期短，且经常归档或重组。

把两者长期绑在一起，会导致同一 Source 在多个 Assay 中重复 clone、重复吸纳，也让“这是 Source 的事实，还是当前项目的判断”难以区分。Study / Build 拆分后，共享单位成为完整的认知工作区，而不是 checkout 字节或某个缓存条目。

## 权威归属

| 对象 | 权威位置 | 原因 |
| --- | --- | --- |
| Source checkout、材料、observation、通用 brief | Study | 与具体项目无关，可跨 Build 复用 |
| 通用 Analysis、Knowledge | Study | 表达对 Source 或领域的可复用理解 |
| Project、System、Task、Spec、Roadmap | Build | 直接服务当前建设目标 |
| Source adoption | Build | “采用什么、用于哪个 System”是目标相关决定 |
| Study 连接路径 | Build | 关系由消费方拥有，Study 无须维护反向索引 |

边界判断使用一个简单问题：**换一个产品或目标后，这份内容是否仍然原样成立？** 原样成立的放 Study；需要重新判断的放 Build。

## 组合关系

```text
Study A  <----- Build 1
         <----- Build 2

Build 1 + Study A = Assay（组合视图）
Build 2 + Study A = 另一个 Assay（组合视图）
```

约束刻意很少：

- 一个 Build 最多连接一个 Study；
- 一个 Study 可被任意多个 Build 使用；
- Build 可以不连接 Study，单独管理 Task / System / Spec；
- Study 可以完全独立，用于长期吸纳和整理；
- 连接是本地路径关系，优先保存相对路径；
- 路径失效时显式重新连接，不自动扫描或修复；
- 不建立 Study → Build 的反向登记。

不支持一个 Build 同时挂多个 Study。真正需要多套知识域时，先在 Study 侧完成合并，或拆成多个 Build。这个限制避免重新引入 Workset、挂载优先级、同名 Source 冲突和跨库查询语义。

## Assay 的含义

“Assay”从持久化容器改为组合体验：

- 从 Study 进入，只能执行吸纳侧工作；
- 从独立 Build 进入，只能执行建设侧工作；
- 从已连接 Study 的 Build 进入，Build 命令落在本地，Study 命令透明转到连接的 Study；
- 任何命令只有一个权威写入位置，不做双写和同步。

因此组合不是复制、导入或 overlay，也没有第三份 manifest。它只是解析命令应该在哪个根目录执行。

## 旧工作区拆分原则

拆分现有 Assay 时，默认把原目录保留为 Study，因为大型 Source、checkout、observation 通常已经稳定存在，不应为了抽象整洁而搬家。

```text
旧 Assay（原路径）                新 Build（新路径）
├── sources/        保留           ├── project/
├── analysis/       保留           ├── systems/
├── knowledge/      保留           ├── tasks/
├── project/        ─────移动────>  ├── specs/
├── systems/        ─────移动────>  ├── roadmaps/
├── tasks/          ─────移动────>  └── adoptions/
└── ...
```

只移动小目录；不移动 checkout，不重新 clone，不通过硬链接或 CAS 重写存储。拆分完成后，新 Build 保存到原 Study 的连接。

## 好处

### 1. 跨项目复用成为自然能力

多个 Build 直接使用同一个 Study，不再重复 clone Source，也不必让模型从零建立同一份通用认知。复用的是完整、人工可读的吸纳结果，而不是不透明缓存。

### 2. 生命周期匹配

Study 可长期维护，Build 可随产品阶段创建、归档或删除。任务重组不会扰动 Source，Source 更新也不会搬动任务目录。

### 3. 语义更清楚

“Source 的事实”和“项目决定”有明确归属。尤其 adoption 留在 Build，避免 Study 被具体产品污染。

### 4. 日常摩擦仍然低

连接后仍从 Build 根使用统一 CLI，不要求用户频繁切目录。拆分增加的是一条连接，而不是一套上下文管理系统。

## 代价与风险

### 1. 本地路径可能断开

移动或删除 Study 后，Build 的连接会失效。当前设计选择显式报错并重新连接，而不是引入全局 registry、邻居扫描或自动修复。

### 2. Study 更新会影响多个 Build 的可见内容

这是共享的本意。需要冻结历史证据时，应在 observation / revision 层固定版本；需要独立 checkout 状态时，应建立另一个 Study，而不是在组合层加入版本覆盖。

### 3. 跨根备份需要意识

只备份 Build 不会自动包含 Study。组合关系不是打包关系。需要可携带交付时，显式同时打包两者即可。

### 4. Analysis 的边界需要纪律

通用分析放 Study；针对某个 System 的评估、方案和 adoption rationale 放 Build。无需新增复杂类型系统，目录和文档约定已足够。

## 被明确拒绝的设计

- Workset / active context；
- 全局 Source Store、CAS、GC；
- Capsule 或 profile-keyed 吸纳缓存；
- Study 的 Build 反向索引；
- 多 Study overlay、挂载优先级和同名合并；
- 自动发现、自动重绑、自动迁移；
- Assay 作为第三套落盘目录；
- Source checkout 随组合关系移动。

这些能力都可以在未来由真实使用证据触发，但不应成为第一版拆分的成本。

## 可行性判断

可行性高。现有对象天然分成两组，组合只需要根目录解析和一条单向路径。真正需要谨慎处理的不是数据模型，而是命令归属：Source / Analysis / Knowledge 必须落到 Study，Task / System / Spec / Roadmap / Adoption 必须落到 Build。实现与测试应围绕这条单写原则，而不是增加大量 schema 校验。

## 何时应推翻本设计

只有出现以下稳定事实时，才应扩展模型：

- 大量 Build 必须同时挂载多个相互独立的 Study；
- Study 经常移动，手动重新连接成为主要摩擦；
- 同一个 Study 的共享更新经常破坏 Build 的可复现性；
- 通用 Analysis 与目标相关 Analysis 在实际中无法靠简单归属规则区分。

在这些证据出现前，`Study + Build = Assay` 已经是能解决当前问题的最小模型。
