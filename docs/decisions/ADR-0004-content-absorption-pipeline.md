# ADR-0004：从「目录生命周期」转向「内容吸纳管线」

- 状态：Proposed
- 日期：2026-06-20
- 关联诊断：见本仓库会话诊断「metasystem-kit 吸纳行为为何退化为冻结 + 自顾自写文档」

## 背景

metasystem-kit 现在是一套**目录与元数据的生命周期管理器**，但用户实际需要的是**内容吸收转化器**。两条独立证据交叉确认了这一错配：

1. **本仓库自身的元工作区** `.metasystem/queue.json` 有 5 条 `capture_reference_analysis` 动作停在 `pending`，从未被消化；而 `.metasystem/health.json` 报 `ok: true`、`stale_captures: []`。系统冻结了外部参考、写好事件账本，然后停手——并把这种状态判定为「健康」。
2. **Huawei3 handoff**：AI 把官方比赛材料丢进 `references/frozen/.../official-materials` 和 `systems/.../docs`，自顾自填文档；用户反复纠偏（E4/E9/E10），handoff 的 Inference 直接写明「Some MetaSystem framework behavior required manual project-specific correction」。

行为模式一致：AI 把「吸纳」理解成「归档 + 写文档」，而不是「读入内容 → 提炼 → 转化成本地能力」。

## 根因（三层联合失效）

### 思想层：回路是「目录转移图」而非「内容推进图」

`references → analyses → systems → iterations → knowledge` 在 README、SKILL、`rootReadme`、`architectureDoc`、`artifactModelDoc` 里重复 6 次。但 `artifactModelDoc` 的 Exit 列全部是「下一步往哪走」，没有一列规定「这一步必须产出什么内容才算完成」。`addReference` 只 cp + 写事件，`analysis new` 只落空壳模板——从框架视角看冻结这一步已合法收口。

更致命是身份假设错配：回路假设「主体是我们的框架、外部是被学习对象」。但 Huawei3 里整个项目就是为比赛存在的，官方材料是项目本体而非外部参考。框架只有 *learning mode* 一种身份假设，没有 *absorption mode*。

### CLI 层：命令只动容器，从不动内容

- `addReference`：cp 源目录 → `references/frozen/YYYYMM/<name>` → 写事件。不读源内容、不生成索引、不打开 analysis。
- `analysis new`：写全是空标题的模板。不接收被分析引用路径，不预填任何东西。
- `adopt`：把根目录全部扔进 `.old/<时间戳>/`，再 init 空壳。adoption-workflow 的「写 adoption analysis」「move old artifacts」全是散文指令，CLI 无任何命令支撑，没有「adopt 完成」校验门。
- `check`：只校验目录存在 + manifest hash + 系统 registry + 开放 iteration。完全不校验「冻结引用无 analysis」「analysis 草稿停滞」「`.old/` 未清空」。于是 5 条 pending queue 能让 health 报 ok。

每个命令都是闭合原子操作，做完即视为完成；跨命令的「未完成工作」不可见、不可驱动、不可校验。`queue.json` 是孤岛——没有命令消费它，`health.json` 也不读它。

### Skill 层：指令把 AI 推向「安全地不动内容」

Anti-rules 大量是防御性的（别把外部源放 systems/、别复制 AGPL、别在方向明确前移动 `.old/`），全是单向「别乱动外部/用户内容」，没有正向规定「analysis 必须含对冻结引用的具体提炼」「iteration 必须把 pattern 写进 systems/」。AI 学到「冻结=完成、写壳子=完成、不碰内容=合规」。

### 系统性：元数据 vs 内容被混为一谈

`trellis-inspired-design-notes.md` 的「framework templates can be updated; user knowledge must be protected」边界保护是对的，但落地时框架把「内容填充」整体划给了「user 领域、不归我管」。`system register` 只管 `system.yaml` 契约，明说 system source 属于系统本身；analysis/iteration/knowledge 模板都是空壳。制造了真空：没有任何子系统负责「把冻结外部内容机器可读地推进成 analysis/system 内容」。

## 决策

总原则：**把「内容推进」从隐式人工动作，变成显式、CLI 驱动、可校验的状态机。「吸纳」应当是一条命令管线，不是一个目录。**

三层联合改动，缺一不可。

### D1 思想层：引入 absorption mode 与「内容出口」

1. **区分两种项目模式**，写进 `framework-structure.md` 与 `rootReadme`：
   - *learning mode*（现有）：外部是被学习对象，`references/` 是只读证据。回路 `references→analyses→systems→iterations→knowledge` 成立。
   - *absorption mode*（新增）：外部是项目本体来源，官方材料进项目级 `problem/`（或 `sources/`），不走 `references/frozen/`。回路改为 `sources → analyses → systems`，`references/frozen/` 只用于真正的第三方旁证。
   - 用 `metasystem init --mode absorption` 或 `.framework/config.yaml` 的 `mode: absorption` 显式声明；`check` 据此放宽/收紧规则。直接消解 Huawei3 E4 纠偏。

2. **给回路每一步定义「内容出口（content gate）」**，artifact 不再「文件存在即完成」，而是「满足内容谓词才算 open→closed」：
   - frozen reference：必须附 `reference.yaml`（源、版本、冻结原因、待分析点清单），且至少一条 analysis 引用它，否则 `check` 报 `unanalyzed reference`。
   - analysis：`## Key observations` 非空 + `## Adopt`/`## Reject` 至少一处有内容，`analysis close` 才允许；否则 `check` 报 `empty analysis`。
   - iteration：`## Result` 必须引用 `systems/` 下被改动的具体路径，否则 `close --result applied` 拒绝。

### D2 CLI 层：命令带内容、带绑定、带未完成工作可见性

3. **`reference add` 改为「冻结即立案」**：cp 后自动生成 `references/frozen/YYYYMM/<name>/reference.yaml`（源、commit、冻结时间、`analyzed: false`、待分析点清单），事件含 `analysis_required: true`。

4. **新增 `metasystem absorb <source> [--as problem|reference|system]`**（缺失的核心命令）：
   - 探测源类型（目录/仓库/PDF/ZIP）；
   - 按项目 mode 落到 `problem/`（absorption）或 `references/frozen/`（learning）；
   - 自动建一个**预填内容**的 analysis（非空壳）：填好 Reference/Source/Freeze path，把源里可结构化部分（README、目录树、关键文件清单）抽取进 `## Architecture / structure`；
   - 事件账本写 `reference.absorbed`，自动起一个 `Status: open` 的 analysis，使未完成工作立刻可见。
   - 把「冻结 + 自顾自写文档」替换成「冻结 + 立案 + 预填 + 挂开放工作」。

5. **`adopt` 增加 `--analyze` 子流程**：apply 后对 `.old/<stamp>/` 自动生成 adoption inventory（每个顶层条目一行：是什么、建议落到新结构哪），写入 `Status: open` 的 adoption analysis。`check` 把「`.old/` 存在且对应 analysis 仍 open」列为 `warning`。

6. **`analysis new --for-reference <path>`**：空壳模板改为「绑定引用」——自动填 Reference/Source/Freeze path，`Decision exit` 与该引用 `analyzed` 状态联动；`analysis close` 时把 `reference.yaml.analyzed` 置 true。

7. **`check` 升级为内容健康检查**（非仅结构），新增四类信号：
   - `unanalyzed reference`（冻结 N 天无 analysis）
   - `empty analysis`（`Status: draft` 且正文为空超 N 天）
   - `stale .old/`（adoption 后 `.old/` 仍在但 analysis 已 closed）
   - `dangling queue`（`queue.json` pending 项）——并让 `health.json` 真正读 queue。

### D3 Skill 层：把主动转化写成强制步骤

8. **改写 SKILL.md 工作流，把「吸纳」固化为强制管线**：
   ```
   absorb <source>  →  analysis new --for-reference  →  填 Key observations/Adopt/Reject
                   →  analysis close --exit  →  (adr|knowledge|system change)
   ```
   每步用 CLI 命令表达；新增正向规则：「A frozen reference MUST be followed by an analysis with non-empty observations within the same session; freezing without analyzing is incomplete work.」

9. **新增「先做有方向搬运，再请确认」原则**，取代被泛化的「凡动内容先问」。对 absorption-mode 项目，AI 应**主动**把源内容按 inventory 落到 `problem/`/`systems/`，给出 diff，然后请确认——而非停手只写文档。`adoption-workflow.md` 第 4 步从「Move after direction is clear」改为「Propose a concrete move plan as a diff/preview, then apply on confirmation」。

10. **加「内容完成度」最终检查清单**到 SKILL 的 `Final response checklist`：除现有「Created/updated files」「Registered systems」，必须报告「冻结引用 analyzed/unanalyzed 计数」「open analysis 非空率」「`.old/` 是否清空」。让 AI 无法用「文件建好了」冒充「内容吸收了」。

### D4 一致性修补（顺带但重要）

11. **`knowledge/troubleshooting` 目录名统一**：`templates.ts` 模板用 `troubleshooting/`，但 `addKnowledge` 用 `knowledge/${type}s` 即 `troubleshootings/`（复数）——**代码 bug**，导致两类目录并存（本仓库与 Huawei3 都出现过）。统一为 `troubleshooting`，`check` 禁止复数形式。

12. **清理孤儿 `queue.json` / `health.json` / 旧 `bootstrap_framework` 系统**：v2 残留，与新 `metasystem-kit` 并行，造成两套吸纳语义。要么新 CLI 接管 queue（消费 pending 项），要么迁移后删除。

## 执行分阶段（风险从低到高）

### 阶段 0 — 一致性修补（低风险，先试水）
- E0.1 修 `addKnowledge` 的 `troubleshootings` → `troubleshooting` bug（D4-11）。
- E0.2 加 `check` 规则禁止 `knowledge/troubleshootings/` 复数目录。
- E0.3 补测试覆盖 troubleshooting 目录名。
**验收**：`pnpm test` 通过；现有 troubleshooting 条目仍可被 `status` 计数。

### 阶段 1 — check 升级为内容健康检查（中风险，纯增量）
- E1.1 `check` 新增 `unanalyzed reference` 检测：扫描 `references/frozen/**/reference.yaml`（或无 yaml 的裸冻结目录）是否被任何 analysis 引用。
- E1.2 `check` 新增 `empty analysis` 检测：`analyses/**` 中 `Status: draft` 且 `## Key observations` 段为空的文件报 warning。
- E1.3 `check` 新增 `stale .old/` 检测。
- E1.4 让 `health.json`（如工作区存在）真正读 `queue.json` pending 项并计入 `stale_captures`。
**验收**：在本仓库元工作区跑 `check` 能报出那 5 条未消化引用（不再是 ok:true 假象）。

### 阶段 2 — reference 立案 + analysis 绑定（中风险，改现有命令语义）
- E2.1 `addReference` 生成 `reference.yaml`（含 `analyzed: false`）。
- E2.2 `analysis new --for-reference <path>` 预填模板并联动 `reference.yaml`。
- E2.3 `analysis close` 置 `reference.yaml.analyzed = true`。
- E2.4 兼容已有无 yaml 的冻结目录（降级为「未立案冻结」，check 报 warning 而非 error）。
**验收**：冻结一个测试目录后，`check` 立即报 unanalyzed；`analysis close` 后 warning 消失。

### 阶段 3 — absorb 命令（中高风险，新核心命令）
- E3.1 `metasystem absorb <source> [--as problem|reference|system] [--mode auto]`：探测、落地、预填 analysis、写 `reference.absorbed` 事件、挂 `Status: open` analysis。
- E3.2 支持 absorption mode 路由到 `problem/`。
- E3.3 预填逻辑：README/目录树/关键文件清单抽取进 `## Architecture / structure`。
**验收**：对一个真实目录跑 `absorb`，产出非空 analysis 且 `check` 显示一条 open 工作；不再出现「只冻结不分析」。

### 阶段 4 — adoption inventory + mode 体系（较高风险，改 init/adopt 语义）
- E4.1 `init --mode absorption|learning`，写入 `config.yaml`。
- E4.2 `adopt --analyze`：apply 后生成 adoption inventory + open adoption analysis。
- E4.3 `check` 按 mode 放宽/收紧规则。
**验收**：absorption mode 项目官方材料进 `problem/` 不再被误判为 reference。

### 阶段 5 — Skill 重写 + 旧系统清理
- E5.1 SKILL.md 工作流改管线版（D3-8），加正向规则与最终检查清单（D3-10）。
- E5.2 `adoption-workflow.md` 第 4 步改为「先提 diff 再确认」（D3-9）。
- E5.3 决策本仓库 `queue.json`/`health.json`/旧 `bootstrap_framework` 的去留：迁移或删除（D4-12）。
**验收**：新 AI 会话按 SKILL 执行时，冻结后必然在同会话产出非空 analysis，不再出现冻结即停手。

## 后果

正面：
- 「吸纳」从口号变成可执行管线，AI 无法用「文件建好了」冒充「内容吸收了」。
- 未完成工作（未分析引用、空 analysis、遗留 `.old/`）在 `check`/`status` 中可见可驱动。
- absorption mode 消解「整个项目就是比赛」这类项目与框架 learning 假设的语义冲突。
- 本仓库元工作区的 5 条 pending queue 从「假装 ok」变成「被点名」。

代价：
- `reference add`/`analysis new`/`adopt` 语义变化，已有工作区首次 `check` 可能冒出新的 warning（需迁移说明）。
- `absorb` 是新命令，需要探测逻辑与预填启发式，首版预填质量依赖源类型覆盖。
- mode 体系增加 `init`/`config` 复杂度，需在 SKILL 与文档讲清何时用哪种。
- 阶段 2 的 `reference.yaml` 对历史无 yaml 冻结目录需降级兼容，不能一刀切报 error。

## 翻转条件

- 若实际项目里 absorption mode 与 learning mode 边界仍频繁被用户纠偏，则需引入更细的 source-type 分类而非二分 mode。
- 若 `absorb` 预填启发式在多类源上误填率过高，则回退为「只立案不预填」，把预填交给 Skill 指令而非 CLI。

## 实施状态（2026-06-20）

- 阶段 0–4 已完成并通过 lint + 148 测试（core 105 + cli 43）。
- 阶段 5 Skill/文档重写已完成：SKILL.md 加 absorb 管线与正向规则、内容完成度清单；adoption-workflow.md 改为「先提 diff 再确认」；framework-structure.md 加 mode 与 content gate 说明。
- 阶段 5b（本仓库 v2 元工作区清理）**未执行，待用户决策**：调查发现 `.metasystem/queue.json`、`.metasystem/health.json`、`systems/bootstrap_framework/` 被本仓库 v2 元工作区、`.metasystem/config.yaml`、多个 knowledge 文档、以及新 kit 的 dangling-queue 检测（读 `.metasystem/queue.json`）引用。这些不是纯孤儿——它们是 v2 元工作区的运行时状态与旧实现。删除/迁移属独立决策，需用户确认是否要把本仓库元工作区从 v2 迁到 v3。新 kit 的 `check` 已能在 v3 工作区检测 dangling queue；待本仓库迁移后，那 5 条 pending 自然进入清理流程。
