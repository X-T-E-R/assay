from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

from .constants import CURRENT_VERSION, BACKUPS_DIR, MANIFEST_FILE, VERSION_FILE
from .events import append_event
from .hashing import compute_hash, file_hash
from .manifest import load_manifest, project_from_manifest, record_template, save_manifest
from .paths import rel
from .reporting import Report
from .templates import TemplateFile, desired_templates

ConflictAction = Literal["skip", "force", "create-new"]


@dataclass
class ChangeSet:
    new_files: list[TemplateFile] = field(default_factory=list)
    auto_update: list[TemplateFile] = field(default_factory=list)
    modified: list[TemplateFile] = field(default_factory=list)
    user_deleted: list[TemplateFile] = field(default_factory=list)
    unchanged: list[TemplateFile] = field(default_factory=list)
    untracked_existing: list[TemplateFile] = field(default_factory=list)

    def has_changes(self) -> bool:
        return any([self.new_files, self.auto_update, self.modified, self.user_deleted, self.untracked_existing])


def analyze_update(root: Path) -> tuple[ChangeSet, dict]:
    manifest = load_manifest(root)
    if not manifest:
        raise RuntimeError("No .framework/manifest.json found. Run init first.")
    project, core = project_from_manifest(manifest, root)
    desired = desired_templates(project, core)
    managed = manifest.get("managed_files", {}) if isinstance(manifest.get("managed_files"), dict) else {}
    changes = ChangeSet()
    for template in desired:
        path = root / template.path
        record = managed.get(template.path)
        exists = path.exists()
        desired_hash = compute_hash(template.content)
        if not exists:
            if record:
                changes.user_deleted.append(template)
            else:
                changes.new_files.append(template)
            continue
        current_hash = file_hash(path)
        if not record:
            if current_hash == desired_hash:
                changes.unchanged.append(template)
            else:
                changes.untracked_existing.append(template)
            continue
        recorded_hash = str(record.get("hash") or "")
        if current_hash == desired_hash:
            changes.unchanged.append(template)
        elif current_hash == recorded_hash:
            changes.auto_update.append(template)
        else:
            changes.modified.append(template)
    return changes, manifest


def create_backup(root: Path, paths: list[str]) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = root / BACKUPS_DIR / stamp
    backup.mkdir(parents=True, exist_ok=True)
    for item in [MANIFEST_FILE, VERSION_FILE, *paths]:
        src = root / item
        if not src.exists() or src.is_dir():
            continue
        dest = backup / item
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    return backup


def print_change_summary(changes: ChangeSet) -> None:
    print("Update analysis")
    rows = [
        ("new", changes.new_files),
        ("auto-update", changes.auto_update),
        ("modified-by-user", changes.modified),
        ("user-deleted", changes.user_deleted),
        ("untracked-existing", changes.untracked_existing),
        ("unchanged", changes.unchanged),
    ]
    for label, files in rows:
        print(f"  {label}: {len(files)}")
        for template in files[:10]:
            print(f"    - {template.path}")
        if len(files) > 10:
            print(f"    ... {len(files) - 10} more")


def apply_update(root: Path, *, dry_run: bool = False, action: ConflictAction = "skip") -> Report:
    changes, manifest = analyze_update(root)
    print_change_summary(changes)
    report = Report()
    if dry_run:
        report.notes.append("dry-run: no changes applied")
        return report

    to_backup = [t.path for t in [*changes.auto_update, *changes.modified, *changes.untracked_existing] if (root / t.path).exists()]
    backup = create_backup(root, to_backup)
    report.notes.append(f"backup: {rel(backup, root)}")

    for template in changes.new_files:
        path = root / template.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(template.content, encoding="utf-8")
        report.created_files.append(template.path)
        record_template(manifest, template)

    for template in changes.auto_update:
        path = root / template.path
        path.write_text(template.content, encoding="utf-8")
        report.updated_files.append(template.path)
        record_template(manifest, template)

    for template in changes.modified + changes.untracked_existing:
        path = root / template.path
        if action == "force":
            path.write_text(template.content, encoding="utf-8")
            report.updated_files.append(template.path)
            record_template(manifest, template)
        elif action == "create-new":
            new_path = path.with_name(path.name + ".new")
            new_path.write_text(template.content, encoding="utf-8")
            report.new_copies.append(rel(new_path, root))
        else:
            report.skipped_files.append(template.path)

    for template in changes.user_deleted:
        # Respect user deletion; keep manifest record but mark it.
        manifest.setdefault("user_deleted", [])
        if template.path not in manifest["user_deleted"]:
            manifest["user_deleted"].append(template.path)
        report.skipped_files.append(template.path + " (user-deleted)")

    manifest["framework_version"] = CURRENT_VERSION
    save_manifest(root, manifest)
    append_event(root, {"event": "framework.updated", "version": CURRENT_VERSION, "action": action, "summary": {
        "created": len(report.created_files),
        "updated": len(report.updated_files),
        "skipped": len(report.skipped_files),
        "new_copies": len(report.new_copies),
    }})
    return report


def build_layout_migration_plan(root: Path) -> list[dict[str, str]]:
    plan: list[dict[str, str]] = []
    # Old references/YYYYMM -> references/frozen/YYYYMM. Ignore already-new frozen dir.
    refs = root / "references"
    if refs.exists():
        for child in refs.iterdir():
            if child.name in {"frozen", "intake"} or not child.is_dir():
                continue
            if child.name.isdigit() and len(child.name) == 6:
                plan.append({"type": "copy-dir", "from": rel(child, root), "to": f"references/frozen/{child.name}"})
    exp = root / "experiments"
    if exp.exists():
        plan.append({"type": "copy-dir", "from": "experiments", "to": "iterations"})
    meta = root / ".metasystem"
    if meta.exists():
        for item in ["events", "queue.json", "config.yaml"]:
            if (meta / item).exists():
                plan.append({"type": "copy", "from": f".metasystem/{item}", "to": f".framework/legacy-metasystem/{item}"})
    evals = root / "knowledge" / "evaluations"
    if evals.exists():
        plan.append({"type": "manual-review", "from": "knowledge/evaluations", "to": "analyses/references or analyses/gaps", "reason": "semantic classification required"})
    return plan


def migrate_layout(root: Path, *, dry_run: bool = True, apply: bool = False) -> list[dict[str, str]]:
    plan = build_layout_migration_plan(root)
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    if dry_run or not apply:
        print("dry-run: no layout changes applied")
        return plan
    backup = create_backup(root, [item["from"] for item in plan if item.get("type") != "manual-review"])
    for item in plan:
        kind = item.get("type")
        if kind == "copy-dir":
            src, dst = root / item["from"], root / item["to"]
            if src.exists():
                # Copy-first migration. Existing destination files are preserved by copytree.
                shutil.copytree(src, dst, dirs_exist_ok=True)
        elif kind == "copy":
            src, dst = root / item["from"], root / item["to"]
            if src.exists() and not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                if src.is_dir():
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)
    append_event(root, {"event": "layout.migrated", "backup": rel(backup, root), "plan": plan})
    return plan
