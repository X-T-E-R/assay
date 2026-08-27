import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDirectoryFixture } from "assay-test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  collectUpstreamStatus,
  getFrameworkStatus,
  initFramework,
  registerSystem,
  syncSource,
  takeSourceAdoptionMaterial,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-upstream");
const GIT_INTEGRATION_TIMEOUT_MS = 45_000;

afterEach(async () => {
  await tempDirs.cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd, reject: false });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

async function identify(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "assay@example.test"]);
  await git(repo, ["config", "user.name", "Assay Test"]);
}

/** Git repository with one commit on `main`, usable as a living source. */
async function gitOrigin(name: string): Promise<string> {
  const repo = path.join(await tempDirs.createTempDir(), name);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await git(repo, ["init"]);
  await identify(repo);
  await writeFile(path.join(repo, "src", "alpha.txt"), "alpha-v1\n", "utf8");
  await writeFile(path.join(repo, "src", "beta.txt"), "beta-v1\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "-M", "main"]);
  return repo;
}

async function workspaceWithGitSource(
  name: string,
): Promise<{ readonly root: string; readonly origin: string; readonly checkout: string }> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name });
  const origin = await gitOrigin(`${name}-origin`);
  await addSource({ root, source: origin, alias: "upstream", branch: "main" });
  const checkout = path.join(root, "sources", "upstream", "checkout");
  await identify(checkout);
  return { root, origin, checkout };
}

describe("upstream drift in status", () => {
  it(
    "reports a checkout whose HEAD is past the recorded observation, without network",
    async () => {
      const { root, checkout } = await workspaceWithGitSource("UpstreamLocalDrift");
      await writeFile(path.join(checkout, "src", "alpha.txt"), "alpha-local\n", "utf8");
      await git(checkout, ["commit", "-am", "local commit"]);

      const upstream = await collectUpstreamStatus({ root });
      const source = upstream.sources[0];
      expect(upstream.fetched).toBe(false);
      expect(source?.signal).toBe("local-drift");
      expect(source?.localCommitsAhead).toBe(1);
      expect(source?.changedFiles).toBe(1);
      expect(source?.summary).toContain("1 commit past the recorded observation");
      expect(upstream.changedSources).toBe(1);
      // Local work is the reader's own; nothing upstream moved, so there is no
      // command to offer.
      expect(upstream.nextCommand).toBeNull();

      const status = await getFrameworkStatus({ root });
      expect(status.upstream?.sources[0]?.signal).toBe("local-drift");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "surfaces an uncommitted edit in a managed checkout",
    async () => {
      const { root, checkout } = await workspaceWithGitSource("UpstreamDirty");
      await writeFile(path.join(checkout, "src", "beta.txt"), "beta-edited\n", "utf8");

      const [source] = (await collectUpstreamStatus({ root })).sources;
      expect(source?.signal).toBe("local-modified");
      expect(source?.dirtyFiles).toBe(1);
      expect(source?.summary).toContain("local checkout modified (1 uncommitted file)");
      expect(source?.summary).toContain("the next sync records it as a local modification");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "reports an unchanged checkout as unchanged",
    async () => {
      const { root } = await workspaceWithGitSource("UpstreamClean");
      const [source] = (await collectUpstreamStatus({ root })).sources;
      expect(source?.signal).toBe("unchanged");
      expect(source?.summary).toBe("no change");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it("does not hash copied content, which has no upstream to be behind", async () => {
    const root = path.join(await tempDirs.createTempDir(), "UpstreamPlainDir");
    await initFramework({ target: root, name: "UpstreamPlainDir" });
    const source = path.join(await tempDirs.createTempDir(), "plain");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# Plain\n", "utf8");
    await addSource({ root, source, alias: "plain" });
    await writeFile(
      path.join(root, "sources", "plain", "content", "README.md"),
      "# Plain edited\n",
      "utf8",
    );

    const [entry] = (await collectUpstreamStatus({ root })).sources;
    expect(entry?.signal).toBe("not-checked");
    expect(entry?.summary).toBe("not checked (copied content has no upstream)");
  });

  it(
    "annotates a source whose remote cannot be reached and keeps reporting the rest",
    async () => {
      const { root, origin } = await workspaceWithGitSource("UpstreamOffline");
      await rm(origin, { recursive: true, force: true });

      const upstream = await collectUpstreamStatus({ root, fetch: true });
      const source = upstream.sources[0];
      expect(upstream.fetched).toBe(true);
      expect(source?.upstreamCommits).toBeNull();
      expect(source?.upstreamNote).toContain("git fetch failed");
      expect(source?.summary).toContain("upstream not checked this run");
      // A failed fetch is an annotation, not a state change.
      expect(source?.signal).toBe("unchanged");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "counts commits the remote has that the recorded observation does not",
    async () => {
      const { root, origin, checkout } = await workspaceWithGitSource("UpstreamAhead");
      await writeFile(path.join(origin, "src", "alpha.txt"), "alpha-v2\n", "utf8");
      await git(origin, ["commit", "-am", "upstream change"]);

      const upstream = await collectUpstreamStatus({ root, fetch: true });
      const source = upstream.sources[0];
      expect(source?.signal).toBe("upstream-ahead");
      expect(source?.upstreamCommits).toBe(1);
      expect(source?.summary).toContain("1 new upstream commit");
      expect(upstream.nextCommand).toBe("assay source sync upstream");
      // The remote tip must resolve to a real commit: a count that fell back to
      // "the tips differ" would report the same number while listing no paths.
      expect(source?.changedFiles).toBe(1);

      // Local work in the checkout is reported first but does not withhold the
      // command: `sync` fast-forwards and records the local edit as an advisory.
      await writeFile(path.join(checkout, "src", "beta.txt"), "beta-edited\n", "utf8");
      const alsoLocal = await collectUpstreamStatus({ root, fetch: true });
      expect(alsoLocal.sources[0]?.signal).toBe("local-modified");
      expect(alsoLocal.sources[0]?.upstreamCommits).toBe(1);
      expect(alsoLocal.nextCommand).toBe("assay source sync upstream");
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );

  it(
    "counts the Source adoption mappings an upstream change reaches",
    async () => {
      const { root, origin, checkout } = await workspaceWithGitSource("UpstreamImpact");
      const system = path.join(root, "systems", "product");
      await mkdir(path.join(system, "integrations"), { recursive: true });
      await writeFile(path.join(system, "integrations", "alpha.txt"), "target-v1\n", "utf8");
      await registerSystem(root, {
        name: "product",
        path: "systems/product",
        vcs: "none",
        primary: true,
      });
      await takeSourceAdoptionMaterial({
        root,
        sourceAlias: "upstream",
        sourcePath: "src/alpha.txt",
        targetSystem: "product",
        targetPath: "integrations/alpha.txt",
      });

      // A change outside every declared locator reaches nothing.
      await writeFile(path.join(origin, "src", "beta.txt"), "beta-v2\n", "utf8");
      await git(origin, ["commit", "-am", "unmapped change"]);
      const unmapped = (await collectUpstreamStatus({ root, fetch: true })).sources[0];
      expect(unmapped?.upstreamCommits).toBe(1);
      expect(unmapped?.changedFiles).toBe(1);
      expect(unmapped?.impact).toEqual({ mappings: 0, adoptions: [] });

      // The same upstream change, this time inside the mapped path.
      await writeFile(path.join(origin, "src", "alpha.txt"), "alpha-v2\n", "utf8");
      await git(origin, ["commit", "-am", "mapped upstream change"]);
      const mappedUpstream = (await collectUpstreamStatus({ root, fetch: true })).sources[0];
      expect(mappedUpstream?.impact?.mappings).toBe(1);
      expect(mappedUpstream?.impact?.adoptions).toEqual(["upstream-product-src-alpha-txt"]);

      // A change inside the mapped path does.
      await writeFile(path.join(checkout, "src", "alpha.txt"), "alpha-local\n", "utf8");
      await git(checkout, ["commit", "-am", "local change to mapped file"]);
      const mapped = (await collectUpstreamStatus({ root })).sources[0];
      expect(mapped?.impact?.mappings).toBe(1);
      expect(mapped?.impact?.adoptions).toEqual(["upstream-product-src-alpha-txt"]);
    },
    GIT_INTEGRATION_TIMEOUT_MS,
  );
});
