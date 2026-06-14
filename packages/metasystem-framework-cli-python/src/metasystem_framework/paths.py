from __future__ import annotations

import re
from pathlib import Path

from .constants import MANAGED_DIR


def rel(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def slugify(text: str) -> str:
    value = text.strip().lower()
    value = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "untitled"


def discover_root(start: Path) -> Path:
    current = start.resolve()
    if current.is_file():
        current = current.parent
    markers = [MANAGED_DIR, "references", "analyses", "systems", "iterations"]
    for candidate in [current, *current.parents]:
        if any((candidate / marker).exists() for marker in markers):
            return candidate
    return current
