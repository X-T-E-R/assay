# Assay

Assay 是一个 local-first 证据工作台，管理 Project、Source、Analysis、Knowledge、Task、Roadmap、Spec 与独立版本化的 System。

## 0.12 工作区契约

Assay 0.12 只接受 `0.12.0+s4+l8`。旧 envelope 或畸形 authority 会 fail closed，必须交给外部 cutover 工具。

- `.assay/manifest.json` schema 4 只保存固定 framework version 与精确 layout 8；`layout.entries` 仅含一次性 Template 展开后的有界路径，不重复 deterministic native/core path。
- `project/project.yaml`（overlay 中是 `.assay/project/project.yaml`）是唯一 Project id/name authority。
- `.assay/managed-files.json` schema 1 只记录固定 core 资产的 no-clobber receipt。一次性 Template 输出属于用户，不进入 receipt。
- `.assay/systems-registry.json` 继续使用 schema 2；外部 Plugin descriptor 继续使用 schema 1，Assay 不安装或执行 payload。

## 开始

```bash
assay init ../assay-study --name AssayStudy --template study
assay template list
assay status --root ../assay-study
assay check --root ../assay-study
```

内置一次性 Template 只有 `study`、`solve`、`explore`。自定义 Template 必须传入显式 YAML 路径，closed schema 1 只允许 `description`、`directories`、`files`；file entry 必须且只能含 `content` 或相对 descriptor 的 `file`，`executable` 可选。绝对路径、穿越、retired path、redirect 与旧 Template 字段都会在首次 scaffold 写入前失败。Template identity 不持久化，因此 descriptor 删除后 status/check/update/convert 仍可工作。

## 显式 workspace index

普通 init/attach/adopt/update/convert/status/check 不触碰全局索引：

```bash
assay workspace track ../assay-study
assay workspace discover ../work
assay workspace list
assay workspace forget ../assay-study
```

记录位于 `~/.assay/workspaces`（可用 `ASSAY_WORKSPACES_ROOT` 覆盖），文件名是 canonical path hash，内容只含 schema 1 `project_id` 与 canonical `path`。同一 Project 可有多个 clone；`--rebind <old>` 必须显式给出且 Project id 相同。

详见 [docs/commands.md](docs/commands.md)、[docs/workspace-layout.md](docs/workspace-layout.md) 与 [docs/layout-modes.md](docs/layout-modes.md)。
