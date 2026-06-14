from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .constants import EVENTS_DIR
from .manifest import now_iso


def event_path(root: Path, when: datetime | None = None) -> Path:
    when = when or datetime.now()
    return root / EVENTS_DIR / f"{when.strftime('%Y-%m')}.jsonl"


def append_event(root: Path, event: dict[str, Any]) -> Path:
    event.setdefault("ts", now_iso())
    path = event_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    return path
