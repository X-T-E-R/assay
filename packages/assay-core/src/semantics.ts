import { FrameworkError } from "./errors.js";

/**
 * One authority for what each native Assay object is for.
 *
 * `assay prime`, `assay explain`, the point-of-use hints on mutating commands,
 * the teaching sentences in high-misuse errors, and the AGENTS.md managed block
 * all read from here. The same sentence maintained in docs, CLI strings, and
 * generated instructions drifts within one release, and the CLI copy is the one
 * that actually reaches a model mid-session.
 */

export const SEMANTIC_TOPICS = [
  "workspace",
  "project",
  "task",
  "roadmap",
  "spec",
  "source",
  "adoption",
  "analysis",
  "knowledge",
  "system",
] as const;

export type SemanticTopic = (typeof SEMANTIC_TOPICS)[number];

export interface ObjectSemantics {
  readonly topic: SemanticTopic;
  /** Display name used in the digest and as the `explain` heading. */
  readonly label: string;
  /** What the object is for, as a fragment completing "<label> is ...". */
  readonly purpose: string;
  /** The one rule that gets broken most often, as a fragment. */
  readonly antiRule: string;
  readonly whyItExists: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly commonMisuses: readonly string[];
  /** Representative commands, not the full flag list. That stays in `--help`. */
  readonly commands: readonly string[];
}

const SEMANTICS: readonly ObjectSemantics[] = [
  {
    topic: "workspace",
    label: "Workspace",
    purpose: "the control surface Assay owns: `.assay/` state plus the zones work goes into",
    antiRule: "the workspace root is not the thing being built; systems are",
    whyItExists: [
      "One place holds the state Assay owns and one directory map covers everything else, so placement is a lookup rather than a guess.",
      "Standalone workspaces keep work at the root; an overlay resolves the same areas under `.assay/` so a product repository stays untouched.",
      "`assay status` prints every zone with its file count and what belongs there. Read it before placing a file.",
    ],
    whenNotToUse: [
      "Not inside an existing workspace: Assay walks up and finds the enclosing authority, so a second one only splits state.",
      "Not as a scratch directory for a system's own source, which belongs in that system's registered directory.",
    ],
    commonMisuses: [
      "Treating the repository root as the system being built, and registering no system at all.",
      "Hand-editing `.assay/manifest.json` or `.assay/systems-registry.json` instead of running the command that owns it.",
      "Inferring what a directory is for from its name instead of reading the zones.",
    ],
    commands: ["assay status", "assay check", "assay init [target-dir]", "assay update --dry-run"],
  },
  {
    topic: "project",
    label: "Project",
    purpose: "the one identity and acceptance authority for this workspace",
    antiRule: "project acceptance never moves into a Task, a Roadmap item, or a commit",
    whyItExists: [
      "A workspace needs one answer to what this project is and what counts as accepted for it.",
      "`project/project.yaml` is the id and name authority; the prose beside it stays reader-owned.",
    ],
    whenNotToUse: [
      "Not for one outcome's scope or success checks, which belong in that Task's `prd.md`.",
      "Not for a constraint that later work must cite, which belongs in a Spec.",
    ],
    commonMisuses: [
      "Recording project acceptance inside a Task and reading `task finish` as sign-off.",
      "Renaming the project by editing `project.yaml` directly.",
    ],
    commands: ["assay status", "assay check"],
  },
  {
    topic: "task",
    label: "Task",
    purpose:
      "one bounded outcome kept identifiable across sessions, agents, compaction, and repeated attempts",
    antiRule: "a new attempt at the same outcome is not a new Task",
    whyItExists: [
      "Work outlives the session that started it. A Task gives one outcome a stable id another reader, agent, or tool can resume from.",
      "`prd.md` carries the contract: the bounded goal, scope, and task-level success checks. `task.json` is the machine envelope beside it.",
      "`handoff.md` is one replaceable checkpoint written at a real continuation boundary, not a running log.",
    ],
    whenNotToUse: [
      "Not when the work finishes inside the current exchange and nothing needs to resume it.",
      "Not as a permission token, an acceptance decision, an agent job, or a roadmap entry.",
      "Not for a second attempt, a change of owner, or partial progress on the same outcome. Keep the Task that owns it.",
    ],
    commonMisuses: [
      "Creating a second Task to retry the first one's outcome, which splits the history the stable id existed to hold.",
      "Trying to reopen a terminal Task instead of creating a successor and recording `continues` or `supersedes`.",
      "Hand-editing `task.json`; edit `prd.md` directly and let `assay task` write envelope fields.",
      "Reading `the only active Task` as the current Task. Current is an explicit id or an exact context binding, never a count.",
    ],
    commands: [
      "assay task create --title <text>",
      "assay task list",
      "assay task checkpoint <id> --from <handoff.md>",
      "assay task finish <id>",
      "assay task relations <id> --relation continues:<id>",
    ],
  },
  {
    topic: "roadmap",
    label: "Roadmap",
    purpose: "an intended Project outcome, with how firmly and how soon the Project wants it",
    antiRule: "an item is an outcome, not a plan of work; Tasks are how it gets there",
    whyItExists: [
      "Direction needs somewhere to live that is not the task list, or the task list becomes the plan by accident.",
      "State (`candidate`, `committed`, `realized`, `retired`) and horizon (`now`, `next`, `later`, `unscheduled`) move independently.",
      "`link-task` is the only canonical Roadmap-Task link, and it writes no Task back-reference.",
    ],
    whenNotToUse: [
      "Not for the bounded work itself, which is a Task.",
      "Not for normative constraints or acceptance contracts, which are Specs.",
    ],
    commonMisuses: [
      "Expecting `task finish` to realize a linked item, or `roadmap realize` to finish its Tasks. Lifecycle never propagates through the link.",
      "Filing each step of a plan as its own item until the roadmap is a backlog.",
    ],
    commands: [
      "assay roadmap create --title <text>",
      "assay roadmap update <id> --state committed",
      "assay roadmap link-task <id> --task <task-id>",
      "assay roadmap list",
    ],
  },
  {
    topic: "spec",
    label: "Spec",
    purpose:
      "the current normative constraint, addressable after the work that produced it is gone",
    antiRule: "activation validates structure; it is not approval or Project acceptance",
    whyItExists: [
      "A decision worth citing later needs an address that does not move when the Task that found it is archived.",
      "`spec promote` copies a clean body forward and records exactly which Analysis or Task file it came from.",
      "Roadmap and Spec are separate authorities: realizing or retiring an item never changes a Spec.",
    ],
    whenNotToUse: [
      "Not while the decision is still being worked out. That stays in the Analysis or the Task.",
      "Not as a document dump. A Spec states a constraint, not the discussion that produced it.",
    ],
    commonMisuses: [
      "Promoting a Task file verbatim instead of writing the constraint it implies.",
      "Expecting promotion to finish, archive, or back-reference the Task it came from.",
    ],
    commands: [
      "assay spec create --title <text> --scope project --strength <strength>",
      "assay spec promote --from-task <id> --task-file <file> --body <clean-body>",
      "assay spec list",
    ],
  },
  {
    topic: "source",
    label: "Source",
    purpose: "external material kept where its origin and its changes stay readable",
    antiRule: "record what this decision needs, not everything recordable",
    whyItExists: [
      "Understanding an external system means reading its material over time, so a Source keeps the bytes and an append-only observation ledger beside them.",
      "A Git repository or URL is checkout-backed: `source sync` moves it and the commit is its identity, for free. A plain directory or archive is copied in once and stays put.",
      "`assay status` names the sources whose upstream moved and what that reaches. Sync those, rather than sweeping all of them on a schedule.",
      "Evidence is pinned in tiers: alias and date by default, identity (commit, or a computed content hash) when a decision needs to cite it, an explicit `source capture` when the bytes themselves have to survive.",
    ],
    whenNotToUse: [
      "Not for this project's own code, which belongs in a registered system directory.",
      "Not as a dependency manager or a vendoring mechanism.",
    ],
    commonMisuses: [
      "Running `source sync` as a routine sweep instead of when `status` reports upstream movement.",
      "Asking for a content hash on every look. The default record is alias and date; deeper pins are for decisions that cite them.",
      "Treating the copy as adopted. Adoption is a recorded mapping into a system, not the act of copying.",
      "Browsing `.assay/` by hand instead of `source status`, `source log`, and `source diff`.",
    ],
    commands: [
      "assay source add <repo-or-dir> [alias]",
      "assay source status",
      "assay source log <alias>",
      "assay source diff <alias>",
      "assay source sync [alias]",
      "assay source capture <alias>",
    ],
  },
  {
    topic: "adoption",
    label: "Source adoption",
    purpose:
      "a mapping from source material to where it landed in a system, so a later upstream change can find it",
    antiRule: "it is a traceability record, not an approval workflow",
    whyItExists: [
      "Months later the question is which of our files came from upstream and whether upstream has moved since. A mapping answers that without reading prose.",
      "`assay status` reports how many mappings an upstream change reaches, which is the signal worth acting on.",
      "Taking material pins the source identity it came from: the commit for a Git source, a computed content hash for anything else.",
      "One record is one mapping. An intent that moved three paths is three records, and `--mode adapt|copy` says whether what landed was reworked or carried over verbatim.",
    ],
    whenNotToUse: [
      "Not for material that was only read. Record what actually landed in a system.",
      "Not as a gate on the target project's edits, tests, commits, or releases. Those stay target-side.",
    ],
    commonMisuses: [
      "Looking for an approval step. The decision lives in `analysis close --exit` and in the adoption note; the record only says where material landed.",
      "Expecting Assay to edit, merge, or restore target files. It records the relationship; the target project acts.",
      "Removing a mapping to undo an edit. `remove` forgets the record and leaves the target exactly as it is.",
    ],
    commands: [
      "assay source adoption take <alias>:<path> --into <system>:<path>",
      "assay source adoption list",
      "assay source adoption show <adoption>",
      "assay source adoption remove <adoption>",
    ],
  },
  {
    topic: "analysis",
    label: "Analysis",
    purpose: "the working surface where a Source is read and a decision is reached",
    antiRule: "an Analysis is finished when it reaches an exit, not when the file exists",
    whyItExists: [
      "A decision needs somewhere to be worked out before it becomes a Spec or a Knowledge entry.",
      "`analysis close --exit adopt|reject|experiment` records the decision. Assay trusts the explicit exit instead of grading the prose.",
      "An `adopt` or `reject` is what makes a pin worth having: close suggests pinning the source identity it rested on. Browsing needs no pin at all.",
    ],
    whenNotToUse: [
      "Not for something already decided and reusable. Promote that into `knowledge/`.",
      "Not as a long-lived notebook. Close it when the decision is made.",
    ],
    commonMisuses: [
      "Leaving drafts open with an empty `## Key observations` and reporting the evidence loop as complete.",
      "Expecting `analysis close` to change the Source. It changes only the Analysis.",
      "Reading the pin suggestion on close as a requirement. It is a suggestion; a light look stays unpinned.",
    ],
    commands: [
      'assay analysis new "<title>" --for-source <alias>',
      "assay analysis close <path> --exit adopt|reject|experiment",
    ],
  },
  {
    topic: "knowledge",
    label: "Knowledge",
    purpose: "what survived a decision and is worth reusing",
    antiRule: "`knowledge/` is not an inbox; work in progress belongs in an Analysis",
    whyItExists: [
      "Findings that outlive the work that produced them need a home that is not a task folder.",
      "`knowledge add --from-analysis` keeps the link back to where the decision was made.",
    ],
    whenNotToUse: [
      "Not for raw notes, captures, or anything not yet decided about.",
      "Not for a constraint the project must obey, which is a Spec.",
    ],
    commonMisuses: [
      "Dropping unreviewed material in because `knowledge/` is a convenient folder.",
      "Creating the entry and never writing its `## Summary`.",
    ],
    commands: ['assay knowledge add pattern "<title>" --from-analysis <path>', "assay status"],
  },
  {
    topic: "system",
    label: "System registry",
    purpose:
      "which directories in this workspace are systems being built, and which one is primary",
    antiRule: "exactly one system is primary, and the workspace root is not a system",
    whyItExists: [
      "Source adoptions, status, and checks address systems by their registered selector, so the selector has to exist first.",
      "The registry is `.assay/systems-registry.json` and only commands write it. A `system.yaml` file is ordinary user content.",
    ],
    whenNotToUse: [
      "Not for external material being studied, which is a Source.",
      "Not for the system's own release identity or package versioning.",
    ],
    commonMisuses: [
      "Re-running `system register` to correct metadata. Duplicate registration is rejected on purpose; use `system update`.",
      "Hand-editing the registry, or expecting `system archive` to move files. Archive is a logical registry transition.",
    ],
    commands: [
      "assay system register <path> [--primary]",
      "assay system update <selector>",
      "assay system promote <selector>",
      "assay system list",
    ],
  },
];

export const OBJECT_SEMANTICS = SEMANTICS;

/**
 * Objects the `assay prime` digest states, in reading order. `workspace` is the
 * container the others live in rather than a native object, so it stays an
 * `explain` topic instead of taking a digest line.
 */
export const SEMANTIC_DIGEST_TOPICS: readonly SemanticTopic[] = [
  "project",
  "task",
  "roadmap",
  "spec",
  "source",
  "adoption",
  "analysis",
  "knowledge",
  "system",
];

export interface SemanticDigestEntry {
  readonly topic: SemanticTopic;
  readonly label: string;
  readonly purpose: string;
  readonly antiRule: string;
}

export function isSemanticTopic(value: string): value is SemanticTopic {
  return (SEMANTIC_TOPICS as readonly string[]).includes(value);
}

export function objectSemantics(topic: SemanticTopic): ObjectSemantics {
  const entry = SEMANTICS.find((candidate) => candidate.topic === topic);
  if (!entry) {
    throw new FrameworkError(`no semantics recorded for topic: ${topic}`);
  }
  return entry;
}

/** Resolve a caller-supplied topic, naming the valid set when it is unknown. */
export function requireObjectSemantics(topic: string): ObjectSemantics {
  const normalized = topic.trim().toLowerCase();
  if (!isSemanticTopic(normalized)) {
    throw new FrameworkError(
      `unknown topic '${topic}'; explain covers: ${SEMANTIC_TOPICS.join(", ")}`,
      { code: "NOT_FOUND" },
    );
  }
  return objectSemantics(normalized);
}

/** The digest every orientation channel renders, structured rather than formatted. */
export function semanticDigest(): readonly SemanticDigestEntry[] {
  return SEMANTIC_DIGEST_TOPICS.map((topic) => {
    const entry = objectSemantics(topic);
    return {
      topic: entry.topic,
      label: entry.label,
      purpose: entry.purpose,
      antiRule: entry.antiRule,
    };
  });
}

/** One digest line: what the object is for, then the rule most often broken. */
export function semanticDigestSentence(entry: SemanticDigestEntry): string {
  return `${entry.label} is ${entry.purpose}. Most-broken rule: ${entry.antiRule}.`;
}

/** Pointer every orientation channel ends with. */
export const SEMANTIC_DETAIL_COMMAND = "assay explain <topic>";

/**
 * Mutating commands whose misuse costs the most, keyed by the command path a
 * reader would type. One line each, appended at the point of use rather than
 * left in documentation the caller already skipped.
 */
export const SEMANTIC_HINTS = {
  "task create":
    "One durable outcome is one Task; a new attempt at the same outcome is not a new Task.",
  "task finish":
    "finish marks the outcome done; it does not archive the Task, accept it for the Project, or realize a Roadmap item.",
  "knowledge add":
    "Knowledge holds what survived a decision; work in progress stays in an Analysis.",
  "source add":
    "A Git source is checkout-backed and syncs; anything else is copied in once. Record what the decision needs, not everything recordable.",
  "source capture":
    "A capture is the explicit byte-level tier: reach for it when the bytes have to survive, not on every look.",
  "analysis new": "An Analysis is finished when it reaches an exit, not when the file exists.",
  "source adoption take":
    "A mapping records where material landed so a later upstream change can find it; it is not an approval.",
  "spec promote":
    "A Spec states the current constraint; promotion does not finish, archive, or back-reference its source Task.",
} as const;

export type SemanticHintKey = keyof typeof SEMANTIC_HINTS;

/**
 * Hints as the array a command emits. Always one entry today; the array shape
 * keeps `hints` in JSON output stable if a command ever earns a second one.
 */
export function semanticHints(key: SemanticHintKey): readonly string[] {
  return [SEMANTIC_HINTS[key]];
}

/**
 * Correct-model sentences for the misuse paths that produce an error. The error
 * says what failed; these say what the model actually is, so the next attempt
 * is a different action rather than the same one with more force.
 */
export const SEMANTIC_MODELS = {
  taskTerminal:
    "Terminal Tasks stay terminal: create a successor Task and record `continues` or `supersedes`.",
  taskArchived:
    "An archived Task is a record, not a workspace: create a successor Task when the outcome continues.",
  taskNotTerminal:
    "Archive follows a terminal status: run `assay task finish`, or set cancelled or superseded first.",
  taskEnvelope:
    "task.json is Assay's envelope: edit `prd.md` directly and let `assay task` write envelope fields.",
  taskContextBinding:
    "One context resolves to one Task: pass `--rebind` to move it rather than creating a second Task for the same outcome.",
  taskDuplicateStorage:
    "One Task id lives in one place: keep either the live or the archived copy, not both.",
  systemAlreadyRegistered:
    "A registered system keeps its record: correct it with `assay system update <selector>`.",
  sourceNotCheckoutBacked:
    "Only a Git-backed Source has a checkout to move: copied content is replaced with `assay source import <alias> <dir>`, or preserved as it stands with `assay source capture <alias>`.",
  sourceCopyContentOnly:
    "Import replaces copied content: a checkout follows its upstream instead, through `assay source sync` or `assay source switch`.",
  sourceCaptureMissing:
    "A capture is a byte-level record: its manifest and its bytes stay together, so a missing half is repaired by taking a new capture.",
} as const;

export type SemanticModelKey = keyof typeof SEMANTIC_MODELS;

/**
 * What to say about pinning when a decision closes on `adopt` or `reject`.
 *
 * Those are the exits that leave a rationale someone will re-read, so tier 1 —
 * the identity the decision rested on — is the tier worth having. For a Git
 * source it is already recorded and free, so the line confirms it rather than
 * asking for anything. For copied content it names the two ways to get one and
 * says outright that neither is required: a light look stays unpinned by design,
 * and nothing refuses to close because nothing was pinned.
 */
export function evidencePinSuggestion(input: {
  readonly alias: string;
  readonly commit: string | null;
}): string {
  if (input.commit) {
    return `Pin: this rests on \`${input.alias}\` at ${input.commit.slice(0, 12)}, which is identity enough to re-read the decision later. A capture is for bytes that have to survive.`;
  }
  return `Pin: \`${input.alias}\` is copied content with no commit to cite. \`assay source adoption take\` records a content hash for what landed, and \`assay source capture ${input.alias}\` keeps the bytes. Neither is required.`;
}

/** State what failed, then what the model actually is, as two sentences. */
export function withSemanticModel(message: string, key: SemanticModelKey): string {
  return `${message}. ${SEMANTIC_MODELS[key]}`;
}
