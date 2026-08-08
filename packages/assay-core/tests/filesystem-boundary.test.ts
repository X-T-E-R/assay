import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { identitySafeRealpath } from "../src/filesystem-boundary.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("identity-safe filesystem boundaries", () => {
  it("accepts an ordinary path and rejects a symlink or junction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "assay-identity-boundary-"));
    roots.push(root);
    const target = path.join(root, "target");
    const redirect = path.join(root, "redirect");
    await mkdir(target);
    await symlink(target, redirect, process.platform === "win32" ? "junction" : "dir");

    await expect(identitySafeRealpath(target)).resolves.toEqual(
      expect.objectContaining({ resolved: path.resolve(target), canonical: expect.any(String) }),
    );
    await expect(identitySafeRealpath(redirect)).resolves.toBeNull();
  });
});
