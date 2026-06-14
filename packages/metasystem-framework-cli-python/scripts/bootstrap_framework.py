#!/usr/bin/env python3
"""Compatibility wrapper for the MetaSystem framework CLI."""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SRC = PACKAGE_DIR / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from metasystem_framework.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
