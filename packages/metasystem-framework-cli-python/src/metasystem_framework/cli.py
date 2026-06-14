from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .constants import CURRENT_VERSION
from .events import append_event
from .paths import discover_root, rel
from .scaffold import add_reference, check_framework, create_analysis, init_framework, print_status, start_iteration
from .updater import apply_update, migrate_layout


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="metasystem", description="Bootstrap and update an external-system-learning framework.")
    parser.add_argument("--version", action="version", version=f"metasystem {CURRENT_VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="Initialize a versioned framework structure without overwriting by default")
    p.add_argument("target", nargs="?", type=Path, default=Path.cwd())
    p.add_argument("--name")
    p.add_argument("--core")
    p.add_argument("--git", action="store_true")
    p.add_argument("--force", action="store_true", help="Overwrite existing files and track them as managed")
    p.add_argument("--create-new", action="store_true", help="Write .new copies when files already exist")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("check", help="Check required framework structure")
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("status", help="Print framework status")
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("update", help="Update managed framework files using manifest hashes")
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.add_argument("--dry-run", action="store_true")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--force", action="store_true", help="Overwrite modified/conflicting files")
    group.add_argument("--skip-all", action="store_true", help="Skip modified/conflicting files")
    group.add_argument("--create-new", action="store_true", help="Write modified/conflicting templates as .new")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("migrate-layout", help="Plan or apply old-to-new folder layout migration")
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.add_argument("--dry-run", action="store_true", default=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_migrate_layout)

    p_ref = sub.add_parser("reference", help="Reference operations")
    ref_sub = p_ref.add_subparsers(dest="reference_command", required=True)
    p = ref_sub.add_parser("add", help="Copy a local source directory into references/frozen/YYYYMM")
    p.add_argument("source", type=Path)
    p.add_argument("name")
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.set_defaults(func=cmd_reference_add)

    p_analysis = sub.add_parser("analysis", help="Analysis operations")
    analysis_sub = p_analysis.add_subparsers(dest="analysis_command", required=True)
    p = analysis_sub.add_parser("new", help="Create a reference analysis draft")
    p.add_argument("title")
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.set_defaults(func=cmd_analysis_new)

    p_iter = sub.add_parser("iteration", help="Iteration operations")
    iter_sub = p_iter.add_subparsers(dest="iteration_command", required=True)
    p = iter_sub.add_parser("start", help="Start an iteration against our own framework")
    p.add_argument("title")
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.set_defaults(func=cmd_iteration_start)

    p_event = sub.add_parser("event", help="Event ledger operations")
    event_sub = p_event.add_subparsers(dest="event_command", required=True)
    p = event_sub.add_parser("capture", help="Capture a low-friction event")
    p.add_argument("--kind", required=True, choices=["observation", "analysis", "decision", "gotcha", "note"])
    p.add_argument("--text", required=True)
    p.add_argument("--root", type=Path, default=Path.cwd())
    p.set_defaults(func=cmd_event_capture)

    return parser


def cmd_init(args: argparse.Namespace) -> int:
    report = init_framework(args.target, name=args.name, core=args.core, git=args.git, force=args.force, create_new=args.create_new)
    report.print()
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    return 0 if check_framework(root) else 1


def cmd_status(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    print_status(root)
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    action = "force" if args.force else "create-new" if args.create_new else "skip"
    report = apply_update(root, dry_run=args.dry_run, action=action)
    report.print()
    return 0


def cmd_migrate_layout(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    migrate_layout(root, dry_run=not args.apply, apply=args.apply)
    return 0


def cmd_reference_add(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    dest = add_reference(root, args.source.resolve(), args.name)
    print(f"Frozen reference: {rel(dest, root)}")
    return 0


def cmd_analysis_new(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    path = create_analysis(root, args.title)
    print(f"Created analysis: {rel(path, root)}")
    return 0


def cmd_iteration_start(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    path = start_iteration(root, args.title)
    print(f"Started iteration: {rel(path, root)}")
    return 0


def cmd_event_capture(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    path = append_event(root, {"event": "capture.created", "kind": args.kind, "text": args.text})
    print(f"Captured event: {rel(path, root)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except Exception as exc:  # keep CLI errors user-friendly
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
