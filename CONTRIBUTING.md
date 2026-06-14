# Contributing

MetaSystem Kit is meant to stay reusable. Keep changes focused on the CLI, Skill, framework templates, architecture decisions, research notes, and synthetic examples.

## Public Boundary

Do not commit:

- real external-system snapshots, private references, customer/project data, generated releases, or runtime logs;
- `.env` files, API keys, tokens, credentials, or local absolute paths;
- one-off delivery reports, temporary validation output, caches, or Python bytecode;
- runtime contents under `.framework/backups/`, `.framework/events/`, or `.framework/.runtime/`.

Use sanitized examples when a workflow needs demonstration data.

## Checks

Run the repository check before committing:

```powershell
.\scripts\check.ps1
```

On a POSIX shell:

```bash
./scripts/check.sh
```

The check covers unit tests, Python compilation, and CLI smoke tests.

## Documentation Style

Public docs should explain the product and operating model. Avoid delivery-package notes, private conversation context, temporary acceptance criteria, or implementation diary language.
