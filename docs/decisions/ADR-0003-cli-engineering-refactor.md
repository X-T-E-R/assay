# ADR-0003：CLI 从单文件脚本重构为可安装 Python package

- 状态：Accepted
- 日期：2026-06-13

## 背景

现有 `scripts/bootstrap_framework.py` 是单文件。它已经承载 init、scaffold、check、capture、trellis bridge、queue、event、migration 等大量职责。继续在单文件里加入 version/update 会让风险变高。

## 决策

新版 CLI 使用零运行时依赖的 Python package 结构：

```text
bootstrap_framework/
├── SKILL.md
├── pyproject.toml
├── scripts/bootstrap_framework.py      # 兼容 skill 直跑的 wrapper
├── src/metasystem_framework/
│   ├── cli.py                          # argparse 命令路由
│   ├── constants.py                    # 当前版本、目录常量
│   ├── paths.py                        # root discovery、slug、相对路径
│   ├── hashing.py                      # LF-normalized SHA256
│   ├── manifest.py                     # load/save/update manifest
│   ├── templates.py                    # desired template tree
│   ├── scaffold.py                     # init/check/status/reference/analysis/iteration
│   ├── updater.py                      # update/migrate-layout pipeline
│   └── events.py                       # jsonl event ledger
└── tests/
```

## CLI 命令面

第一版保留核心命令：

```bash
metasystem init <target> --name <project> [--git]
metasystem check --root <root>
metasystem status --root <root>
metasystem update --root <root> [--dry-run|--force|--skip-all|--create-new]
metasystem migrate-layout --root <root> [--dry-run|--apply]
metasystem reference add <source-dir> <name> --root <root>
metasystem analysis new <title> --root <root>
metasystem iteration start <title> --root <root>
metasystem event capture --kind observation --text "..." --root <root>
```

## 为什么不用 Click/Typer

它们适合更丰富的交互 CLI，但 skill 交付的第一要求是“拿到目录就能跑”。因此第一版使用标准库 `argparse`，同时在 `pyproject.toml` 保留 console script，未来可无痛替换前端库。

## 测试要求

最小测试覆盖：

1. init 创建新结构和 manifest；
2. 用户修改 managed 文件后 update 默认不覆盖；
3. 用户删除 managed 文件后 update 默认不恢复；
4. reference add 会复制并写事件；
5. migrate-layout 默认 dry-run 不改文件。

## 兼容策略

`scripts/bootstrap_framework.py` 作为 wrapper 保留，避免 skill 使用者必须先 install package。wrapper 会把 `src/` 加入 `sys.path` 后调用 `metasystem_framework.cli.main()`。

## 后果

正面：

- 可测试；
- 可安装；
- update 机制可以独立演化；
- skill 文档和 CLI 逻辑边界清晰。

代价：

- 文件数量增加；
- 初次阅读比单脚本略复杂；
- 模板维护需要 discipline。
