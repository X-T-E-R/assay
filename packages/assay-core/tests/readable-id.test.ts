import { describe, expect, it } from "vitest";

import {
  allocateReadableId,
  isReadableId,
  projectReadableId,
  readableIdSlug,
} from "../src/index.js";

describe("readable stable ids", () => {
  it("normalizes bounded safe slugs and uses deterministic empty fallbacks", () => {
    expect(readableIdSlug("  Café & SHIP  ")).toBe("cafe-ship");
    expect(readableIdSlug("中文")).toBe("");
    expect(projectReadableId("中文")).toBe("project-main");
  });

  it("extends sequence width and scans case-insensitively", () => {
    expect(allocateReadableId("task", "More", ["task-9999-old"])).toBe("task-10000-more");
    expect(allocateReadableId("roadmap", "", ["ROADMAP-10000-OLD"])).toBe("roadmap-10001");
  });

  it("rejects UUIDs and uppercase native ids", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    expect(isReadableId("project", uuid)).toBe(false);
    expect(isReadableId("task", uuid)).toBe(false);
    expect(isReadableId("roadmap", uuid)).toBe(false);
    expect(isReadableId("task", "task-0001-safe")).toBe(true);
    expect(isReadableId("task", "TASK-0001-safe")).toBe(false);
  });
});
