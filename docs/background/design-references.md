# Design References

MetaSystem Kit uses a small set of public references to guide CLI design, versioning, update policy, and repository governance.

## CLI Behavior

- [Command Line Interface Guidelines](https://clig.dev/) — guidance for human-friendly command behavior, composability, help output, stdout/stderr separation, exit codes, dry-run modes, and confirmations.
- [Python `argparse`](https://docs.python.org/3/library/argparse.html) — standard-library support for options, arguments, subcommands, help text, and usage errors.
- [Click](https://click.palletsprojects.com/) — a richer Python CLI framework that may be useful later if the command surface becomes more interactive.
- [PyPA `pyproject.toml` entry points](https://packaging.python.org/en/latest/specifications/pyproject-toml/#entry-points) — the mechanism used to expose installed console commands such as `metasystem`.

MetaSystem Kit currently uses `argparse` because the CLI should run in minimal Python environments without extra dependencies. The package still exposes a normal `[project.scripts]` entry point so users can install it as a command.

## Versioning And Updates

- [Semantic Versioning](https://semver.org/) — a useful convention for separating incompatible changes, compatible feature additions, and bug fixes.
- [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) — guidance for human-readable release notes rather than raw commit dumps.

MetaSystem Kit distinguishes three version layers:

| Layer | Location | Meaning |
| --- | --- | --- |
| CLI/package version | `pyproject.toml` and package constants | Capability version of the tool |
| Installed framework version | `.framework/VERSION` | Template version installed in a workspace |
| Layout/schema version | `.framework/manifest.json` | Manifest and directory-layout compatibility |

Updates should compare the installed workspace version, not just the currently installed CLI package.

## Repository Governance

- [GitHub repository best practices](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories) — README, license, citation, and contribution guidance help set expectations.
- [GitHub community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories) — describes common community health files such as README, CODE_OF_CONDUCT, LICENSE, and CONTRIBUTING.
- [The Turing Way: Project Documentation](https://book.the-turing-way.org/reproducible-research/code-documentation/code-documentation-project/) — emphasizes documentation for software project management and reproducible work.
- [OpenSSF Scorecard](https://scorecard.dev/) — useful for thinking about dependency and project-health risk when evaluating external references.

These references support the repository-level choices in MetaSystem Kit: a clear README, explicit contribution boundaries, a license, check scripts, and a framework workflow that records where external material came from and how it was evaluated.
