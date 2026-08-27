import { describe, expect, it } from "vitest";

import {
  OBJECT_SEMANTICS,
  SEMANTIC_DIGEST_TOPICS,
  SEMANTIC_HINTS,
  SEMANTIC_MODELS,
  SEMANTIC_TOPICS,
  assayAgentsBlock,
  requireObjectSemantics,
  semanticDigest,
  semanticDigestSentence,
  semanticHints,
  withSemanticModel,
} from "../src/index.js";

describe("semantics registry", () => {
  it("covers every explain topic with complete content", () => {
    expect(OBJECT_SEMANTICS.map((entry) => entry.topic)).toEqual([...SEMANTIC_TOPICS]);
    for (const entry of OBJECT_SEMANTICS) {
      expect(entry.label.length, entry.topic).toBeGreaterThan(0);
      expect(entry.purpose.length, entry.topic).toBeGreaterThan(0);
      expect(entry.antiRule.length, entry.topic).toBeGreaterThan(0);
      expect(entry.whyItExists.length, entry.topic).toBeGreaterThan(0);
      expect(entry.whenNotToUse.length, entry.topic).toBeGreaterThan(0);
      expect(entry.commonMisuses.length, entry.topic).toBeGreaterThan(0);
      expect(entry.commands.length, entry.topic).toBeGreaterThan(0);
    }
  });

  it("digests the native objects and leaves the container to explain", () => {
    expect(semanticDigest().map((entry) => entry.topic)).toEqual([...SEMANTIC_DIGEST_TOPICS]);
    expect(SEMANTIC_DIGEST_TOPICS).not.toContain("workspace");
    for (const entry of semanticDigest()) {
      expect(semanticDigestSentence(entry), entry.topic).toContain("Most-broken rule:");
    }
  });

  it("resolves topics case-insensitively and names the valid set otherwise", () => {
    expect(requireObjectSemantics("  Task ").topic).toBe("task");
    expect(() => requireObjectSemantics("intent")).toThrow(
      /unknown topic 'intent'; explain covers: workspace, project, task/,
    );
  });

  it("supplies one hint per high-misuse command", () => {
    for (const key of Object.keys(SEMANTIC_HINTS) as (keyof typeof SEMANTIC_HINTS)[]) {
      const hints = semanticHints(key);
      expect(hints, key).toHaveLength(1);
      for (const hint of hints) {
        expect(hint.includes("\n"), key).toBe(false);
      }
    }
    expect(semanticHints("task create").join("")).toContain("a new attempt at the same outcome");
  });

  it("states the correct model as a second sentence on teaching errors", () => {
    expect(
      withSemanticModel("terminal task cannot change status: task-0001-a", "taskTerminal"),
    ).toBe(`terminal task cannot change status: task-0001-a. ${SEMANTIC_MODELS.taskTerminal}`);
  });

  it("is the single source the AGENTS managed block renders", () => {
    const block = assayAgentsBlock(null);
    expect(block).toContain("## Object semantics");
    expect(block).toContain("Run `assay prime` at the start of a session");
    expect(block).toContain("Run `assay explain <object>` before using an object type");
    for (const entry of semanticDigest()) {
      expect(block, entry.topic).toContain(semanticDigestSentence(entry));
    }
  });
});
