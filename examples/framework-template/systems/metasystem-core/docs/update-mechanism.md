
# Update Mechanism

## State files

- `.framework/VERSION`: installed framework version.
- `.framework/manifest.json`: managed files, template IDs, hashes, and installed versions.
- `.framework/backups/`: backups before writes.

## Classification

| Classification | Meaning | Default |
| --- | --- | --- |
| new | desired template does not exist and is not user-deleted | create |
| auto-update | manifest hash equals current hash | update |
| modified | current hash differs from manifest hash | skip |
| user-deleted | manifest tracked it but path is absent | respect deletion |
| untracked-existing | path exists but not in manifest | skip / `.new` |

## Migration

Layout migrations are explicit. Run dry-run first, then apply copy-first migrations only after review.
