from __future__ import annotations

import hashlib
from pathlib import Path


def normalize_text(text: str) -> str:
    """Normalize line endings so hashes are stable across platforms."""
    return text.replace("\r\n", "\n")


def compute_hash(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def file_hash(path: Path) -> str:
    return compute_hash(path.read_text(encoding="utf-8"))
