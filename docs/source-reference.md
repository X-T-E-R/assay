# Source references

One piece of external material, one home, reachable from every workspace that
needs it.

When a second workspace needs a Source that a first workspace already tracks,
`assay source add` would clone it again, and from that moment there are two
checkouts, two observation ledgers, and two answers to "what did upstream do
last month". A reference avoids that: the second workspace writes down where the
Source lives instead of copying it.

```text
assay source link <target-workspace> <target-source> [--alias <local-alias>]
assay source home <local-alias>
assay source unlink <local-alias>
```

## What a reference is on disk

`sources/<local-alias>/source.ref.yaml`, and nothing else in that directory:

```yaml
schema: assay.source-reference/v1
workspace: ../shared-research
source: qiskit
```

`workspace` is the target workspace root — relative to this workspace's root by
preference, absolute when that is what makes sense — and `source` is the alias
the Source has over there. That is the whole record. There is no URI, no commit,
no fingerprint, no branch, and no observation, because a second copy of any of
those would be a second authority on a Source that has exactly one.

The shell holds no `checkout/`, `content/`, `observations/`, or `captures/`
either. A directory holding both a pointer and material is two answers to where
the Source lives, so `assay check` reports it and every command on that alias
refuses rather than picking one.

## Reading through a reference

`source status`, `source log`, and `source diff` work on a referenced alias
exactly as they do on an owned one, and they always say which it is:

```text
$ assay source status
Sources
Root: C:\work\product
qiskit    checkout git    normal    20260828-519b5854d3fa 519b5854d3fa  ref -> ../shared-research#qiskit
```

`assay source home <alias>` answers the question directly, for an owned Source
as well as a referenced one:

```text
$ assay source home qiskit
Source home: qiskit
Relation: ref
Home workspace: C:\work\shared-research
Home alias: qiskit
Home path: C:\work\shared-research\sources\qiskit
Recorded: ../shared-research#qiskit
Brief: C:\work\shared-research\sources\qiskit\brief.md
```

The `Brief` line is the discovery path. A reference mounts none of the home's
analyses, gaps, or patterns — those belong to the workspace that wrote them —
so if the home has thinking worth reading, `brief.md` is where the home says so,
and `link` and `home` both name it. A home that keeps no brief is reported as
such rather than passed over in silence.

## Writing through a reference

`sync`, `capture`, `import`, and `switch` from a consumer workspace land in the
home. There is no confirmation gate, because the arrangement was the point; what
there is instead is a line before the work starts, naming where it will go:

```text
$ assay source sync qiskit
qiskit is referenced from ../shared-research#qiskit; writing through to the Source home: C:\work\shared-research\sources\qiskit
Source sync: qiskit
Relation: ref -> ../shared-research#qiskit
Home: C:\work\shared-research
...
```

The write runs under the **home** workspace's mutation coordination, not the
consumer's. Two workspaces syncing the same Source serialize against each other,
and a conversion in progress in the home fails the write closed rather than
racing it.

Deletion is the one asymmetry. `unlink` removes the local pointer and stops
there — it never recurses, never reads the home, and never locks it:

```text
$ assay source unlink qiskit
Unlinked source: sources/qiskit
Forgot reference: ../shared-research#qiskit
Home workspace: C:\work\shared-research (untouched)
```

Removing the Source itself is only possible in the workspace that owns it.
Pointing `unlink` at an owned Source is a teaching error, not a delete.

## One hop, always

`link` follows a chain of references at creation time and records the workspace
that actually holds `source.yaml`. Linking `product`'s reference to
`shared-research#qiskit` writes `shared-research`, not `product`, and says so:

```text
Notice: Flattened: the target was itself a reference; this shell records the workspace that owns 'qiskit'.
```

So resolution at runtime is exactly one hop. Nothing walks a graph, and no
command depends on a chain of intermediate workspaces still being present.

Linking a target that is already linked is a notice, not a failure — the
workspace is already in the state you asked for. Passing `--alias` explicitly is
how you ask for a second local name for the same home; that case reports the
existing link and creates the new name.

## When the home moves

A reference is a path, and a path can stop being true. Nothing scans the
neighbourhood for the Source and nothing rebinds automatically; the failure stays
local and stays legible.

```text
$ assay source status
Sources
Root: C:\work\product
qiskit    broken   ref -> ../shared-research#qiskit
          ! target workspace is not there: C:\work\shared-research
```

Commands on that alias fail with an error that names what could not be reached
and what to do about it. Every other object in the workspace — its Tasks, its
Analyses, its own Sources, its adoptions — keeps working, and `assay check`
reports the broken reference as a structure finding without repairing it. Fixing
it is `source link` again at the new path, or `source unlink` if the material is
no longer wanted.

## The clone registry

`~/.assay/clone-registry.json` is a rebuildable cache of where each origin has a
home:

```json
{
  "__schema": 1,
  "entries": [
    {
      "origin": "github.com/qiskit/qiskit",
      "workspace": "C:\\work\\shared-research",
      "alias": "qiskit",
      "last_seen": "2026-08-28T03:07:32.884Z"
    }
  ]
}
```

`source add`, `source link`, and `source sync` write to it as a side effect, and
a write that fails never affects the command. It buys three conveniences:

- `source add` of an origin that already has a home prints an advisory naming
  that home and suggesting `source link`, then adds anyway. It is a hint, not a
  gate; a second clone is sometimes what you want.
- `source link <target-source>` with the workspace argument omitted consults the
  registry. Exactly one verified home links directly; several are listed with
  their exact paths and the command stops, because choosing between two homes on
  your behalf is the one thing a hint must not do.
- A broken-reference error appends the registry's current location for that
  Source when one verifies — which is what makes a moved home a one-command fix.

Every read re-verifies that the workspace and the alias are still really there,
and drops entries that are not. Nothing in Assay depends on this file: delete it
and you lose the three hints above and no facts. It stores absolute machine-local
paths, which is why it stays out of any workspace and why reference shells prefer
relative paths instead. It records homes only — a consumer's pointer is not where
material lives, so it is never indexed.

## What a reference deliberately cannot do

- **No branch or revision override.** A reference cannot ask the home for a
  different branch than the home is on. Two workspaces needing two branches of
  one repository is two Sources, in whichever workspaces own them.
- **No `pin` field.** Identity pinning belongs to the observation ledger and to
  adoption records, both of which live in the home.
- **No neighbour scanning and no auto-rebind.** A broken reference is repaired by
  a command you run, not by a search Assay performs.
- **No mounting of the home's analyses.** The home's conclusions stay the home's.
  `brief.md` is the one file a reference points a reader toward.
