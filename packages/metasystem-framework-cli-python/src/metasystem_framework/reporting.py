from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .paths import rel


@dataclass
class Report:
    created_dirs: list[str] = field(default_factory=list)
    existing_dirs: list[str] = field(default_factory=list)
    created_files: list[str] = field(default_factory=list)
    updated_files: list[str] = field(default_factory=list)
    skipped_files: list[str] = field(default_factory=list)
    conflicted_files: list[str] = field(default_factory=list)
    new_copies: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add_dir(self, path: Path, root: Path, created: bool) -> None:
        (self.created_dirs if created else self.existing_dirs).append(rel(path, root))

    def print(self) -> None:
        print("\nSummary")
        rows = [
            ("created dirs", len(self.created_dirs)),
            ("existing dirs", len(self.existing_dirs)),
            ("created files", len(self.created_files)),
            ("updated files", len(self.updated_files)),
            ("skipped files", len(self.skipped_files)),
            ("conflicts", len(self.conflicted_files)),
            (".new copies", len(self.new_copies)),
        ]
        for label, count in rows:
            print(f"  {label}: {count}")
        for title, values in [
            ("conflicted", self.conflicted_files),
            ("skipped", self.skipped_files),
            ("new copies", self.new_copies),
        ]:
            if values:
                print(f"\n{title} files:")
                for item in values[:20]:
                    print(f"  - {item}")
                if len(values) > 20:
                    print(f"  ... {len(values) - 20} more")
        if self.notes:
            print("\nNotes:")
            for note in self.notes:
                print(f"  - {note}")
