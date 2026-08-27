# Assay V2 常见场景模拟与别扭点审查

## 评估方法

每个场景检查四件事：

1. 用户自然会做什么；
2. V2 需要用户理解多少额外语义；
3. 是否出现隐蔽写入、重复数据或不可解释的归属；
4. 若别扭，是否值得增加新机制，还是应接受简单边界。

评级：

- **顺畅**：行为接近普通本地文件与 alias；
- **可接受**：有明确代价，但不值得扩展模型；
- **警惕**：第一版必须写清楚或测试；
- **失败信号**：若高频出现，应重新设计。

## 场景 1：一个 Source 研究空间，多个产品复用

```text
research/sources/qiskit/source.yaml
product-a/sources/qiskit/source.ref.yaml -> research#qiskit
product-b/sources/qiskit/source.ref.yaml -> research#qiskit
```

**行为**：两个产品只有几十字节的空壳，共享 checkout、observations、materials 与 brief。各自的 Task、Analysis 和 Adoption 保持独立。

**评价：顺畅。** 这是 V2 的主场景。它同时减少磁盘重复和模型重新认识 Source 的成本。

**注意**：`source sync` 从任一 product 发起都会更新同一 home。CLI 必须显示真实目标，不能假装在本地更新。

## 场景 2：一个产品从多个工作区取 Source

```text
product/sources/qiskit     -> quantum-research#qiskit
product/sources/ui-kit     -> another-product#ui-kit
product/sources/benchmark  -> shared-data#benchmark
```

**评价：顺畅，且明显优于“一 Build 只能连接一个 Study”。**

逐 Source 引用没有挂载顺序，也没有两个工作区都拥有 `qiskit` 时的全局冲突；consumer 通过本地 alias 自己命名。

## 场景 3：同一 Source 在两个项目中需要不同分支

项目 A 需要 `main`，项目 B 需要旧 release branch。

**V2 行为**：不能在 ref 中覆盖 branch。应建立两个 owned Source homes，例如：

```text
research/sources/qiskit-main/
research/sources/qiskit-release/
```

或由项目 B 自己拥有独立 Source。

**评价：可接受。** 表面上多了一份 checkout，但它们已经不是同一个可变状态。若在 ref 中加 branch override，就必须引入 worktree、锁、状态隔离与 per-consumer observation，复杂度远大于节省的目录。

**失败信号**：若绝大多数 consumers 都需要不同 revision，live ref 的命中率低，应转向 frozen observation import；目前没有该证据。

## 场景 4：Source Home 被移动

用户把 `C:\Research\quantum` 移到 `D:\Knowledge\quantum`。

**V2 行为**：引用显示 broken，用户重新执行 `source link` 或编辑一条路径。不会全盘扫描磁盘，也不会自动猜新位置。

**评价：可接受。** 用户已明确大型 Source 目录不会频繁移动。为低频移动建立 registry、自动 rebind 与全局 ID 不划算。

**优化**：若 consumer 与 home 位于同一父目录树，优先存相对路径；整个父目录一起搬动时引用仍有效。

## 场景 5：Source Home 被删除，但 consumer 还在

**V2 行为**：consumer 的 reference 断开。历史 Analysis/Adoption 若已固化 observation fingerprint，仍能解释当时决定，但 checkout 和非 archive living 历史字节未必可恢复。

**评价：警惕，但不增加删除关卡。**

这是 live relationship 的真实代价。删除 Source Home 前，用户若需要独立保存，应先创建 frozen capture 或复制 Source。第一版不维护反向 dependents 索引，也不阻止删除，因为那会把 Source Reference 变成生命周期管理器。

**失败信号**：若误删 home 高频发生且造成实质损失，再考虑显式 `source dependents` 索引；不能提前建设。

## 场景 6：从 consumer 执行 `source sync`

**行为**：命令解析到 home，使用 home workspace 的锁与 event ledger，输出：

```text
qiskit is referenced from ../../research#qiskit
syncing shared Source Home: C:\Research\quantum\sources\qiskit
```

**评价：顺畅，但必须透明。**

只读 ref 会迫使用户切目录，违背聚合体验；隐蔽写穿透又会造成惊讶。显示真实 home 是最小而足够的折中，不需要确认弹窗。

## 场景 7：从 consumer 删除 Source

用户只想让当前项目不再使用 qiskit。

**V2 行为**：`source unlink qiskit` 或对 ref 执行 remove，只删除 `source.ref.yaml` 空壳；绝不删除目标。

**评价：顺畅。** 这是唯一需要与普通 alias 写穿透不同的操作，因为“删除本地名字”与“删除共享实体”必须分开。

## 场景 8：共享 Source checkout 有未提交修改

**行为**：所有 consumers 都能看到相同 dirty 状态；Source Home 的既有安全规则决定 sync/switch 是否允许。

**评价：可接受。** 共享 Source 只适合 canonical checkout。某个项目需要实验性编辑时，应拥有独立 Source，而不是把 consumer-local patch 叠加到 ref 上。

**失败信号**：若用户经常直接在共享 checkout 做项目特定修改，说明 Source Home 的使用纪律不成立，需要改为 frozen 或 fork 流程。

## 场景 9：在 consumer 创建 Analysis

用户在 product workspace 中执行：

```bash
assay analysis create "Qiskit 对当前产品的价值" --for-source qiskit
```

**行为**：Source observation 从 home 解析，但 Analysis 文件写在 product 的 `analyses/`。

**评价：顺畅。** 标题本身是项目相关判断，写在当前 workspace 最自然。

若用户写的是“Qiskit 包结构与核心入口”，希望跨项目复用，则应在 home workspace 中创建，或把结论整理进 Source 的 `brief.md`。

**别扭点**：工具无法可靠判断一份分析是否“通用”。V2 接受这个人类判断，不引入 Analysis 类型或自动搬运。

## 场景 10：用户看到了 Source，却不知道已有通用分析

Reference 只挂载 Source，不自动挂载 target workspace 的 `analyses/`。

**风险**：模型仍可能重复研究。

**V2 应对**：

- Source Home 使用 `brief.md` 作为稳定入口；
- `brief.md` 链接重要 Analysis；
- 显式 `source show` 可显示 home workspace 与相关分析路径；
- 不把所有外部 Analysis 混入本地 `analysis list`。

**评价：警惕。** 这是 V2 对“认知重做”的解是否足够的关键。若用户已经看到 brief 和相关路径仍反复重做，Source Reference 只能解决存储，不能解决认知复用；届时才有证据考虑更强的 research closure/capsule。

## 场景 11：同一 consumer 中两个 alias 指向同一 home

```text
sources/qiskit/source.ref.yaml
sources/quantum-sdk/source.ref.yaml
```

两者都指向同一目标。

**行为**：`source link` 检测到已有目标时可返回“already linked as qiskit”，默认不再创建；手工写文件则仍可存在。

**评价：可接受。** 这是轻量幂等提示，不需要把 duplicate target 升格为全局校验错误。

## 场景 12：Reference 指向另一个 Reference

A → B 的空壳，B → C 的 home。

**V2 行为**：创建 A 时解析到 C，并直接写 A → C。运行时模型只承诺一跳。

**评价：顺畅。** 这避免循环、链式断裂和层层路径解释。无需建设一般图解析器。

## 场景 13：Source target alias 被重命名

**行为**：ref 断开，显式 relink。不能在原 alias 下静默指向另一个 Source 身份。

**评价：可接受。** Source alias rename 本来就是低频身份操作。为了自动跟踪 rename 引入 global ID/registry 不划算。

**原则**：已经用于 Analysis/Adoption 的 ref 不应原地改指向另一个 Source；新身份使用新 local alias。证据记录依靠 observation fingerprint 防止历史语义漂移。

## 场景 14：只克隆了 consumer Git 仓库到另一台机器

`source.ref.yaml` 的本地路径不存在。

**评价：警惕，且是 V2 明确的 local-first 边界。**

当前真实使用是 Windows 单机、目录浅而集中，因此先优化本机关系。团队或可携带交付需要：

- 同时复制 provider workspace；或
- 在交付前把需要的 Source materialize/freeze；或
- 在新机器上重新 link。

第一版不增加 machine profile、环境变量映射或远程 locator。若多机协作成为主场景，再单独设计 portable binding。

## 场景 15：整个项目父目录一起搬动或打包

```text
C:\Programs\suite\research
C:\Programs\suite\product-a
```

若 ref 保存相对路径，整个 `suite` 一起移动后仍有效。

**评价：顺畅。** 这也是优先写相对路径而非绝对路径的主要价值。

## 场景 16：Source 较多的 workspace 也出现实现 Task

**V2 行为**：直接创建 Task。没有 kind 检查，也无需把 workspace 转成 Build。

**评价：顺畅，优于显式 Study 类型。** 现实中的研究常会产生脚本、实验和维护任务，强制禁止只会制造例外。

## 场景 17：Task 较多的 workspace 临时吸纳一个独有 Source

**V2 行为**：直接 `source add`，成为本地 owned Source。若后来其他项目也需要它，该目录自然成为 home，其他项目再 link。

**评价：顺畅。** 不需要先决定它是否应该进入“公共 Study”。Source Home 是自然涌现的，不是预先规划的库。

## 场景 18：同一 workspace 有少量多个 System，各用不同 Source

**V2 行为**：所有 Source aliases 仍在 workspace 层；System 可选地记录自己的 aliases，用于 UI/命令过滤。Task 可按 System 物理分组。

**评价：可接受。** 一个 Assay 仍鼓励少量 System。若几十个 System 导致 source/task union 过大，应拆 workspace，而不是继续增强多租户能力。

## 场景 19：Provider workspace 的 `analyses/` 很多

**V2 行为**：consumer 不自动枚举它们，默认 Source list 只读取 ref 与目标 `source.yaml`；只有显式查看 related analyses 时才扫描。

**评价：顺畅。** 这避免 Source Library 把自己的规模墙传播给每个 consumer。

## 场景 20：Target drive 暂时离线

**行为**：`source list` 可显示 broken/unavailable；Task、System 和本地 Analysis 仍可操作。只有需要该 Source 内容的命令失败。

**评价：顺畅。** 逐 Source 关系比 Build→Study 整体连接更具局部故障性。

## 汇总：真正的别扭点

### 可以接受的别扭

1. Source Home 移动后需要手动 relink；
2. 不同 branch 需要不同 owned Source；
3. Analysis 是否通用仍需人判断；
4. consumer 单独跨机器复制时 ref 会断；
5. shared checkout 的 dirty 状态对所有 consumer 可见。

这些都是 live local relationship 的自然代价。为消除它们加入 registry、overlay、branch override 或自动搬运，代价会更高。

### 第一版必须处理清楚的点

1. 写穿透必须显示真实 home；
2. unlink 绝不能删除 target；
3. evidence 必须 pin observation/fingerprint；
4. ref 创建时压平链；
5. broken ref 只能局部影响；
6. Source brief/已有分析必须有可发现入口。

### 应触发回炉的失败信号

- 大多数项目都需要同一 Source 的不同 checkout 状态；
- Source homes 经常移动，relink 成为日常操作；
- 多机协作而非本机工作成为主要场景；
- brief 和相关 Analysis 已可见，用户仍大量重复研究；
- 共享 checkout 的项目特定修改成为常态；
- 用户普遍无法判断 Analysis 应留在当前 workspace 还是 home。

在这些信号出现前，V2 是当前最小、最可逆、与实际目录习惯最匹配的方案。
