# Assay V2 修订记：mutation 权威、分层证据与 clone registry

> 状态：已采纳的 V2 修订（2026-08-27 斟酌轮）。本文修订 [`source-reference-v2.zh-CN.md`](source-reference-v2.zh-CN.md) 的 §6.4，并正式移除 2026-08-18 设计简报中的 C5 原则；其余 V2 语义不变。

## 1. 原则替换：移除"只有不可变的东西才可安全共享"

旧原则（简报 C5）把两种不同的"不可变"捆绑在一起：

- **记录不可变**：observation 账本追加式、决策记录不改写历史。**保留。** 这是实验记录本纪律，成本趋近于零，没人反对"别涂改自己的笔记"。
- **内容不可变**：dirty checkout 拒绝 sync、frozen 永不更新、每次观测强制指纹。**移除默认地位**，降级为第 2 层证据的可选工具。这是把记录本纪律错误地施加到了标本身上。

替代原则：

> **共享安全来自单一 mutation 权威，不来自不可变性。**
> 一个可变实体只有一个 home；写操作穿透到 home、使用 home 的锁。证据需要多稳固，由证据自己决定 pin 到哪一层；工具不预收最高档的税。

理由：单机证据工作台中 dirty checkout 是常态——理解上游最快的方式就是改两行跑跑看。对 git-backed Source，"当时长什么样"由 git 免费记录（commit hash 可寻址、字节在 history 中可恢复）；内容层加锁与强制指纹只产生仪式税，并训练 AI 助手反复索要 sha256、把文件当违禁品看守。

## 2. 证据强度分层

pin 的深度与决策重量成比例，不一刀切：

| 层 | 记什么 | 适用 | 成本 |
| --- | --- | --- | --- |
| 0 | alias + 日期 | 随手浏览、看一眼就否的 analysis | 零 |
| 1 | 身份 pin：git commit + origin；非 git 目录懒算一次 tree hash | adopt / reject 等要留 rationale 的决策 | git 来源零成本 |
| 2 | 字节 capture（frozen snapshot） | 非 git 来源、上游可能消失、存档需求 | 显式 opt-in |

CLI 默认第 0 层；`analysis close --exit adopt|reject` 时建议（不强制）第 1 层；第 2 层永远显式发起。

## 3. 行为修订清单

1. `source sync` 遇到未记录改动：从拒绝改为记一条 `observed with local modifications` 的 advisory 并继续。仍然值得拦的只有会丢字节的操作（switch 丢弃未提交修改），而那由 git 自身防护承担。
2. observation fingerprint 从必填改为按层懒算；git Source 用 commit hash 代替 sha256-tree 重复建设。
3. frozen 的"永不 sync/switch"松绑为：允许显式 re-capture，追加一条新 observation，不要求新 lineage 仪式。
4. V2 §6.4"证据必须 pin observation/fingerprint"改读为**按层 pin**：第 0 层证据可以什么都不 pin。

## 4. 全局 clone registry（可重建缓存）

简报 C2 否决的是全局**权威**，并明确"可删除、可重建的缓存可接受"。实体位置仍按 V2：home 在各 workspace 中，注册表只当索引。

形状：

- 位置 `~/.assay/clone-registry.json`；条目 = 归一化 origin URI、home workspace 路径、alias、last seen 时间。
- **写**：`source add` / `source link` / `source sync` 时 best-effort 顺手更新；写失败绝不阻塞命令。
- **读**（全部是提示，不是决定）：
  1. **clone 时去重**（杀手级用途）：`source add` 一个已有 home 的 URI 时提示"research#qiskit 已是它的 home，要 link 吗？"——重复研究从重复 clone 那一刻开始，这里拦住比事后任何机制都便宜；
  2. **link 免路径**：`assay source link <alias>` 不写目标 workspace 路径时从注册表列候选；
  3. **断链重绑建议**：broken ref 报错时附上注册表中更新的位置，吃掉 V2 场景 4"手动 relink"这个已接受的别扭点的大半。
- **信任模型**：每次读都现场核实目标存在且 alias 匹配，核实失败即丢弃该条目；删除整个文件只损失便利，不损失任何事实。它因此永远升不成权威。
- 第一版只登记 home，不登记 consumer 的 ref 空壳。若误删 home 成为高频事故，把 refs 也登记即可免费得到 V2 场景 5 推迟的 `source dependents`；等失败信号，不提前建。

## 5. 语气改写清单

体裁决定 AI 行为；审计腔训练出合规官行为。以下位置从"记录所有能记录的"改写为"记录这个决策需要的"：

- assay-builder SKILL.md 的 positive rules（如 "A living Source MUST keep provenance and observation metadata"）与 final response checklist 中的指纹项；
- V2 §6.4（见第 3 节第 4 条）；简报 C5 行（本文档已正式移除）；
- **CLI 输出文案**：sync / observation 相关的警告与错误文本与文档同等重要——它们直接进入模型上下文，是"AI 一直求 sha256"行为的直接训练源。

## 6. 明确不做

- registry 不升权威、不自动 rebind：只给建议，采纳仍是显式动作；
- 不引入 per-consumer branch override（维持 V2 §5.3）；
- 不删除 observation 账本的追加式语义（记录不可变保留）。
