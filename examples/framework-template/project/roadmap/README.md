# Roadmap

This directory contains Assay-native Roadmap items. Each live item is stored at `<id>/{item.yaml,outcome.md}`; terminal items may be moved unchanged to `archive/<id>/`.

The root README is explanatory only. It is never a generated index. Machine state belongs in each `item.yaml`, while reader-edited outcome prose belongs in `outcome.md` and is never rewritten by lifecycle commands.

Roadmap items link to Tasks from their canonical `task_refs` field. Tasks do not carry Roadmap back-references, and neither Task nor Roadmap status changes propagate automatically.
