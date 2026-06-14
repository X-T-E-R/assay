
# Architecture

`MetaSystem` is an external-system-learning framework.

## Core loop

```text
references → analyses → systems/metasystem-core → iterations → knowledge
```

## Boundaries

- `references/`: external evidence, read-only by default.
- `analyses/`: conversion from evidence to local decisions.
- `systems/`: our active implementation.
- `iterations/`: controlled changes to our implementation.
- `knowledge/`: accepted reusable knowledge.
- `.framework/`: runtime metadata, not content knowledge.
