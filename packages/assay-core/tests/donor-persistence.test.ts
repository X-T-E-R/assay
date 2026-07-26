import { lstat, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import path from "node:path";
import { createTempDirectoryFixture, pathExists as exists } from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  addSource,
  checkFramework,
  decideDonorAdoption,
  getDonorHistory,
  initFramework,
  inspectAdoptionLock,
  inspectDonorAdoption,
  listDonorAdoptions,
  loadManifest,
  migrateLayout,
  recordDonorEvidence,
  registerDonorAdoption,
  registerSystem,
  releaseAdoptionLock,
  saveManifest,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-donor-persistence");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

interface DonorFixture {
  readonly root: string;
  readonly targetRoot: string;
  readonly observation: string;
}

async function createFixture(name: string): Promise<DonorFixture> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await initFramework({ target: root, name });

  const sourceRoot = path.join(await tempDirs.createTempDir(), "upstream");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "alpha.txt"), "alpha-v1\n", "utf8");
  const source = await addSource({
    root,
    source: sourceRoot,
    alias: "upstream",
    now: new Date("2026-07-25T08:00:00"),
  });

  const targetRoot = path.join(root, "systems", "product");
  await mkdir(path.join(targetRoot, "integrations"), { recursive: true });
  await writeFile(path.join(targetRoot, "integrations", "alpha.txt"), "target-alpha-v1\n", "utf8");
  await registerSystem(root, {
    name: "product",
    path: "systems/product",
    vcs: "none",
    primary: true,
  });

  return { root, targetRoot, observation: source.observation.observation_id };
}

function definition(fixture: DonorFixture, targetPath = "integrations/alpha.txt") {
  return {
    schema: "assay.donor-adoption/v1" as const,
    id: "upstream-product",
    source: { alias: "upstream", observation: fixture.observation },
    targets: [{ id: "product", system: "product", adapter: "local-system/v1" as const }],
    mappings: [
      {
        id: "alpha",
        kind: "source-code",
        mode: "adapt",
        source: { path: "src/alpha.txt", match: "exact" as const },
        target: { target_id: "product", path: targetPath, match: "exact" as const },
        evidence: [],
      },
    ],
    evidence: [],
  };
}

async function registeredFixture(name: string): Promise<DonorFixture> {
  const fixture = await createFixture(name);
  await registerDonorAdoption({ root: fixture.root, definition: definition(fixture) });
  return fixture;
}

/** Rewrite the manifest as a pre-layout-v4 workspace: no layout block. */
async function downgradeManifestToV3(root: string): Promise<void> {
  const manifest = await loadManifest(root);
  if (!manifest) throw new Error("manifest missing");
  manifest.layout_version = 3;
  Reflect.deleteProperty(manifest, "layout");
  await saveManifest(root, manifest);
}

const donorsDir = (root: string, ...segments: readonly string[]): string =>
  path.join(root, ".assay", "donors", ...segments);

const lockFile = (root: string, adoptionId: string): string => donorsDir(root, adoptionId, ".lock");

/**
 * Write a lock file as a crashed run would have left it. `ageMs` also moves the
 * file mtime, because that is what the grace window is measured against.
 */
async function writeAgedLock(
  root: string,
  options: {
    readonly pid: number;
    readonly bootOffsetSeconds?: number;
    readonly ageMs?: number;
  },
): Promise<string> {
  const ageMs = options.ageMs ?? 10 * 60_000;
  const file = lockFile(root, "upstream-product");
  await writeFile(
    file,
    `${JSON.stringify({
      pid: options.pid,
      host: hostname(),
      boot: Math.round((Date.now() - uptime() * 1000) / 1000) + (options.bootOffsetSeconds ?? 0),
      owner: "00000000-0000-0000-0000-000000000000",
      acquired_at: new Date(Date.now() - ageMs).toISOString(),
    })}\n`,
    "utf8",
  );
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    await utimes(file, past, past);
  }
  return file;
}

/**
 * Create a directory link at `linkPath` pointing at `target`, returning false
 * when the platform refuses (unprivileged Windows without developer mode). A
 * skipped link means the escape being tested cannot be constructed here.
 */
async function createDirectoryLink(target: string, linkPath: string): Promise<boolean> {
  for (const type of ["junction", "dir"] as const) {
    try {
      await symlink(target, linkPath, type);
      return (await lstat(linkPath)).isSymbolicLink() || (await exists(linkPath));
    } catch {
      // Try the next link type.
    }
  }
  return false;
}

describe("donor state does not drift from the rest of the workspace state", () => {
  it("writes donor records under .assay when a manifest read from .assay claims layout 3", async () => {
    const fixture = await createFixture("LegacyLayoutDonor");
    await downgradeManifestToV3(fixture.root);

    await registerDonorAdoption({ root: fixture.root, definition: definition(fixture) });

    expect(await exists(donorsDir(fixture.root, "upstream-product", "state.json"))).toBe(true);
    // `.framework/` is where a real v3 workspace kept state, but this manifest
    // was read from `.assay/`, so every other state consumer is using `.assay/`.
    expect(await exists(path.join(fixture.root, ".framework"))).toBe(false);
  });

  it("keeps donor records visible to list and check across migrate-layout", async () => {
    const fixture = await createFixture("LegacyLayoutMigration");
    await downgradeManifestToV3(fixture.root);
    await registerDonorAdoption({ root: fixture.root, definition: definition(fixture) });

    await migrateLayout({ root: fixture.root, apply: true, now: new Date("2026-07-26T09:00:00") });

    const listed = await listDonorAdoptions({ root: fixture.root });
    expect(listed.adoptions.map((entry) => entry.id)).toEqual(["upstream-product"]);
    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some(
        (row) =>
          row.path === ".assay/donors/upstream-product/state.json" &&
          row.status === "ok" &&
          row.message?.includes("donor state and committed records are valid"),
      ),
      JSON.stringify(check.rows, null, 2),
    ).toBe(true);
  });
});

describe("interrupted donor record writes stay recoverable", () => {
  it("reports a truncated inspection against its own file and leaves state.json valid", async () => {
    const fixture = await registeredFixture("TruncatedInspection");
    const inspected = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const inspectionPath = donorsDir(
      fixture.root,
      "upstream-product",
      "inspections",
      `${inspected.inspection.id}.json`,
    );
    // A process killed mid-write leaves a partial record behind.
    const full = await readFile(inspectionPath, "utf8");
    await writeFile(inspectionPath, full.slice(0, 40), "utf8");

    const check = await checkFramework({ root: fixture.root });
    const row = check.rows.find(
      (candidate) =>
        candidate.path ===
        `.assay/donors/upstream-product/inspections/${inspected.inspection.id}.json`,
    );
    expect(row, JSON.stringify(check.rows, null, 2)).toBeDefined();
    expect(row?.status).toBe("error");
    expect(row?.message).toContain("not valid JSON");
    // The state file is intact and must not be blamed for a damaged record.
    expect(
      check.rows.some(
        (candidate) =>
          candidate.path.endsWith("upstream-product/state.json") && candidate.status === "error",
      ),
    ).toBe(false);
  });

  it("re-running the same inspect after a truncated write succeeds", async () => {
    const fixture = await registeredFixture("RetryAfterTruncation");
    const now = new Date("2026-07-26T10:00:00");
    const first = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      now,
    });
    const inspectionPath = donorsDir(
      fixture.root,
      "upstream-product",
      "inspections",
      `${first.inspection.id}.json`,
    );
    const full = await readFile(inspectionPath, "utf8");
    await writeFile(inspectionPath, full.slice(0, 40), "utf8");

    // Inspection ids are content digests, so the retry lands on the same file.
    // It must replace the partial record instead of reporting a collision that
    // no `assay` command can clear.
    const retried = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      now,
    });
    expect(retried.inspection.id).toBe(first.inspection.id);
    expect(retried.created).toBe(true);
    expect(await readFile(inspectionPath, "utf8")).toBe(full);

    const check = await checkFramework({ root: fixture.root });
    expect(
      check.rows.some((row) => row.path.startsWith(".assay/donors/") && row.status === "error"),
      JSON.stringify(check.rows, null, 2),
    ).toBe(false);
  });

  it("reports a truncated evidence record against its own file", async () => {
    const fixture = await registeredFixture("TruncatedEvidence");
    const inspected = await inspectDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
    });
    const recorded = await recordDonorEvidence({
      root: fixture.root,
      adoptionId: "upstream-product",
      inspectionId: inspected.inspection.id,
      evidence: {
        schema: "assay.donor-evidence-input/v1",
        check_id: "supplemental-note",
        result: "passed",
      },
    });
    const evidencePath = path.join(fixture.root, recorded.path);
    await writeFile(evidencePath, (await readFile(evidencePath, "utf8")).slice(0, 30), "utf8");

    const check = await checkFramework({ root: fixture.root });
    const row = check.rows.find((candidate) => candidate.path === recorded.path);
    expect(row, JSON.stringify(check.rows, null, 2)).toBeDefined();
    expect(row?.status).toBe("error");
  });

  it("reports a truncated uncommitted decision instead of crashing donor history", async () => {
    const fixture = await registeredFixture("TruncatedDecision");
    const committed = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });
    // An interrupted `donor decide` leaves a decision file that state.json
    // never came to reference.
    const orphan = donorsDir(
      fixture.root,
      "upstream-product",
      "decisions",
      "decision-000000000000000000000000.json",
    );
    await writeFile(orphan, '{"schema":"assay.donor-decision/v1"', "utf8");

    // History used to throw on the unreadable file even though it is not part
    // of committed history.
    const history = await getDonorHistory({ root: fixture.root, adoptionId: "upstream-product" });
    expect(history.decisions.map((decision) => decision.id)).toEqual([committed.decision.id]);

    const check = await checkFramework({ root: fixture.root });
    const row = check.rows.find(
      (candidate) =>
        candidate.path ===
        ".assay/donors/upstream-product/decisions/decision-000000000000000000000000.json",
    );
    expect(row, JSON.stringify(check.rows, null, 2)).toBeDefined();
    expect(row?.status).toBe("error");
  });

  it("refuses to rewrite a record that committed history depends on", async () => {
    const fixture = await registeredFixture("CommittedRecordGuard");
    const committed = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "accept",
    });
    const inspectionPath = donorsDir(
      fixture.root,
      "upstream-product",
      "inspections",
      `${committed.decision.inspection_id}.json`,
    );
    const original = await readFile(inspectionPath, "utf8");
    await writeFile(inspectionPath, original.slice(0, 40), "utf8");

    const check = await checkFramework({ root: fixture.root });
    // A record an accepted decision points at is history: it must fail loudly
    // rather than be quietly skipped.
    expect(
      check.rows.some((row) => row.path.startsWith(".assay/donors/") && row.status === "error"),
      JSON.stringify(check.rows, null, 2),
    ).toBe(true);
  });
});

describe("a crashed donor run leaves a recoverable lock", () => {
  it("treats an empty lock file as abandoned once past the grace window", async () => {
    const fixture = await registeredFixture("EmptyLock");
    const file = lockFile(fixture.root, "upstream-product");
    // Crash between creating the lock file and writing its payload.
    await writeFile(file, "", "utf8");

    // Fresh: still respected, so a live acquisition mid-write is not stolen.
    expect((await inspectAdoptionLock(fixture.root, "upstream-product"))?.stale).toBe(false);
    await expect(
      decideDonorAdoption({
        root: fixture.root,
        adoptionId: "upstream-product",
        targetId: "product",
        outcome: "defer",
      }),
    ).rejects.toThrow(/donor adoption is busy/);

    // Ten minutes on, no acquisition is still in flight. A payload-less lock
    // must not hold the adoption for an hour.
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(file, past, past);
    const aged = await inspectAdoptionLock(fixture.root, "upstream-product");
    expect(aged?.reason).toContain("no usable owner record");
    expect(aged?.stale).toBe(true);

    const decided = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "defer",
    });
    expect(decided.decision.outcome).toBe("defer");
    expect(await exists(file)).toBe(false);
  });

  it("offers an explicit release for a lock that is not yet past the window", async () => {
    const fixture = await registeredFixture("ForcedRelease");
    await writeFile(lockFile(fixture.root, "upstream-product"), "", "utf8");

    const released = await releaseAdoptionLock(fixture.root, "upstream-product", { force: true });
    expect(released.released).toBe(true);
    const decided = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "defer",
    });
    expect(decided.decision.outcome).toBe("defer");
  });

  it("recovers from an aged lock file whose pid cannot be signalled", async () => {
    const fixture = await registeredFixture("UnsignallableLock");
    // pid 4 is the Windows System process: `process.kill(4, 0)` raises EPERM,
    // which the old lock reader took as proof of a live holder and never
    // reconsidered, because the payload parsed and the mtime path was skipped.
    let unsignallablePid: number | null = null;
    for (const candidate of [4, 1]) {
      try {
        process.kill(candidate, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          unsignallablePid = candidate;
          break;
        }
      }
    }
    // A platform where no pid raises EPERM cannot express this state.
    if (unsignallablePid === null) return;

    await writeAgedLock(fixture.root, { pid: unsignallablePid });
    const lock = await inspectAdoptionLock(fixture.root, "upstream-product");
    expect(lock?.reason).toContain("cannot be signalled");
    expect(lock?.stale).toBe(true);

    // The adoption unblocks itself rather than staying wedged forever.
    const decided = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "defer",
    });
    expect(decided.decision.outcome).toBe("defer");
  });

  it("does not trust a live pid recorded before the last reboot", async () => {
    const fixture = await registeredFixture("RecycledPidLock");
    // Our own pid is unambiguously alive, but the boot token says the lock
    // predates this boot, so the pid belongs to an unrelated process now.
    await writeAgedLock(fixture.root, { pid: process.pid, bootOffsetSeconds: -100_000 });

    const lock = await inspectAdoptionLock(fixture.root, "upstream-product");
    expect(lock?.stale).toBe(true);
    expect(lock?.reason).toContain("before the last reboot");
    const decided = await decideDonorAdoption({
      root: fixture.root,
      adoptionId: "upstream-product",
      targetId: "product",
      outcome: "defer",
    });
    expect(decided.decision.outcome).toBe("defer");
  });

  it("refuses an unforced release while the lock still looks live", async () => {
    const fixture = await registeredFixture("LiveLockRelease");
    await writeAgedLock(fixture.root, { pid: process.pid, ageMs: 0 });
    await expect(releaseAdoptionLock(fixture.root, "upstream-product")).rejects.toThrow(
      /donor adoption is busy/,
    );
    expect(await exists(lockFile(fixture.root, "upstream-product"))).toBe(true);
  });
});

describe("target locators cannot reach outside the registered system", () => {
  it("rejects a locator whose parent directory is a symbolic link", async () => {
    const fixture = await createFixture("SymlinkParent");
    const outside = path.join(await tempDirs.createTempDir(), "outside");
    await mkdir(path.join(outside, "src"), { recursive: true });
    await writeFile(path.join(outside, "src", "a.txt"), "outside-bytes\n", "utf8");

    const linkPath = path.join(fixture.targetRoot, "link");
    if (!(await createDirectoryLink(outside, linkPath))) return;

    // The locator resolves textually inside systems/product, but its parent is
    // a link out of the system: accepting it would let a baseline attest to
    // bytes the target system does not own.
    await expect(
      registerDonorAdoption({
        root: fixture.root,
        definition: definition(fixture, "link/src/a.txt"),
      }),
    ).rejects.toThrow(/escapes registered system through a symbolic link/);
  });

  it("rejects a missing locator under a symlinked parent", async () => {
    const fixture = await createFixture("SymlinkParentMissing");
    const outside = path.join(await tempDirs.createTempDir(), "outside");
    await mkdir(outside, { recursive: true });
    const linkPath = path.join(fixture.targetRoot, "link");
    if (!(await createDirectoryLink(outside, linkPath))) return;

    // A locator that does not exist yet is a legitimate draft state, but it
    // must not be the way past containment.
    await expect(
      registerDonorAdoption({
        root: fixture.root,
        definition: definition(fixture, "link/not-created-yet.txt"),
      }),
    ).rejects.toThrow(/escapes registered system through a symbolic link/);
  });

  it("still accepts an ordinary contained locator that does not exist yet", async () => {
    const fixture = await createFixture("DraftLocator");
    const registered = await registerDonorAdoption({
      root: fixture.root,
      definition: definition(fixture, "integrations/planned.txt"),
    });
    expect(registered.adoptionId).toBe("upstream-product");
  });
});
