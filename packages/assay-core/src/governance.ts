import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * External governance systems that may already record decisions. Detection is
 * advisory: Assay still provides its own plain-file ADR tool when requested.
 */
export interface GovernanceDetection {
  readonly system: "trellis" | "superpowers" | "docs-adr" | "git" | "none";
  readonly path: string;
  readonly message: string;
  readonly action: "warn" | "none";
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
 * 1. trellis (.trellis/ directory) — full task/spec/governance system; warn
 * 2. superpowers (.superpowers/ directory) — external workflow/governance
 *    system; warn
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
      action: "warn",
      message:
        "detected trellis (.trellis/). It may already record decisions; Assay will still create the requested ADR in its own decisions folder.",
    };
  }

  const superpowersPath = path.join(root, ".superpowers");
  if (await isDirectory(superpowersPath)) {
    return {
      system: "superpowers",
      path: ".superpowers/",
      action: "warn",
      message:
        "detected superpowers governance (.superpowers/). It may already record decisions; Assay will still create the requested ADR in its own decisions folder.",
    };
  }

  const docsAdrPath = path.join(root, "docs", "adr");
  if (await isDirectory(docsAdrPath)) {
    return {
      system: "docs-adr",
      path: "docs/adr/",
      action: "warn",
      message:
        "detected existing ADR directory (docs/adr/). Assay will create its ADR in its own decisions folder; consider consolidating decision records.",
    };
  }

  return { system: "none", path: "", message: "", action: "none" };
}
