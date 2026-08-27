# Assay V2：同形工作区 + Source Reference

## 结论

V2 应当采用：

> **所有 Assay 工作区保持同一形状；Study / Build 只是一种使用倾向；跨工作区复用通过 `sources/` 下的引用空壳逐 Source 完成。**

这比显式 Study / Build 工作区类型更合理，因为它把真正需要共享的对象——Source——建模为关系，而不把整个工作区变成需要路由、挂载和迁移的复合系统。

```text
Assay workspace A                    Assay workspace B
（Source 较多，可俗称 Study）         （Task 较多，可俗称 Build）

sources/qiskit/                      sources/qiskit/
├── source.yaml       <------------ └── source.ref.yaml
├── checkout/
├── observations/
├── materials/
└── brief.md
```

B 仍然是完整、普通的 Assay 工作区。它自己的 Task、System、Analysis、Knowledge、Spec、Roadmap 和 Adoption 全部留在 B；只有 `qiskit` 的 Source 实体解析到 A。

## 1. 不再存在工作区类型

### 1.1 同一形状

所有工作区继续使用当前统一布局与 manifest。V2 不新增：

- `kind: study`；
- `kind: build`；
- `.assay/workspace.json` 中的角色；
- Build → Study 的唯一连接；
- 按命令类别进行的跨根路由；
- 从 combined 工作区到两种类型的强制迁移。

“Study”与“Build”只用于人类描述：

- Source、通用分析较多的工作区，可称为 source-centric 或 Study-like；
- Task、System、Adoption 较多的工作区，可称为 project-centric 或 Build-like；
- 一个工作区可以同时承担两种用途，也可以随时间改变，不需要 convert。

### 1.2 Assay 的聚合不是第三种对象

当前工作区加上它所引用的 Source homes，就是实际使用视图：

```text
current workspace
  + locally owned sources
  + referenced source homes
  = current Assay view
```

不保存 `composition.yaml`，不产生第三个 root，也不建立“当前激活的组合”。用户始终站在一个普通工作区中工作。

## 2. Source Entry 的两种物理形态

### 2.1 Owned Source / Source Home

现有完整 Source 目录不变：

```text
sources/<alias>/
├── source.yaml
├── checkout/
├── materials/
├── observations/
├── manifests/
├── captures/
├── README.md
└── brief.md            # 可选、用户维护
```

包含 `source.yaml` 的目录是该 Source 的 home，也是唯一权威位置。

### 2.2 Reference Shell

引用方使用同样的 alias 目录，但只放一个极薄的文件：

```text
sources/<local-alias>/
└── source.ref.yaml
```

建议格式：

```yaml
schema: assay.source-reference/v1
workspace: ../../shared-research
source: qiskit
```

语义：

- `workspace` 指向另一个 Assay workspace root；相对路径以当前 consumer workspace root 为基准；CLI 创建时优先写相对路径，也允许绝对路径；
- `source` 是目标 workspace 中的 Source alias；
- 本地 alias 由当前空壳目录名决定，可与目标 alias 不同；
- 文件不复制目标 URI、fingerprint、branch 或 observation，避免形成第二权威；
- reference shell 不允许同时包含本地 checkout、observations 或 materials。

例如：

```text
product-a/sources/quantum-sdk/source.ref.yaml
```

```yaml
schema: assay.source-reference/v1
workspace: ../../research/quantum
source: qiskit
```

本地名称是 `quantum-sdk`，目标名称是 `qiskit`。

## 3. 为什么引用“workspace + source alias”，而不是直接引用目录

目标写成工作区路径与 Source alias，优于直接写 `../../x/sources/qiskit`：

1. 目标工作区可以是 standalone 或 overlay，Source 实际路径由它自己的 manifest 解析；
2. 引用表达的是“另一个 Assay 中的 Source”，而不是任意文件夹；
3. 工作区内部布局以后变化时，consumer 不必跟着改硬编码路径；
4. 相对路径仍能在整个父目录一起搬动时保持有效。

V2 不增加全局 Source ID。目标 alias 被重命名或 workspace 单独移动时，reference 会断开，用户显式重新 link；这是比全局 registry、自动搜索和路径修复更便宜的失败模式。

## 4. 引用解析规则

### 4.1 一次解析到 Source Home

`source link` 创建引用时：

1. 定位目标 workspace；
2. 解析目标 Source alias；
3. 若目标本身也是 reference，则继续解析到最终 owned Source；
4. 写入最终 home 的 workspace 与 alias。

运行时不保留 reference chain。这样不会形成 A → B → C 的链式脆弱性，也不需要一般图、循环检测或级联迁移语义。

手工写出的 ref-to-ref 可以在第一次 `source link`/`relink` 时被规范化；核心模型只承诺一跳到 home。

### 4.2 局部失败

- `source list` 对断开的引用显示 `broken` 与原始目标；
- 对该 alias 的 Source 命令失败；
- 当前工作区的 Task、System、Analysis 等其他命令继续工作；
- `assay check` 可把它报告为结构错误，但不自动扫描邻居、不猜测新位置、不修复文件。

这符合“关系可以断，但断法应简单、可见、可重绑”的取舍。

## 5. 命令语义

建议的最小命令面：

```bash
# 在当前 workspace 中创建一个 reference shell
assay source link <target-workspace> <target-source> [--alias <local-alias>]

# 查看本地 alias 的真实 home
assay source home <local-alias>

# 删除本地空壳，不触碰目标 Source
assay source unlink <local-alias>
```

不再需要：

```text
assay study init
assay build init
assay compose
assay split（按类型拆分）
```

普通 Source 命令先解析 alias：

- owned source：在当前 workspace 执行；
- referenced source：在目标 Source Home 执行。

### 5.1 读操作

`list/show/log/diff/status` 可以透明读取目标。输出必须显示：

```text
qiskit  ref -> ../../shared-research#qiskit
```

不能把引用伪装成本地 owned source，否则用户无法判断路径移动和共享更新的影响。

### 5.2 写操作

V2 推荐 **显式写穿透**，而不是默认只读：

- `source sync`、`source switch`、创建 observation 等 Source-native 操作作用于 Source Home；
- 命令开始与结果中明确打印真实 home；
- 使用目标 workspace 的现有 mutation coordination / lock；
- 不弹二次确认，不增加权限系统；显式执行的 Source 命令本身就是意图。

原因是：只读 consumer 会迫使用户为了普通 sync 频繁切目录，削弱“聚合使用”的价值。Reference 的直观模型应接近 Source 级 alias，而不是不可操作的目录书签。

唯一必须特殊处理的是删除：

- 在 reference alias 上执行 remove/unlink，只删除本地 shell；
- 删除 owned Source 只能在 home workspace 中完成；
- consumer 命令绝不沿引用删除目标。

### 5.3 不做分支覆盖

Reference 不允许声明自己的 branch、revision、dirty state 或 update policy。若两个项目需要不同分支或不同更新节奏，应创建两个独立 owned Sources，再分别引用。

这不是缺陷，而是保持“一个 checkout 一个状态”的必要约束。把 per-consumer branch override 加进 reference 会立刻把它变成 worktree/mount 系统。

## 6. Analysis、Knowledge、Task 与 Adoption 的归属

### 6.1 永远写在当前工作区

Source Reference 只改变 Source entry 的解析。以下对象永远在当前 workspace 创建和维护：

- Analysis；
- Knowledge；
- Task；
- Project；
- System；
- Spec；
- Roadmap；
- Source Adoption。

因此不再需要“某类命令透明路由到 Study”。用户在哪个 workspace 执行 `analysis create`，Analysis 就写在哪里。

### 6.2 通用分析如何复用

V2 不自动把目标 workspace 的整个 `analyses/` 或 `knowledge/` 挂载进 consumer。自动 overlay 会带来同名冲突、枚举成本、搜索范围和写入归属问题。

Source Home 可增加一个可选、用户维护的 `brief.md`：

```markdown
# Source brief

## What it is
## Entrypoints
## Stable findings
## Relevant analyses
## Open questions
## Based on observation
```

它与 Source 一起被所有 reference 看到，用于减少模型重复建立基础认知。更长的通用 Analysis 仍放在 Source Home 所在 workspace 的 `analyses/` 中，并从 `brief.md` 链接。

显式 `source show` 可以展示 home workspace 与相关 Analysis 路径，但不把它们伪装成本地文件。

### 6.3 项目相关判断留在 consumer

以下内容不应写回 Source Home：

- Source 对当前产品的价值判断；
- 对当前 System 的适配设计；
- Adoption rationale；
- 项目约束下的 reject/accept；
- 实施 Task 与验证记录。

Source Home 记录可复用事实；consumer 记录目标相关决定。这个边界通过写入位置与文档习惯表达，不通过工作区类型强制。

### 6.4 证据必须 pin，而不是只记 alias

Reference 是 live relationship，目标会继续 sync。Analysis 与 Adoption 不能只记录本地 alias；生成记录时应至少固化：

- 目标 observation ID；
- observation fingerprint；
- Source URI 或 lineage identity；
- 当时解析到的 home alias。

本地 alias 只是导航名。可复现性由 observation/fingerprint 提供，而不是通过把整个 reference 固定到某次版本。

V2 不在 `source.ref.yaml` 中增加 `pin`；版本固定属于证据记录，而不是 Source 挂载关系。

## 7. System 与 Task 的轻量组织

原始问题还包括多个 System 使用不同 Sources、Task 平铺。V2 与以下轻量改进兼容，但不把它们与 Source Reference 强绑定为一次大 cutover：

### 7.1 System 可选 Source 列表

System registry 可选地记录本地 aliases：

```yaml
sources:
  - qiskit
  - benchmark-suite
```

列表只用于默认过滤、上下文建议和 UI 分组；Source 可以是 owned 或 ref，同一 alias 可被多个 System 使用。它不是权限边界。

### 7.2 Task 可选物理作用域

```text
tasks/
├── project/
└── systems/<system-id>/
```

Task 目录小，允许移动；Task ID 不变。这个改进可以独立实施和迁移，不应成为 Source Reference 上线的前置条件。

## 8. 拆分现有 Assay 的方式

V2 不把旧工作区 convert 成 Study。建议过程是：

1. 原工作区保持原样，原有大型 Sources 全部留在原地；
2. 创建另一个普通 Assay workspace；
3. 按需要移动 Project、Task、System、Spec、Roadmap、Adoption 等小目录；
4. 在新 workspace 中，为实际使用的 Sources 创建 reference shells；
5. Analysis / Knowledge 按“通用认知还是项目判断”选择性保留或移动，不做自动分类。

拆分是普通文件组织动作，不改变两个 workspace 的类型，也不要求完成后永久保持“一个只 Study、一个只 Build”。

## 9. 与 Study / Build Split V1 的比较

| 维度 | 显式 Study / Build | V2 同形 + Source ref |
| --- | --- | --- |
| 工作区 schema | 两种 kind | 一种 |
| 组合单位 | 整个 Study | 单个 Source |
| 一个项目使用多个来源工作区 | 需要多 Study overlay | 天然支持 |
| 命令写入 | 按对象跨根路由 | 除 Source 外始终当前根 |
| 工作区用途变化 | 可能需转换 | 无操作 |
| Source 子集 | 整个 Study 可见 | consumer 只链接需要的 Source |
| 大文件移动 | 不移动 | 不移动 |
| 路径断开 | Build→Study 整体失效 | 仅相应 Source 失效 |
| Analysis/Knowledge 共享 | 整体路由，边界较硬 | brief + 显式导航，边界较软 |
| 认知负担 | Study、Build、Assay 三层 | workspace、owned/ref 两层 |

V2 的主要代价是：它不再替用户强制决定 Analysis/Knowledge 应放哪里。但这类判断本来就依赖内容，强制类型只能把模糊性转移到迁移和路由规则中，并不能消除。

## 10. 明确不做

V2 第一版不应加入：

- workspace kind；
- compose object；
- active workspace set；
- 全局 Source registry；
- 自动邻居扫描或自动重绑；
- reference 的 branch/revision override；
- ref-to-ref runtime chain；
- analyses/knowledge 自动 overlay；
- 反向 dependents 索引；
- Source Store、Capsule、CAS、GC；
- 为团队多机路径映射设计 profile；
- 删除 home 前扫描所有 consumer 的保护关卡。

这些能力的共同问题是把一个本地路径 alias 扩展成了依赖管理器。当前证据只支持 Source 级复用，不支持建设完整包管理系统。

## 11. 可行性

实现可行性高，并且明显低于 Study / Build 路由方案：

1. 当前 Source 操作已经集中经过 alias → Source entry 的解析函数；可把 entry 扩展为 owned/ref union；
2. ref 先解析目标 workspace manifest，再调用既有 Source 逻辑；
3. 写操作把 mutation root 改为 home workspace；
4. consumer 的 Analysis/Adoption 只需接收解析后的 observation 信息；
5. `sources/` 是用户拥有区域，新增 `source.ref.yaml` 不要求改变整个 workspace layout 或引入新 workspace envelope；
6. 旧 Source 与旧 workspace 完全不迁移，功能是 additive 的。

真正需要测试的是：

- standalone 与 overlay 目标解析；
- Windows 相对路径、盘符与大小写；
- ref alias 与 target alias 不同；
- write-through 使用 home workspace lock；
- source removal 不沿引用删除；
- adoption/analysis 固化 canonical observation；
- broken ref 只局部影响；
- link 创建时消除 ref chain。

## 12. 最终建议

采用 V2，但把第一版压缩为四条核心语义：

1. **工作区不分 Study / Build 类型。**
2. **Source entry 只有 owned 与 ref 两种形态。**
3. **ref 是到唯一 Source Home 的 live alias，Source-native 命令写穿透；删除只删本地 shell。**
4. **其他对象始终属于当前 workspace；可复现性依靠 observation pin。**

`brief.md`、System Source 列表和 Task 物理作用域是有价值的配套，但都不应阻塞 Source Reference 的最小落地。
