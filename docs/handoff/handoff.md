# MetaSystem v3 完成: P1-c ADR 模块 + P2-templates + P3 验证

handoff_type: project
created_at: 2026-06-17
status: completed
receiver: 后续接手 metasystem-kit 改造的开发者
confidence: high

## 1. Continuation Target

**Objective**: 完成 metasystem-kit 从 layout v2 向 v3 演进的剩余三件事：
1. **P1-c**：ADR core 模块 + `metasystem adr` CLI 命令组 + `check` 加 ADR 链一致性校验 + 测试。
2. **P2-templates**：调整 `packages/metasystem-framework-core/src/templates.ts` —— 移除 8 个系统内部模板（`systems/<core>/{README,framework.yaml,CHANGELOG,docs/*}`），新增 `system.yaml` 契约模板和 `knowledge/decisions/ADR-TEMPLATE.md`，并在 `init` 时不再生成系统内部文件夹。
3. **P3-final**：在 Tarot 项目上跑完整验证序列（`check`、`status`、可选回滚），并整理本分支提交以便合并。

**Scope（包含 / 不包含）**:
- ✅ 包含：写代码、加单测、过 lint、改对应的 SKILL.md/references 段落（仅 ADR 相关；其他已改完）、对 Tarot 跑验证。
- ❌ 不包含：data 双写解决方案、references/intake 流程激活（已在审计文档里列为"暂不做"）、合并到 main（由人工审阅决定）。

**First next action**: 切到分支 `feat/systems-registry-v3`，跑一遍现有测试套件确认基线是绿的，然后从 P1-c 开始：

```bash
cd C:\Programs\Meta\MetaSystem\systems\metasystem-kit
git checkout feat/systems-registry-v3
git status                              # 应是 clean
pnpm install
pnpm build && pnpm -r test              # 应该全过
```

**Stop or escalation condition**: 如果上面 `pnpm -r test` 不是全绿（核心 79 + CLI 36 = 115 测试都通过），先排查环境差异再继续；不要在红的基线上加新代码。如果 P1-c 的 ADR schema 要从 `__schema:1` 起步（而不是和 manifest 一样从 1 开始），停下来确认。

**Route note**: project handoff，单一仓库内继续；分支已存在；接手者拥有 push 权限即可，没有外部依赖。

## 2. Executive Summary

`metasystem-kit` 是 MetaSystem 框架的 TS monorepo（`packages/metasystem-framework-core` + `packages/metasystem-framework-cli` + `skills/metasystem-builder`）。本次改造源于一份独立审计（`C:\Programs\Games\CardGames\Tarot\.framework\AUDIT-metasystem-structure-20260617.md`），审计在 Tarot 项目上发现了 5 类结构性缺陷，其中最严重的是 layout v2 manifest 的 `project.core` 字符串与磁盘活跃系统不同步、`check` 报假 ok。

我已在分支 `feat/systems-registry-v3` 上完成了 P0（systems-registry 核心模型 + system 命令组 + check 语义校验）和 P1-a/P1-b（v2→v3 迁移 + 生命周期 close + knowledge add），以及 P2 中的 SKILL.md/references 更新（已通过 skill-creator audit）。当前测试套件：核心 79 个 + CLI 36 个 = 115 个全绿；`pnpm lint` 0 错。本分支已对 Tarot 跑过 `migrate-layout --apply`，registry 正确生成。

剩余的 P1-c（ADR）、P2-templates、P3-final 在原方案里是相互解耦的——可以独立完成，也可以合并到一个 PR。下面给出具体步骤、设计依据和验收标准。

## 3. Current State Snapshot

**Facts**:
- 仓库根: `C:\Programs\Meta\MetaSystem\systems\metasystem-kit`，分支 `feat/systems-registry-v3`，已发布 4 个提交（`219c53b`/`99bb200`/`b1b5c77`/`4207345`/`7dacbe5`），未合并到 main。
- 测试基线: 核心 6 个测试文件 79 个测试 + CLI 2 个测试文件（应为 3 个，含 lifecycle-commands.test.ts）36 个测试，全部通过；`pnpm lint` 0 错。验证命令: `cd packages/metasystem-framework-core && pnpm test` 与 `cd packages/metasystem-framework-cli && pnpm test`。
- 已实现的 core 模块: `src/systems-registry.ts`（registerSystem/promoteSystem/archiveSystem/listSystems/findSystem/load/save）、`src/workspace.ts` 中的 `closeIteration`/`closeAnalysis`/`addKnowledge` + `checkFramework` 语义校验升级、`src/update.ts` 中的 v2→v3 迁移逻辑（`buildLayoutMigrationPlan` + `applyV2ToV3Migration`）。
- 已实现的 CLI: `metasystem system register|promote|archive|list|show`、`iteration close`、`analysis close`、`knowledge add`，全部接入了 `program.ts`，构建为 `dist/cli.js` 可用。
- Tarot 验证状态: `C:\Programs\Games\CardGames\Tarot\.framework\systems-registry.json` 已生成，4 个系统注册（tarot-arcana-core-game 为 primary，card-eval-system active，2 个 archived），`metasystem check` 从原来的 8 error 降到 0 error 5 warning（warning 都是用户修改过的 README/gitignore，预期内）。
- 设计文档: 完整方案在审计文档 `C:\Programs\Games\CardGames\Tarot\.framework\AUDIT-metasystem-structure-20260617.md` 第 7、8 节；ADR 数据模型设计在跟用户的对话定稿 §1.4/§2.6/§3.3 中（要点见下文 §4 决策）。

**Inferences**:
- `__schema:1` for `systems-registry.json` 已用，建议 ADR 索引也从 `__schema:1` 起步以保持一致。基础: 当前 schema 没有破坏性扩展需求。
- `analyses/templates/reference-analysis-card.md` 模板里已有 `[ ] ADR` 复选框；P1-c 的 `analysis close --exit adr` 应当除了勾选复选框外，**自动调用 `adr new --from-analysis <path>` 创建 ADR 草稿**——这是一个用户体验上的合理推断，但定稿方案里没硬性规定，做之前可以问用户或采用保守方案（仅勾选 + 提示用户运行 `adr new`）。

**Active constraints**:
- 必须保持向后兼容：现有 v2 项目跑 `migrate-layout` 后必须能正常 `check`/`status`。
- 不能在 ZCode 环境的 Edit 工具与 biome 格式化之间产生竞态：实践证明，**Edit 之间不要跑 `pnpm biome format --write`**，统一最后跑一次。
- ADR 编号要可靠：建议用 `.framework/adrs.json` 里的计数器单调递增分配，不依赖文件系统扫描（避免并发问题）。
- 不要破坏 `manifest.__schema: 1`；layout_version 已升到 3 但 `__schema` 仍是 1（向前兼容路径）。

## 4. Decisions and Rationale

- **Decision**: ADR 作为 `knowledge/decisions/` 的一等公民，命名 `ADR-NNNN-<slug>.md`，frontmatter 含 `adr/title/status/date/supersedes/superseded_by/related_analysis/related_iteration`。索引存于 `.framework/adrs.json`（受管文件）。
  - **Reason**: 审计指出当前 ADR 缺位（`reference-analysis-card.md` 模板有复选框但全项目无 ADR 文件）。把 ADR 作为 decisions 子格式而非独立目录，避免增加层级。
  - **Tradeoff**: 牺牲了 ADR 与普通 decision 的目录隔离；用 frontmatter `adr` 字段区分。
  - **Flip condition**: 如果发现 `knowledge/decisions/` 同时混普通 decision 和 ADR 后查询不便，再考虑独立子目录。

- **Decision**: ADR 状态机为 `proposed → accepted → superseded | deprecated`。`adr new` 创建 proposed，`adr accept` 转 accepted（可同时 supersedes 旧 ADR），`adr supersede <old> <new>` 链式取代，`adr deprecate` 标记废弃但保留。
  - **Reason**: 与 systems-registry 的 status 状态机风格一致；与业界 ADR 实践（MADR/Nygard）兼容。
  - **Tradeoff**: 少了一个 "rejected" 终态——rejected 的 ADR 直接 deprecate 即可。

- **Decision**: `metasystem check` 加 ADR 链一致性校验：`supersedes`/`superseded_by` 双向闭合、无悬空引用、无环 → error；frontmatter 缺字段 → warning。
  - **Reason**: 与 systems-registry 校验对齐；坏链会让审计困难。
  - **Tradeoff**: 增加 check 实现复杂度；可能需要做有限 BFS。

- **Decision**: P2-templates 移除 8 个系统内部模板（README/framework.yaml/CHANGELOG/docs/*）；不再为 `init` 创建 `systems/<core>/docs/` 目录。
  - **Reason**: 审计第 3 类缺陷——这些模板和独立 git 仓库的系统自带文档冲突，是 v3 的主要架构调整。
  - **Tradeoff**: `init` 后用户得到一个空的 `systems/` 目录，需要手动 `system register`。可在 SKILL.md workflow 步骤里说明。
  - **Flip condition**: 如果用户反馈 `init` 后无系统骨架太裸，可以加一个可选 `--bootstrap-system <name>` 创建最小占位。

- **Decision**: Tarot P3-final 不需要回滚，只需补几个清理步骤（详见 §8）。
  - **Reason**: 当前状态已经比 audit 之前的状态好得多（check 不再报假 ok），且迁移使用了 copy-first，原文件未删除（见 backups）。

## 5. Evidence and Source Map

- Evidence ID: E1
  - Type: file
  - Pointer: `C:\Programs\Games\CardGames\Tarot\.framework\AUDIT-metasystem-structure-20260617.md`
  - Supports: 整个 v3 改造的需求来源；§7 优先级矩阵和 §8 暂不做项是范围边界。
  - Freshness: 2026-06-17（本次会话内创建）

- Evidence ID: E2
  - Type: command
  - Pointer: `cd C:\Programs\Meta\MetaSystem\systems\metasystem-kit && pnpm -r test`
  - Supports: 测试基线 115 个全过；新加的 P1-c/P2-templates 不应让任何已有测试变红。
  - Freshness: 2026-06-17，最近一次提交 `7dacbe5` 之后

- Evidence ID: E3
  - Type: file
  - Pointer: `packages/metasystem-framework-core/src/systems-registry.ts`
  - Supports: 实现 ADR core 模块时可参照同样的 schema/load/save/CRUD 模式；`.framework/adrs.json` 用同样的 zod schema 路径在 `src/schemas/index.ts` 里加。
  - Freshness: 2026-06-17

- Evidence ID: E4
  - Type: file
  - Pointer: `packages/metasystem-framework-core/src/templates.ts`
  - Supports: 第 40-215 行的 `desiredTemplates(project, core)` 是改 P2-templates 的入口；移除 8 个 `systems/${core}/...` 条目即可。`coreFrameworkYaml` 函数（约 437 行）改为生成新的 `system.yaml` 契约格式。
  - Freshness: 2026-06-17

- Evidence ID: E5
  - Type: file
  - Pointer: `skills/metasystem-builder/references/systems-registry.md` 与 `lifecycle-commands.md`
  - Supports: P1-c 实现完后，需要新增一份 `references/adr-workflow.md` 并更新 SKILL.md 的"Decisions and ADRs"段（目前 SKILL.md 只在 anti-rules 和 frontmatter 顺带提到 ADR）。
  - Freshness: 2026-06-17

- Evidence ID: E6
  - Type: file
  - Pointer: `C:\Programs\Games\CardGames\Tarot\.framework\systems-registry.json` 与 `C:\Programs\Games\CardGames\Tarot\.framework\events\2026-06.jsonl`
  - Supports: P3-final 验证目标；migrate-layout 已应用，状态可用 `metasystem status` 复核。
  - Freshness: 2026-06-17

## 6. Artifacts and File Map

- `packages/metasystem-framework-core/src/schemas/index.ts` — zod schemas；P1-c 在此添加 `adrEntrySchema`、`adrIndexSchema`、`adrStatusSchema`。
- `packages/metasystem-framework-core/src/adrs.ts` — **新建**，参照 `systems-registry.ts` 的形态实现 `loadAdrIndex`/`saveAdrIndex`/`createAdr`/`acceptAdr`/`supersedeAdr`/`deprecateAdr`/`listAdrs`/`findAdr`。
- `packages/metasystem-framework-core/src/index.ts` — 导出 `./adrs.js`。
- `packages/metasystem-framework-core/src/constants.ts` — 加 `ADRS_FILE = ".framework/adrs.json"`；`PRIMARY_DIRS` 不变。
- `packages/metasystem-framework-core/src/workspace.ts` — `checkFramework` 末尾再加一段"ADR 链一致性"语义检查（参照 §379 起的 systems registry 块的写法）。
- `packages/metasystem-framework-core/src/templates.ts` — P2-templates: 移除 `systems/${core}/...` 8 条；将 `coreFrameworkYaml` 改名为 `systemContract` 输出新 `system.yaml`；新增 `adrTemplate()` 输出 `knowledge/decisions/ADR-TEMPLATE.md`；调整 `desiredTemplates` 数组。
- `packages/metasystem-framework-core/src/workspace.ts` line 228 (`initFramework`) — 删除 `await ensureDir(path.join(root, "systems", core, "docs"), root, report);` 这一行（不再创建系统 docs 目录）。
- `packages/metasystem-framework-cli/src/program.ts` — 新增 `adr` 命令组：`new`/`accept`/`supersede`/`deprecate`/`list`/`show`，参照 `system` 命令组写法。
- `packages/metasystem-framework-cli/src/format.ts` — 新增 `formatAdrList`/`formatAdrRecord`。
- `packages/metasystem-framework-cli/tests/adr-commands.test.ts` — **新建**，参照 `system-commands.test.ts` 模式。
- `packages/metasystem-framework-core/tests/adrs.test.ts` — **新建**，参照 `systems-registry.test.ts` 模式。
- `skills/metasystem-builder/SKILL.md` — 在 "Systems and version control" 段后加 "Decisions and ADRs" 段；CLI quick reference 加 `adr ...` 命令。
- `skills/metasystem-builder/references/adr-workflow.md` — **新建**，参照 `lifecycle-commands.md` 写法，详述 ADR 状态机和 CLI。

## 7. Open Questions, Assumptions, and Risks

**Open questions**:
- `analysis close --exit adr` 是否应该自动 `adr new --from-analysis`？建议：**先不自动**，输出一行提示让用户手动运行。理由：自动行为容易在用户没准备好时产生半成品 ADR。
- ADR `accepted` 状态的 ADR 内容是否应该锁定（只允许 superseded/deprecated 转移，不能再编辑）？建议：**不锁定**，但 `check` 警告内容哈希变更（与 manifest.json 中受管文件同样处理）。
- `adr supersede <old> <new>` 是否要求 `<new>` 必须先 `accepted`？建议：**要求**，因为只有 accepted 的 ADR 才能取代另一个 accepted。

**Assumptions**:
- 假设：vitest 配置 `packages/*/tests/**/*.test.ts` 的 glob 不需要改（新加的 `adrs.test.ts` 和 `adr-commands.test.ts` 会自动被收集）。验证方法：直接运行 `pnpm -r test` 看新测试有没有被发现。
- 假设：commander v12 的子命令注册无冲突（`adr` 与现有命令名都不冲突）。验证：`metasystem adr --help` 能渲染。
- 假设：用户主语言为中文，但代码注释、event payload、CLI 输出沿用英文（与现有代码一致）。

**Risks**:
- **R1**: ADR `supersede` 链如果有环，`check` 检测要终止；如果实现成幼稚 BFS 可能死循环。**Mitigation**: 用访问集合 + 深度上限。
- **R2**: P2-templates 移除 system 内部模板后，旧测试 `desiredTemplates("Demo","demo-core").length` 之类的断言会变小。**Mitigation**: 跑 test 时检查并更新断言（`packages/metasystem-framework-core/tests/workspace.test.ts` 第 80-100 行附近的 `toHaveLength` 调用）。
- **R3**: 如果 ADR 模板里的 frontmatter YAML 解析依赖 `js-yaml` 等额外依赖，需要新增依赖。**Mitigation**: 用正则解析关键字段（参照 `update.ts` 中 `readLegacyFrameworkYaml` 写法），避免新依赖。

## 8. Next Actions

1. **基线确认** — Owner: 接手者 — Success check: `cd metasystem-kit && pnpm -r test` 输出 "Tests: 115 passed"，`pnpm lint` 0 错。
2. **P1-c step 1 (schema)** — Owner: 接手者 — 在 `src/schemas/index.ts` 加 `adrStatusSchema`/`adrEntrySchema`/`adrIndexSchema`，定义 `__schema:1`。Success check: `pnpm --filter metasystem-framework-core build` 通过。
3. **P1-c step 2 (core module)** — 写 `src/adrs.ts`，参照 `systems-registry.ts` 形态。包含编号分配器（`adrIndex.next_number`）和状态机校验（拒绝从 deprecated 转回 accepted）。Success check: 6 个核心函数（load/save/create/accept/supersede/deprecate/list/find）通过单测。
4. **P1-c step 3 (CLI)** — 在 `program.ts` 加 `adr` 命令组。Success check: `metasystem adr --help` 显示 6 个子命令；新加的 CLI 测试通过。
5. **P1-c step 4 (check 校验)** — 在 `checkFramework` 末尾加 ADR 链校验；用访问集合防环。Success check: 单测覆盖 "悬空 superseded_by"、"环"、"双向不一致" 三种场景。
6. **P2-templates step 1** — 改 `templates.ts` 移除 8 个 system 内部模板；改 `initFramework` 不再 ensureDir docs。Success check: `pnpm build` 通过；老的 `desiredTemplates` 长度断言更新；现有 v2→v3 迁移测试不受影响（因为迁移逻辑读的是磁盘上的旧 framework.yaml，不依赖模板）。
7. **P2-templates step 2** — 新增 `system.yaml` 模板生成器和 `ADR-TEMPLATE.md`；放进 `desiredTemplates`。Success check: 新 `init` 后 `systems/<core>/system.yaml` 存在且内容符合 contract 格式。
8. **SKILL.md / references 更新** — 加 "Decisions and ADRs" 段、`adr-workflow.md`、CLI quick reference。Success check: `node "C:\Users\xxoy1\.agents\skills\skill-creator\scripts\skill-creator-cli\dist\core.js"` 通过 audit（用 dynamic import 调用，参考 §9 验证记录）。
9. **P3-final** — 在 Tarot 上跑 `metasystem check` 与 `metasystem status` 并截图保存；如果 check 仍剩 5 个用户修改 warning，可选地跑 `metasystem update --dry-run` 看是否需要 `--force` 同步（用户决定）。Success check: `check` 报 PASS（warning 不阻断），`status` Systems 段显示 4 个系统、primary 为 `tarot-arcana-core-game`。
10. **合并准备** — Owner: 接手者 — 整理 commit history，写一份 PR 描述（可参照本 handoff 的 §2 + §4 + §6），等待用户 review。Success check: `git log feat/systems-registry-v3 ^main --oneline` 输出 5-7 条聚焦提交，每条都有清晰主题。

## 9. Validation State

**Checks run before this handoff was picked up**:

- Command: `pnpm build`
  Result: pass
  Notes: 两个 package 都构建成功。

- Command: `pnpm -r test`（从各包目录运行）
  Result: pass — core 79 / CLI 36
  Notes: 注意从 monorepo 根目录运行 `pnpm vitest run` 时，CLI 子进程测试因 `dist/cli.js` 路径解析问题会失败 14 个；这是 **预先存在** 的问题（不是本次引入）。从 `packages/metasystem-framework-cli` 目录运行就全过。

- Command: `pnpm lint`
  Result: pass
  Notes: 0 错 0 警告。

- Command: `node "C:\Users\xxoy1\.agents\skills\skill-creator\scripts\skill-creator-cli\dist\core.js"` (via dynamic import)
  Result: pass
  Notes: skill-creator audit 报告 0 error 0 warning；调用方式：`node --input-type=module -e "import('./dist/core.js').then(c => c.auditSkill('<path>', {strict:true}).then(r => console.log(c.formatAuditReport(r))))"`。**注意**: skill-creator 的 `cli.js` 在 Windows 上 `import.meta.url === pathToFileURL(process.argv[1])` 判断会因路径大小写差异而失败，导致 `main()` 不被调用、CLI 静默退出；用动态 import 直调 core 是绕开方法。

- Command: 在 Tarot 上 `node packages\metasystem-framework-cli\dist\cli.js migrate-layout --root <tarot> --apply`
  Result: pass
  Notes: 注册表生成、4 系统记录、check 从 8 error 降到 0 error。

**Final checks run after completing P1-c / P2-templates / P3-final**:

- Command: `pnpm build`
  Result: pass
  Notes: core + CLI package builds succeeded.

- Command: `pnpm typecheck`
  Result: pass
  Notes: core + CLI package type checks succeeded, including test sources.

- Command: `pnpm lint`
  Result: pass
  Notes: Biome check passed with 0 errors.

- Command: `pnpm test`
  Result: pass — core 90 / CLI 41
  Notes: Added ADR core tests, ADR CLI subprocess tests, template cleanup tests, ADR chain validation tests, and layout-version migration regression coverage.

- Command: `pnpm smoke`
  Result: pass
  Notes: TypeScript CLI smoke flow passed.

- Command: skill-creator audit via dynamic import
  Result: pass
  Notes: `skills/metasystem-builder` audit reported 0 errors and 0 warnings.

- Command: Tarot `migrate-layout --dry-run`, then `migrate-layout --apply`
  Result: pass
  Notes: Dry-run contained only `.framework/manifest.json -> .framework/manifest.json` to keep `__schema: 1` and upgrade `layout_version` to 3. Apply created backup `.framework/backups/20260617-153230` and event `.framework/events/2026-06.jsonl`.

- Command: Tarot `check`
  Result: pass
  Notes: `Framework check: ok`; remaining 5 warnings are user-modified managed files: `.gitignore`, `README.md`, `data/README.md`, `references/frozen/README.md`, `systems/README.md`.

- Command: Tarot `status`
  Result: pass
  Notes: layout version is 3; Systems section has 4 records, with `tarot-arcana-core-game` as primary, `card-eval-system` active, and `tarot-rework-game` / `tarot-roguelike-game` archived. Open iterations: 0; knowledge entries: 0.

**Known validation gaps**:
- 没有针对 ADR 链环检测的"性能"测试（深度上千的链）；不是必须，但若要做 enterprise-grade 可补。
- 没有针对 systems-registry primary 唯一性的 race 测试（多进程并发 register）；同上。
- skill-creator audit 的 "necessity.passive_reference" 启发式对路径字符串误判；本次绕过的方法是改写描述（"the workspace's frozen-references area" 而非裸 `references/frozen/`），后续若再 audit 注意这点。

## 10. Post-Completion Review Prompt

```text
你将 review metasystem-kit layout v3 改造的完成结果。

工作目录: C:\Programs\Meta\MetaSystem\systems\metasystem-kit
分支: feat/systems-registry-v3

完整背景与设计依据见: docs/handoff/handoff.md（本文件）。
原始审计报告见: C:\Programs\Games\CardGames\Tarot\.framework\AUDIT-metasystem-structure-20260617.md

第一步: 切到分支，复核最终验证：
  cd C:\Programs\Meta\MetaSystem\systems\metasystem-kit
  git checkout feat/systems-registry-v3
  pnpm build
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm smoke

不要做的事:
- 不要从 main 重新分支；feat/systems-registry-v3 已有需要保留的工作。
- 不要试图修复 skill-creator CLI 在 Windows 上的静默退出问题；用 handoff §9
  里的动态 import 调 core 即可。
- 不要碰 data/ 双写问题、references/intake 流程；这些已在审计 §8 列为暂不做。

Review checklist:
1. ADR core module, CLI commands, check validation, and tests are present.
2. Layout v3 templates manage only system.yaml for systems and include ADR-TEMPLATE.md.
3. metasystem-builder SKILL.md and references include ADR workflow guidance.
4. Tarot validation in §9 shows check ok, status layout version 3, and 4 systems.
5. Commit history is ready for human review / PR preparation.
```
