from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from metasystem_framework.manifest import load_manifest
from metasystem_framework.scaffold import add_reference, init_framework
from metasystem_framework.updater import analyze_update, apply_update, build_layout_migration_plan


class FrameworkCliCoreTests(unittest.TestCase):
    def test_init_creates_manifest_and_structure(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "demo"
            report = init_framework(root, name="Demo")
            self.assertTrue((root / ".framework" / "VERSION").exists())
            self.assertTrue((root / ".framework" / "manifest.json").exists())
            self.assertTrue((root / "references" / "frozen").exists())
            self.assertTrue((root / "analyses" / "templates").exists())
            manifest = load_manifest(root)
            self.assertIsNotNone(manifest)
            self.assertGreater(len(manifest["managed_files"]), 5)

    def test_update_does_not_overwrite_user_modified_managed_file_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "demo"
            init_framework(root, name="Demo")
            readme = root / "README.md"
            readme.write_text("# user edit\n", encoding="utf-8")
            changes, _ = analyze_update(root)
            self.assertTrue(any(t.path == "README.md" for t in changes.modified))
            apply_update(root, dry_run=False, action="skip")
            self.assertEqual(readme.read_text(encoding="utf-8"), "# user edit\n")

    def test_update_respects_user_deleted_managed_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "demo"
            init_framework(root, name="Demo")
            target = root / "knowledge" / "guides" / "README.md"
            target.unlink()
            changes, _ = analyze_update(root)
            self.assertTrue(any(t.path == "knowledge/guides/README.md" for t in changes.user_deleted))
            apply_update(root, dry_run=False, action="skip")
            self.assertFalse(target.exists())

    def test_add_reference_copies_source_and_writes_event(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "demo"
            source = Path(td) / "source"
            source.mkdir()
            (source / "README.md").write_text("# Source\n", encoding="utf-8")
            init_framework(root, name="Demo")
            dest = add_reference(root, source, "Source Project")
            self.assertTrue((dest / "README.md").exists())
            events = list((root / ".framework" / "events").glob("*.jsonl"))
            self.assertTrue(events)
            self.assertIn("reference.frozen", "\n".join(p.read_text(encoding="utf-8") for p in events))

    def test_migrate_layout_is_plan_only(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "demo"
            init_framework(root, name="Demo")
            legacy = root / "experiments" / "2026-01-01-old"
            legacy.mkdir(parents=True)
            plan = build_layout_migration_plan(root)
            self.assertTrue(any(item["from"] == "experiments" for item in plan))
            self.assertFalse((root / "iterations" / "2026-01-01-old").exists())


if __name__ == "__main__":
    unittest.main()
