import { FrameworkError, requireObjectSemantics as studySemantics } from "absorb-anything-core";
import { requireObjectSemantics as buildSemantics } from "own-work";

/** The merged topic table: the suite's own two, then study, then build. */
export const ASSAY_TOPICS = [
  "workspace",
  "project",
  "source",
  "analysis",
  "knowledge",
  "task",
  "roadmap",
  "spec",
  "system",
] as const;
export type AssayTopic = (typeof ASSAY_TOPICS)[number];

export const ASSAY_DETAIL_COMMAND = "assay explain <topic>";

const STUDY_TOPICS: readonly AssayTopic[] = ["source", "analysis", "knowledge"];
const BUILD_TOPICS: readonly AssayTopic[] = ["task", "roadmap", "spec", "system"];

export interface AssaySemantics {
  readonly topic: AssayTopic;
  readonly label: string;
  readonly purpose: string;
  readonly antiRule: string;
  readonly whyItExists: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly commonMisuses: readonly string[];
  readonly commands: readonly string[];
}

/**
 * `workspace` and `project` are the two topics both halves define, each from
 * its own view. The suite answers for both halves, so it writes them itself.
 */
const SUITE_SEMANTICS: readonly AssaySemantics[] = [
  {
    topic: "workspace",
    label: "Workspace",
    purpose: "one .assay envelope holding both halves: study evidence and build objects",
    antiRule: "one workspace holds both halves; do not open a second envelope beside it",
    whyItExists: [
      "Assay is the suite over absorb-anything and own-work, so sources, analyses, knowledge, tasks, roadmaps, specs, and systems share one envelope and one event ledger.",
    ],
    whenNotToUse: [
      "Use absorb alone when the work is only external material.",
      "Use ownwork alone when the work is only your own build objects.",
    ],
    commonMisuses: [
      "Creating a second envelope directory beside the active one.",
      "Renaming .assay to .absorb and expecting assay to keep owning the name.",
    ],
    commands: ["assay init [target]", "assay status", "assay check"],
  },
  {
    topic: "project",
    label: "Project",
    purpose: "the identity authority shared by study evidence and build objects here",
    antiRule: "project acceptance is neither a finished Task nor a closed Analysis",
    whyItExists: ["Both halves refer to one stable project identity."],
    whenNotToUse: [
      "Use a Task for one bounded outcome and an Analysis for one bounded interpretation.",
    ],
    commonMisuses: ["Reading one half's records as acceptance for the whole project."],
    commands: ["assay status", "assay check"],
  },
];

/**
 * Each half spells its examples with its own binary. Under the suite those same
 * commands are reached as `assay ...`, so the prefix follows the caller.
 */
function retargetCommand(command: string): string {
  return command.replace(/^(absorb|ownwork) /, "assay ");
}

function fromHalf(topic: AssayTopic, half: "study" | "build"): AssaySemantics {
  const entry = half === "study" ? studySemantics(topic) : buildSemantics(topic);
  return {
    topic,
    label: entry.label,
    purpose: entry.purpose,
    antiRule: entry.antiRule,
    whyItExists: entry.whyItExists,
    whenNotToUse: entry.whenNotToUse,
    commonMisuses: entry.commonMisuses,
    commands: entry.commands.map(retargetCommand),
  };
}

export function assayObjectSemantics(): readonly AssaySemantics[] {
  return ASSAY_TOPICS.map((topic) => {
    const owned = SUITE_SEMANTICS.find((entry) => entry.topic === topic);
    if (owned) return owned;
    if (STUDY_TOPICS.includes(topic)) return fromHalf(topic, "study");
    if (BUILD_TOPICS.includes(topic)) return fromHalf(topic, "build");
    throw new FrameworkError(`topic '${topic}' is in the table but routed to no half`);
  });
}

export function requireAssaySemantics(topic: string): AssaySemantics {
  const normalized = topic.trim().toLowerCase();
  const found = assayObjectSemantics().find((entry) => entry.topic === normalized);
  if (!found)
    throw new FrameworkError(
      `unknown topic '${topic}'; explain covers: ${ASSAY_TOPICS.join(", ")}`,
      { code: "NOT_FOUND" },
    );
  return found;
}

export interface AssayDigestEntry {
  readonly topic: AssayTopic;
  readonly label: string;
  readonly purpose: string;
  readonly antiRule: string;
}

export function assaySemanticDigest(): readonly AssayDigestEntry[] {
  return assayObjectSemantics().map(({ topic, label, purpose, antiRule }) => ({
    topic,
    label,
    purpose,
    antiRule,
  }));
}

/** The two halves write purposes as fragments and as sentences; normalize. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function assayDigestSentence(entry: AssayDigestEntry): string {
  return `${entry.label}: ${sentence(entry.purpose)} Rule: ${sentence(entry.antiRule)}`;
}
