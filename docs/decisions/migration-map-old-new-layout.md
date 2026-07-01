# 旧/新目录迁移设计

## 新目标结构

```text
.framework/
references/intake/
references/frozen/YYYYMM/<name>/
analyses/references/
analyses/gaps/
analyses/patterns/
systems/<core>/
iterations/YYYY-MM-DD-<topic>/
knowledge/
data/
releases/
```

## 旧结构兼容

旧结构：

```text
systems/
references/YYYYMM/
data/YYYYMM/
experiments/
knowledge/evaluations/
.metasystem/
```

## 迁移策略

### 1. references

旧：`references/202605/trellis/`

新：`references/frozen/202605/trellis/`

策略：copy-first。原因：frozen reference 是外部资料，一旦误删很难恢复；并且旧路径可能被文档引用。

### 2. analyses

旧：`knowledge/evaluations/*.md`

新：

- `analyses/references/*.md`：单个外部系统分析；
- `analyses/gaps/*.md`：本地与外部对比；
- `analyses/patterns/*.md`：候选模式。

策略：不自动分类；生成 TODO。原因：文件语义需要人/AI 判断，不能靠路径自动推断。

### 3. systems

旧：`systems/<core>/`

新：仍为 `systems/<core>/`。

策略：保留系统实现目录，但只生成或更新 `system.yaml` 契约，并通过 `.framework/systems-registry.json` 记录 primary/active/archive 状态。系统 README、CHANGELOG 和 docs 属于系统自身，不作为框架模板补写。

### 4. experiments → iterations

旧：`experiments/<date>-<name>/`

新：`iterations/<date>-<name>/`

策略：copy-first；保留 `experiments/LEGACY_LAYOUT.md`。原因：iterations 更准确表达“迭代本地系统”，但旧 experiments 可能含有实验数据和外部链接。

### 5. Legacy runtime directory → .framework

旧：legacy events, queue, and standalone runtime configuration under the previous hidden runtime directory

新：`.framework/events/*.jsonl`、`.framework/manifest.json`

策略：只复制可识别事件和 queue，不自动删除旧运行时目录。原因：旧目录可能承载运行状态，直接搬迁风险高。新工作区身份以 `.framework/manifest.json` 为准。

## 命令行为

```bash
assay migrate-layout --root . --dry-run
```

输出 plan，不改文件。

```bash
assay migrate-layout --root . --apply --mode copy
```

创建 backup，复制可安全迁移的目录，写入 `.framework/events/YYYY-MM.jsonl`。

## 清理策略

第一个 minor 周期只做 copy 和 legacy 标记；第二个 minor 周期如果确认旧目录无人引用，再允许：

```bash
assay migrate-layout --root . --cleanup-empty-legacy
```

该清理命令必须只删除空目录或 manifest/hash 可证明的旧模板文件。
