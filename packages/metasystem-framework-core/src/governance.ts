import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * External governance systems that metasystem should defer to for ADR/decision
 * recording, rather than maintaining its own parallel ADR subsystem (ADR-0005).
 * When one of these is detected, `adr new` warns and defers unless --force.
 */
export interface GovernanceDetection {
  readonly system: "trellis" | "docs-adr" | "git" | "none";
  readonly path: string;
  readonly message: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
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
 * 2. docs-adr (docs/adr/ directory) — common ADR convention
 * 3. git (.git/ directory) — baseline version control (informational only,
 *    does not block ADR creation since git alone is not a decision-recording
 *    system)
 */
export async function detectExternalGovernance(root: string): Promise<GovernanceDetection> {
  const trellisPath = path.join(root, ".trellis");
  if (await exists(trellisPath)) {
    return {
      system: "trellis",
      path: ".trellis/",
      message:
        "detected trellis (.trellis/). Decision records should go through trellis tasks/specs; metasystem ADR is redundant. Use --force to create a metasystem ADR anyway.",
    };
  }

  const docsAdrPath = path.join(root, "docs", "adr");
  if (await exists(docsAdrPath)) {
    return {
      system: "docs-adr",
      path: "docs/adr/",
      message:
        "detected existing ADR directory (docs/adr/). Continue using it for decisions; metasystem ADR would duplicate. Use --force to create a metasystem ADR anyway.",
    };
  }

  return { system: "none", path: "", message: "" };
}
