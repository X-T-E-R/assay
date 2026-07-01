# CLI 设置与调用

> English version: [cli-setup.md](cli-setup.md)

## skill 如何找到 CLI

这个 skill 位于 `assay` 仓库内的 `skills/assay-builder`,直接运行仓库的 CLI —— skill 里**没有**打包副本。仓库的 `packages/` 是唯一事实来源。

克隆仓库并运行安装脚本即可安装,它会构建工作区,并把 skill 以 junction(Windows)/ symlink(POSIX)方式链接进你的 skills 目录:

```bash
git clone <repo-url> assay
cd assay
node scripts/install.mjs            # 构建 + 链接进 ~/.agents/skills
```

常用参数:`--target <dir>`(skills 目录)、`--name <skill-name>`、`--force`(替换已有)、`--no-build`(只重新链接)、`--dry-run`(预览)。

## 调用 CLI

使用 skill 本地的 launcher。它会穿过 junction/symlink 解析回仓库,向上查找已构建的 CLI 并运行:

```bash
node <skill-root>/scripts/assay.mjs <command>
```

`<skill-root>` 是 skill 安装的位置(例如 `~/.agents/skills/assay-builder`)。launcher 不需要绝对路径 —— 保持克隆的仓库在原地,链接就能解析回去。

## 构建(首次必做)

`dist/` 是构建产物,**不**纳入 git。`scripts/install.mjs` 会替你构建;手动构建:

```bash
cd <repo-root>
pnpm install --frozen-lockfile
pnpm build
```

launcher 运行的编译入口:

```text
packages/assay-cli/dist/cli.js
```

如果 skill 不是从仓库内部安装的(找不到仓库),或仓库尚未构建(`dist/` 缺失),launcher 会明确报错,并在消息里给出构建命令。

## 直接调用(调试用)

要绕开 launcher,从仓库直接运行已构建的 CLI:

```bash
node <repo-root>/packages/assay-cli/dist/cli.js <command>
```

全局 `assay` 命令(在 `packages/assay-cli` 里 `npm link`)是可选的,只为人类交互使用,不用于 agent 工作流。

## 工作目录约定

所有工作区命令(`init`、`adopt`、`check`、`status`、`update`、`migrate-layout`、`source add|sync|switch|status|diff|log`、`reference add`、`analysis new`、`analysis close`、`iteration start`、`iteration close`、`knowledge add`、`adr new|accept|supersede|deprecate|list|show`、`system register|promote|archive|list|show`)默认用 `process.cwd()`,并向上查找 `.framework/manifest.json`。

运行命令前先 `cd <target-dir>`;只有要操作别处的工作区时,才传 `--root <path>` / `[target-dir]`。

## 项目注册表

CLI 在 `~/.assay/projects` 跟踪已初始化的工作区。注册表命令:

```bash
assay projects list              # 列出已知工作区
assay projects show <selector>   # 查看一个工作区(selector 必填)
assay projects scan <roots...>   # 按 manifest 发现工作区
assay projects prune --dry-run   # 预览清理失效记录
assay projects forget <selector> # 移除一条注册记录(绝不删除项目文件)
```

这些命令只操作注册表元数据,绝不修改项目文件。

## 系统注册表(每个工作区)

与项目注册表不同,每个工作区有一份位于 `.framework/systems-registry.json` 的系统注册表,自布局 v3 引入。用 `system` 命令组管理它,不要直接编辑 JSON:

```bash
assay system register <path> [--vcs ...] [--primary] [--supersedes ...] [--system-version ...]
assay system promote <selector>
assay system archive <selector> --dry-run | --apply
assay system list [--status ...] [--json]
assay system show <selector>
```

selector 可以是完整系统名,或唯一的名称前缀。

## ADR 索引(每个工作区)

每个工作区可在 `.framework/adrs.json` 跟踪架构决策记录,markdown 文件位于 `knowledge/decisions/`。用 `adr` 命令组管理 ADR,不要直接编辑 JSON:

```bash
assay adr new "Title" [--from-analysis <path>] [--from-iteration <path>]
assay adr accept <selector>
assay adr supersede <old-selector> <new-selector>
assay adr deprecate <selector>
assay adr list [--status proposed|accepted|superseded|deprecated] [--json]
assay adr show <selector> [--json]
```

selector 可以是完整 ADR id、唯一 id 前缀,或 ADR 编号。
