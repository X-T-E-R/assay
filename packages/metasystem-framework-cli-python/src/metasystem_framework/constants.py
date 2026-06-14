from __future__ import annotations

CURRENT_VERSION = "0.2.0"
LAYOUT_VERSION = 2
MANAGED_DIR = ".framework"
VERSION_FILE = f"{MANAGED_DIR}/VERSION"
MANIFEST_FILE = f"{MANAGED_DIR}/manifest.json"
EVENTS_DIR = f"{MANAGED_DIR}/events"
BACKUPS_DIR = f"{MANAGED_DIR}/backups"

PRIMARY_DIRS = [
    "references/intake",
    "references/frozen",
    "analyses/references",
    "analyses/gaps",
    "analyses/patterns",
    "analyses/templates",
    "systems",
    "iterations/templates",
    "knowledge/guides",
    "knowledge/decisions",
    "knowledge/patterns",
    "knowledge/troubleshooting",
    "data",
    "releases",
    f"{MANAGED_DIR}/events",
    f"{MANAGED_DIR}/backups",
    f"{MANAGED_DIR}/migrations",
]

PROTECTED_PREFIXES = [
    "references/frozen/",
    "analyses/references/",
    "analyses/gaps/",
    "analyses/patterns/",
    "iterations/",
    "knowledge/",
    "data/",
]
