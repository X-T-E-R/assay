from __future__ import annotations

import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from .constants import CURRENT_VERSION, MANAGED_DIR, PRIMARY_DIRS, VERSION_FILE, MANIFEST_FILE
from .events import append_event
from .hashing import compute_hash
from .manifest import default_manifest, load_manifest, record_template, save_manifest
from .paths import rel, slugify
from .reporting import Report
from .templates import desired_templates


def ensure_dir(path: Path, root: Path, report: Report) -> None:
    if path.exists():
        report.add_dir(path, root, created=False)
    else:
        path.mkdir(parents=True, exist_ok=True)
        report.add_dir(path, root, created=True)


def write_file(path: Path, content: str, root: Path, report: Report, *, force: bool = False, create_new: bool = False) -> bool:
    display = rel(path, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not force:
        if create_new:
            new_path = path.with_name(path.name + ".new")
            new_path.write_text(content, encoding="utf-8")
            report.new_copies.append(rel(new_path, root))
        else:
            report.skipped_files.append(display)
        return False
    path.write_text(content, encoding="utf-8")
    if display not in report.created_files and display not in report.updated_files:
        (report.updated_files if path.exists() and force else report.created_files).append(display)
    return True


def init_framework(target: Path, name: str | None = None, core: str | None = None, git: bool = False, force: bool = False, create_new: bool = False) -> Report:
    root = target.resolve()
    project = name or root.name
    core_name = core or f"{slugify(project)}-core"
    report = Report()

    ensure_dir(root, root, report)
    for directory in PRIMARY_DIRS:
        ensure_dir(root / directory, root, report)
    ensure_dir(root / f"systems/{core_name}/docs", root, report)

    manifest = load_manifest(root) or default_manifest(project, core_name)
    for template in desired_templates(project, core_name):
        path = root / template.path
        if path.exists() and not force:
            # Existing files are user-owned until explicitly overwritten. Do not track skipped files.
            if create_new:
                write_file(path, template.content, root, report, create_new=True)
            else:
                report.skipped_files.append(template.path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        existed = path.exists()
        path.write_text(template.content, encoding="utf-8")
        if template.executable:
            path.chmod(path.stat().st_mode | 0o755)
        (report.updated_files if existed else report.created_files).append(template.path)
        record_template(manifest, template)

    save_manifest(root, manifest)
    if MANIFEST_FILE not in report.created_files and MANIFEST_FILE not in report.updated_files:
        report.created_files.append(MANIFEST_FILE)

    append_event(root, {"event": "framework.initialized", "version": CURRENT_VERSION, "project": project, "core": core_name})

    if git and not (root / ".git").exists():
        result = subprocess.run(["git", "init"], cwd=root, capture_output=True, text=True)
        if result.returncode == 0:
            report.notes.append("initialized root git repository")
        else:
            report.notes.append("git init failed: " + (result.stderr.strip() or result.stdout.strip()))
    return report


def check_framework(root: Path) -> bool:
    ok = True
    checks = [
        (root / MANAGED_DIR, ".framework directory"),
        (root / VERSION_FILE, ".framework/VERSION"),
        (root / MANIFEST_FILE, ".framework/manifest.json"),
        (root / "references", "references directory"),
        (root / "analyses", "analyses directory"),
        (root / "systems", "systems directory"),
        (root / "iterations", "iterations directory"),
        (root / "knowledge", "knowledge directory"),
    ]
    for path, label in checks:
        exists = path.exists()
        ok = ok and exists
        print(f"{'[OK]' if exists else '[MISS]'} {label}: {rel(path, root)}")
    manifest = load_manifest(root)
    if manifest:
        print(f"[OK] manifest schema: {manifest.get('__schema')}")
        print(f"[OK] framework version: {manifest.get('framework_version')}")
        print(f"[OK] managed files: {len(manifest.get('managed_files', {}))}")
    else:
        print("[MISS] readable manifest")
        ok = False
    print(f"\nResult: {'pass' if ok else 'needs attention'}")
    return ok


def print_status(root: Path) -> None:
    manifest = load_manifest(root)
    if not manifest:
        print("No .framework/manifest.json found.")
        return
    print("Framework status")
    print(f"  root: {root}")
    print(f"  installed_version: {manifest.get('framework_version')}")
    print(f"  layout_version: {manifest.get('layout_version')}")
    print(f"  project: {manifest.get('project', {}).get('name')}")
    print(f"  core: {manifest.get('project', {}).get('core')}")
    print(f"  managed_files: {len(manifest.get('managed_files', {}))}")
    for zone in ["references/frozen", "analyses/references", "analyses/patterns", "iterations", "knowledge"]:
        path = root / zone
        count = sum(1 for _ in path.glob("**/*") if _.is_file()) if path.exists() else 0
        print(f"  {zone}: {count} files")


def add_reference(root: Path, source: Path, name: str) -> Path:
    month = datetime.now().strftime("%Y%m")
    dest = root / "references" / "frozen" / month / slugify(name)
    if dest.exists():
        raise FileExistsError(f"reference already exists: {rel(dest, root)}")
    ignore = shutil.ignore_patterns(".venv", "node_modules", "__pycache__", "dist", "build", ".next")
    shutil.copytree(source, dest, ignore=ignore)
    append_event(root, {"event": "reference.frozen", "name": name, "path": rel(dest, root), "source": str(source)})
    return dest


def create_analysis(root: Path, title: str) -> Path:
    path = root / "analyses" / "references" / f"{datetime.now().strftime('%Y-%m-%d')}-{slugify(title)}.md"
    if path.exists():
        raise FileExistsError(f"analysis already exists: {rel(path, root)}")
    content = f"# {title}\n\n- Date: {datetime.now().strftime('%Y-%m-%d')}\n- Status: draft\n\n## Reference\n\n## Key observations\n\n## Adopt\n\n## Reject\n\n## Next iteration\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    append_event(root, {"event": "analysis.created", "title": title, "path": rel(path, root)})
    return path


def start_iteration(root: Path, title: str) -> Path:
    path = root / "iterations" / f"{datetime.now().strftime('%Y-%m-%d')}-{slugify(title)}"
    if path.exists():
        raise FileExistsError(f"iteration already exists: {rel(path, root)}")
    path.mkdir(parents=True)
    plan = path / "plan.md"
    plan.write_text(f"# {title}\n\n- Date: {datetime.now().strftime('%Y-%m-%d')}\n- Status: open\n\n## Hypothesis\n\n## Scope\n\n## Verification\n\n## Rollback\n\n## Result\n", encoding="utf-8")
    append_event(root, {"event": "iteration.started", "title": title, "path": rel(path, root)})
    return path
