from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .constants import CURRENT_VERSION, LAYOUT_VERSION, MANIFEST_FILE
from .hashing import compute_hash
from .templates import TemplateFile


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def manifest_path(root: Path) -> Path:
    return root / MANIFEST_FILE


def default_manifest(project: str, core: str) -> dict[str, Any]:
    return {
        "__schema": 1,
        "framework_version": CURRENT_VERSION,
        "layout_version": LAYOUT_VERSION,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "project": {"name": project, "core": core},
        "managed_files": {},
        "user_deleted": [],
        "applied_migrations": [],
    }


def load_manifest(root: Path) -> dict[str, Any] | None:
    path = manifest_path(root)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def save_manifest(root: Path, manifest: dict[str, Any]) -> None:
    manifest["updated_at"] = now_iso()
    path = manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def record_template(manifest: dict[str, Any], template: TemplateFile, content: str | None = None) -> None:
    text = template.content if content is None else content
    manifest.setdefault("managed_files", {})[template.path] = {
        "template_id": template.template_id,
        "hash": compute_hash(text),
        "installed_version": CURRENT_VERSION,
        "protected": template.protected,
        "executable": template.executable,
        "updated_at": now_iso(),
    }


def project_from_manifest(manifest: dict[str, Any] | None, fallback_root: Path) -> tuple[str, str]:
    if manifest:
        project = manifest.get("project", {}) if isinstance(manifest.get("project"), dict) else {}
        name = str(project.get("name") or fallback_root.name)
        core = str(project.get("core") or f"{fallback_root.name}-core")
        return name, core
    return fallback_root.name, f"{fallback_root.name}-core"
