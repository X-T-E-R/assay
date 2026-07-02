import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * External governance systems that assay should defer to for ADR/decision
 * recording, rather than maintaining its own parallel ADR subsystem (ADR-0005).
 * Some systems block ADR creation unless --force; common ADR directories warn
 * without blocking creation.
 */
export interface GovernanceDetection {
  readonly system: "trellis" | "superpowers" | "docs-adr" | "git" | "none";
  readonly path: string;
  readonly message: string;
  readonly action: "block" | "warn" | "none";
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    return false;
  }
}

/**
 * Detect external governance systems in a project root, in priority order.
 * Returns the first match, or { system: "none" } if none found.
 *
 * Detection order:
 * 1. trellis (.trellis/ directory) — full task/spec/governance system
 * 2. superpowers (.superpowers/ directory) — external workflow/governance
 *    system
 * 3. docs-adr (docs/adr/ directory) — common ADR convention; warn only
 * 4. git (.git/ directory) — baseline version control (informational only,
 *    does not block ADR creation since git alone is not a decision-recording
 *    system)
 */
export async function detectExternalGovernance(root: string): Promise<GovernanceDetection> {
  const trellisPath = path.join(root, ".trellis");
  if (await isDirectory(trellisPath)) {
    return {
      system: "trellis",
      path: ".trellis/",
      action: "block",
      message:
        "detected trellis (.trellis/). Decision records should go through trellis tasks/specs; Assay ADR is redundant. Use --force to create an Assay ADR anyway.",
    };
  }

  const superpowersPath = path.join(root, ".superpowers");
  if (await isDirectory(superpowersPath)) {
    return {
      system: "superpowers",
      path: ".superpowers/",
      action: "block",
      message:
        "detected superpowers governance (.superpowers/). Decision records should go through superpowers; Assay ADR is redundant. Use --force to create an Assay ADR anyway.",
    };
  }

  const docsAdrPath = path.join(root, "docs", "adr");
  if (await isDirectory(docsAdrPath)) {
    return {
      system: "docs-adr",
      path: "docs/adr/",
      action: "warn",
      message:
        "detected existing ADR directory (docs/adr/). Assay will create its ADR under knowledge/decisions; consider consolidating decision records.",
    };
  }

  return { system: "none", path: "", message: "", action: "none" };
}
