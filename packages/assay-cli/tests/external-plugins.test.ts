import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = process.cwd();
const cliPath = path.join(packageRoot, "dist", "cli.js");
const descriptorPath = path.join(packageRoot, "..", "assay-plugin-fixture", "assay-plugin.json");
const ponytailDescriptorPath = path.join(
  packageRoot,
  "..",
  "assay-plugin-ponytail",
  "assay-plugin.json",
);
const tempRoots: string[] = [];
let registryRoot = "";

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "assay-external-plugin-cli-"));
  tempRoots.push(root);
  return root;
}

async function runCli(args: readonly string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ASSAY_WORKSPACES_ROOT: registryRoot },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      return {
        exitCode: error.code,
        stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
        stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
      };
    }
    throw error;
  }
}

beforeEach(async () => {
  registryRoot = await tempDir();
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external plugin CLI", () => {
  it("runs the descriptor-only lifecycle and rejects a host/integrity mismatch", async () => {
    const root = path.join(await tempDir(), "workspace");
    const initialized = await runCli(["init", root, "--name", "ExternalPluginCli"]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);

    const registered = await runCli([
      "plugin",
      "register",
      descriptorPath,
      "--root",
      root,
      "--json",
    ]);
    expect(registered.exitCode, registered.stderr).toBe(0);
    const registeredJson = JSON.parse(registered.stdout);
    expect(registeredJson).toEqual(
      expect.objectContaining({
        alreadyRegistered: false,
        plugin: expect.objectContaining({
          id: "assay-fixture.readonly-command",
          descriptorVerification: "verified",
          hostInstallation: "unobserved",
          hostActivation: "unobserved",
          assayExecutes: false,
        }),
      }),
    );

    const listed = await runCli(["plugin", "list", "--root", root, "--json"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).plugins).toContainEqual(
      expect.objectContaining({
        id: "assay-fixture.readonly-command",
        assayExecutes: false,
      }),
    );

    const declarationCheck = await runCli(["plugin", "check", "--root", root, "--json"]);
    expect(declarationCheck.exitCode, declarationCheck.stderr).toBe(0);
    expect(JSON.parse(declarationCheck.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        rows: expect.arrayContaining([
          expect.objectContaining({ status: "warning", path: ".assay/external-plugins.json" }),
        ]),
      }),
    );

    const observation = {
      __schema: 1,
      plugin_id: registeredJson.plugin.id,
      descriptor_digest: registeredJson.plugin.descriptorDigest,
      payload_integrity: registeredJson.plugin.payload.integrity,
      host: registeredJson.plugin.targets[0].host,
      host_version: "9.4.0",
      granted_scopes: registeredJson.plugin.requestedScopes,
      granted_surfaces: registeredJson.plugin.requestedSurfaces,
      state_ownership: registeredJson.plugin.stateOwnership,
      installation: "installed",
      activation: "active",
      health: "healthy",
      observed_at: "2026-08-07T01:00:00.000Z",
    };
    const observationFile = path.join(await tempDir(), "observation.json");
    await writeFile(observationFile, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    const observed = await runCli(["plugin", "observe", observationFile, "--root", root, "--json"]);
    expect(observed.exitCode, observed.stderr).toBe(0);
    expect(JSON.parse(observed.stdout).plugin).toEqual(
      expect.objectContaining({
        observedHost: registeredJson.plugin.targets[0].host,
        observedHostVersion: "9.4.0",
        hostInstallation: "installed",
        hostActivation: "active",
        health: "healthy",
      }),
    );
    const observedList = await runCli(["plugin", "list", "--root", root]);
    expect(observedList.exitCode, observedList.stderr).toBe(0);
    expect(observedList.stdout).toContain(
      `observed host ${registeredJson.plugin.targets[0].host}@9.4.0`,
    );

    const mismatchFile = path.join(await tempDir(), "mismatch.json");
    await writeFile(
      mismatchFile,
      `${JSON.stringify({ ...observation, host: "wrong.host" }, null, 2)}\n`,
      "utf8",
    );
    const mismatch = await runCli(["plugin", "observe", mismatchFile, "--root", root, "--json"]);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stderr).toContain("target host mismatch");

    const disabled = await runCli([
      "plugin",
      "disable",
      registeredJson.plugin.id,
      "--root",
      root,
      "--json",
    ]);
    expect(disabled.exitCode, disabled.stderr).toBe(0);
    expect(JSON.parse(disabled.stdout)).toEqual(
      expect.objectContaining({
        changed: true,
        plugin: expect.objectContaining({ assayEnabled: false, assayExecutes: false }),
      }),
    );

    const enabled = await runCli([
      "plugin",
      "enable",
      registeredJson.plugin.id,
      "--root",
      root,
      "--json",
    ]);
    expect(enabled.exitCode, enabled.stderr).toBe(0);
    expect(JSON.parse(enabled.stdout)).toEqual(
      expect.objectContaining({
        changed: true,
        plugin: expect.objectContaining({ assayEnabled: true }),
      }),
    );

    const removed = await runCli([
      "plugin",
      "remove",
      registeredJson.plugin.id,
      "--root",
      root,
      "--json",
    ]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual(
      expect.objectContaining({ changed: true, hostStatePreserved: true }),
    );
    const after = await runCli(["plugin", "list", "--root", root, "--json"]);
    expect(JSON.parse(after.stdout).plugins).not.toContainEqual(
      expect.objectContaining({ id: registeredJson.plugin.id }),
    );
  });

  it("integrates fixture and Ponytail metadata through one generic non-executing path", async () => {
    const root = path.join(await tempDir(), "integration-workspace");
    const initialized = await runCli(["init", root, "--name", "ExternalSpiIntegration"]);
    expect(initialized.exitCode, initialized.stderr).toBe(0);

    const fixtureBytes = await readFile(descriptorPath);
    const ponytailBytes = await readFile(ponytailDescriptorPath);
    const fixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
    const ponytailHash = createHash("sha256").update(ponytailBytes).digest("hex");

    const fixtureRegistered = await runCli([
      "plugin",
      "register",
      descriptorPath,
      "--root",
      root,
      "--json",
    ]);
    const ponytailRegistered = await runCli([
      "plugin",
      "register",
      ponytailDescriptorPath,
      "--root",
      root,
      "--json",
    ]);
    expect(fixtureRegistered.exitCode, fixtureRegistered.stderr).toBe(0);
    expect(ponytailRegistered.exitCode, ponytailRegistered.stderr).toBe(0);
    const fixture = JSON.parse(fixtureRegistered.stdout).plugin;
    const ponytail = JSON.parse(ponytailRegistered.stdout).plugin;

    const listed = await runCli(["plugin", "list", "--root", root, "--json"]);
    const listedJson = JSON.parse(listed.stdout);
    for (const id of [fixture.id, ponytail.id]) {
      expect(listedJson.plugins).toContainEqual(
        expect.objectContaining({
          id,
          descriptorVerification: "verified",
          hostInstallation: "unobserved",
          hostActivation: "unobserved",
          health: "unverifiable",
          payload: expect.objectContaining({ ref: expect.any(String) }),
          assayExecutes: false,
        }),
      );
    }

    const checked = await runCli(["plugin", "check", "--root", root, "--json"]);
    expect(checked.exitCode, checked.stderr).toBe(0);
    const externalRows = JSON.parse(checked.stdout).rows.filter((row: { message?: string }) =>
      row.message?.includes("descriptor verified"),
    );
    expect(externalRows).toHaveLength(2);
    for (const row of externalRows) {
      expect(row.message).toMatch(/payload .* referenced/);
      expect(row.message).toContain("host installation unobserved");
      expect(row.message).toContain("health unverifiable");
      expect(row.message).toContain("Assay executes nothing");
    }

    const observation = {
      __schema: 1,
      plugin_id: fixture.id,
      descriptor_digest: fixture.descriptorDigest,
      payload_integrity: fixture.payload.integrity,
      host: fixture.targets[0].host,
      host_version: "9.4.0",
      granted_scopes: fixture.requestedScopes,
      granted_surfaces: fixture.requestedSurfaces,
      state_ownership: fixture.stateOwnership,
      installation: "installed",
      activation: "active",
      health: "healthy",
      observed_at: "2026-08-07T10:00:00.000Z",
    };
    const observationFile = path.join(await tempDir(), "fixture-integration-observation.json");
    await writeFile(observationFile, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    const observed = await runCli(["plugin", "observe", observationFile, "--root", root, "--json"]);
    expect(observed.exitCode, observed.stderr).toBe(0);
    expect(JSON.parse(observed.stdout).plugin).toEqual(
      expect.objectContaining({
        hostInstallation: "installed",
        hostActivation: "active",
        health: "healthy",
      }),
    );

    const mismatchFile = path.join(await tempDir(), "ponytail-integration-mismatch.json");
    await writeFile(
      mismatchFile,
      `${JSON.stringify(
        {
          ...observation,
          plugin_id: ponytail.id,
          descriptor_digest: ponytail.descriptorDigest,
          payload_integrity: ponytail.payload.integrity,
          host: "undeclared.host",
          granted_scopes: ponytail.requestedScopes,
          granted_surfaces: ponytail.requestedSurfaces,
          state_ownership: ponytail.stateOwnership,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const mismatch = await runCli(["plugin", "observe", mismatchFile, "--root", root, "--json"]);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stderr).toContain("target host mismatch");

    const disabled = await runCli(["plugin", "disable", ponytail.id, "--root", root, "--json"]);
    expect(JSON.parse(disabled.stdout)).toEqual(
      expect.objectContaining({
        changed: true,
        plugin: expect.objectContaining({ assayEnabled: false, assayExecutes: false }),
      }),
    );
    const disabledList = JSON.parse(
      (await runCli(["plugin", "list", "--root", root, "--json"])).stdout,
    );
    expect(disabledList.plugins).toContainEqual(
      expect.objectContaining({
        id: ponytail.id,
        assayEnabled: false,
        hostInstallation: "unobserved",
      }),
    );

    const enabled = await runCli(["plugin", "enable", ponytail.id, "--root", root, "--json"]);
    expect(JSON.parse(enabled.stdout).plugin.assayEnabled).toBe(true);
    for (const id of [fixture.id, ponytail.id]) {
      const removed = await runCli(["plugin", "remove", id, "--root", root, "--json"]);
      expect(JSON.parse(removed.stdout)).toEqual(
        expect.objectContaining({ changed: true, hostStatePreserved: true }),
      );
    }

    const after = JSON.parse((await runCli(["plugin", "list", "--root", root, "--json"])).stdout);
    expect(after.plugins).toEqual([]);
    expect(
      createHash("sha256")
        .update(await readFile(descriptorPath))
        .digest("hex"),
    ).toBe(fixtureHash);
    expect(
      createHash("sha256")
        .update(await readFile(ponytailDescriptorPath))
        .digest("hex"),
    ).toBe(ponytailHash);
  });
});
