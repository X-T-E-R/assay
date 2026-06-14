# ADR-0002：引入版本系统、manifest hash、显式 update/migration

- 状态：Accepted
- 日期：2026-06-13

## 背景

framework 初始化以后会继续演化：目录、模板、skill、CLI、工作流都会升级。如果没有版本和 update 机制，用户只能手动复制新文件，最终必然出现旧文件夹、新文件夹、用户修改文件和模板文件混在一起的问题。

Trellis 的经验表明，安全更新的关键不是“覆盖”，而是“识别文件归属和用户修改”。

## 决策

引入三层版本：

| 层 | 位置 | 含义 |
| --- | --- | --- |
| Package/CLI version | package constant / `pyproject.toml` | 当前工具版本 |
| Installed framework version | `.framework/VERSION` | 目标仓库安装的 framework 模板版本 |
| Manifest/schema/layout version | `.framework/manifest.json` | manifest 格式与目录结构版本 |

`.framework/manifest.json` 记录每个 managed file：

```json
{
  "managed_files": {
    "README.md": {
      "template_id": "root.readme",
      "hash": "sha256...",
      "installed_version": "0.2.0",
      "protected": false
    }
  }
}
```

## update 分类规则

| 情况 | 默认动作 |
| --- | --- |
| 新模板文件，目标不存在 | create |
| managed 文件存在，当前 hash 等于 manifest hash | auto-update |
| managed 文件存在，当前 hash 不等于 manifest hash | conflict；默认 skip，可 `--force` 或 `--create-new` |
| managed 文件被用户删除 | respect deletion；默认不恢复 |
| 目标路径存在但不在 manifest | conflict；默认 `.new` 或 skip |
| protected user data | 永不自动覆盖 |
| breaking migration | 必须显式 `--migrate` |

## 旧文件夹与新文件夹的处理

### 原则

1. 不静默删除旧目录。
2. 不直接 move 用户数据；默认 dry-run。
3. 真正 apply 时先备份，再 copy-first。
4. 只有被 manifest/hash 证明是未修改模板的文件，才可自动 rename/delete。
5. 对外部 reference、analysis、iteration、knowledge 一律视为用户数据。

### 迁移表

| 旧路径 | 新路径 | 策略 |
| --- | --- | --- |
| `references/YYYYMM/<project>/` | `references/frozen/YYYYMM/<project>/` | copy-first；旧路径留 `LEGACY_LAYOUT.md` |
| `experiments/<date>-<name>/` | `iterations/<date>-<name>/` | copy-first；保留旧 experiments 一个 minor 周期 |
| `knowledge/evaluations/` | `analyses/references/` 或 `analyses/gaps/` | 不自动分类；生成迁移 TODO |
| `.metasystem/` | `.framework/` | 只迁移 config/events/queue 的可识别部分；保留原目录 |
| `systems/<core>/docs/*` | `systems/<core>/docs/*` | 路径保留，但纳入 manifest 分类 |

## update 命令设计

```bash
metasystem update --root . --dry-run
metasystem update --root . --create-new
metasystem update --root . --force
metasystem update --root . --migrate
metasystem migrate-layout --root . --dry-run
metasystem migrate-layout --root . --apply --mode copy
```

## 备份策略

每次非 dry-run update/migration 前创建：

```text
.framework/backups/YYYYMMDD-HHMMSS/
```

备份内容包括：

- `.framework/manifest.json`
- `.framework/VERSION`
- 所有即将被写入或迁移的 managed 文件
- migration plan JSON

## 后果

正面：

- 可以长期升级 framework；
- 用户改动不会被静默覆盖；
- 旧目录和新目录关系可审计；
- CLI 能解释自己将做什么。

代价：

- manifest 维护增加复杂度；
- update 代码需要测试；
- 用户需要理解 `--migrate` 和 `--force` 的区别。
