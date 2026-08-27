import { type SemanticHintKey, semanticHints } from "assay-core";

/**
 * Point-of-use semantic reminders for the mutating commands whose misuse costs
 * the most.
 *
 * The wording lives in the assay-core semantics registry; this module only
 * decides where it lands. Human output gets one trailing line, JSON output gets
 * a `hints` array, and both are deterministic for the same command so a caller
 * diffing output does not see churn.
 */

export function hintedResult<T extends object>(
  value: T,
  key: SemanticHintKey,
): T & { readonly hints: readonly string[] } {
  return { ...value, hints: semanticHints(key) };
}

export function hintLines(key: SemanticHintKey): string[] {
  return semanticHints(key).map((hint) => `Hint: ${hint}`);
}

/** Append the reminder to already-formatted human output. */
export function withHintLines(formatted: string, key: SemanticHintKey): string {
  return [formatted, ...hintLines(key)].join("\n");
}
