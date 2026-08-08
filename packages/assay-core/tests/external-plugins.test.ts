import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BARE_ARCHETYPE, createTempDirectoryFixture, writeBareArchetype } from "assay-test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  EXTERNAL_PLUGINS_STATE_FILE,
  checkPlugins,
  initFramework,
  isCapabilityEnabled,
  listPlugins,
  loadExternalPluginsState,
  observeExternalPlugin,
  registerExternalPlugin,
  removeExternalPlugin,
  removePlugin,
  setExternalPluginEnabled,
} from "../src/index.js";

const tempDirs = createTempDirectoryFixture("assay-core-external-plugins");

beforeAll(() => {
  process.env.ASSAY_NO_TRACK = "1";
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function workspace(name: string): Promise<string> {
  const root = path.join(await tempDirs.createTempDir(), name);
  await writeBareArchetype(root);
  await initFramework({ target: root, name, archetype: BARE_ARCHETYPE });
  return root;
}

function fixtureDescriptor(id = "example.readonly-command") {
  return {
    __schema: 1,
    id,
    adapter_version: "1.0.0",
    assay: { spi_version: 1, version: "0.8.0" },
    provenance: {
      source: "npm:@example/assay-plugin-fixture",
      ref: "v1.0.0",
      license: { spdx: "MIT", url: "https://example.test/licenses/fixture-v1" },
    },
    payload: {
      locator: "npm:@example/assay-plugin-fixture",
      version: "1.0.0",
      ref: "@example/assay-plugin-fixture@1.0.0",
      integrity:
        "sha512-y7I1KGRrQ0+uiUnJECFSO4sfsU17UiL2S7CVkfTz5ty3uMfCDK+B4ER2dnA8bCISyjOxNEqI4p3VQ4BO2tltTw==",
    },
    targets: [{ host: "example.host" }, { host: "example.legacy-host", version: "1.0.0" }],
    requests: {
      capabilities: ["fixture.status.read", "fixture.readonly-command"],
      scopes: ["fixture.status.read", "fixture.command.read"],
      surfaces: ["fixture.status.report", "fixture.command.status"],
    },
    state_ownership: [
      { owner: "host", locator: "example.host:readonly-command-mode" },
      { owner: "assay", path: "plugin-state/example-readonly-command" },
    ],
    execution: { owner: "external-host", assay_executes: false },
  } as const;
}

function ponytailShapedDescriptor() {
  return {
    ...fixtureDescriptor("dietrichgebert.ponytail"),
    adapter_version: "0.1.0",
    provenance: {
      source: "github:DietrichGebert/ponytail",
      ref: "bc9ee949d5f439e8b9f3bb92c6d6d3d1e6ebd324",
      license: {
        spdx: "MIT",
        url: "https://github.com/DietrichGebert/ponytail/blob/v4.8.4/LICENSE",
      },
    },
    payload: {
      locator: "npm:@dietrichgebert/ponytail",
      version: "4.8.4",
      ref: "@dietrichgebert/ponytail@4.8.4",
      integrity:
        "sha512-MALDTmDxKa2SJ8zKVekuOwWvo6+PvypNf5xeV2AtLO5OBtkt1U7DLWOeUbb9Th3H9lV80EkWoRI05yK0/dnekA==",
    },
    requests: {
      capabilities: ["ponytail.discovery.status"],
      scopes: ["ponytail.metadata.read"],
      surfaces: ["ponytail.status.report"],
    },
    targets: [{ host: "opencode.host" }, { host: "pi.host" }],
    state_ownership: [{ owner: "host", locator: "ponytail.host:mode" }],
  } as const;
}

describe("external plugin descriptor control plane", () => {
  it("normalizes and locks ordinary and Ponytail-shaped descriptors through the same path", async () => {
    const root = await workspace("GenericPath");
    const ordinary = await registerExternalPlugin({
      root,
      descriptor: fixtureDescriptor(),
      now: new Date("2026-08-07T00:00:00.000Z"),
    });
    const ponytail = await registerExternalPlugin({
      root,
      descriptor: ponytailShapedDescriptor(),
      now: new Date("2026-08-07T00:00:00.000Z"),
    });

    expect(ordinary.plugin.descriptorVerification).toBe("verified");
    expect(ponytail.plugin.descriptorVerification).toBe("verified");
    expect(ordinary.plugin.descriptorDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ponytail.plugin.descriptorDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ordinary.plugin.hostInstallation).toBe("unobserved");
    expect(ponytail.plugin.hostActivation).toBe("unobserved");
    expect(ordinary.plugin.assayExecutes).toBe(false);
    expect(ponytail.plugin.executionOwner).toBe("external-host");
    expect(ponytail.plugin.targets).toEqual([{ host: "opencode.host" }, { host: "pi.host" }]);
    expect(ponytail.plugin.targets.every((target) => target.version === undefined)).toBe(true);
    expect(ordinary.plugin.provenance.license).toEqual({
      spdx: "MIT",
      url: "https://example.test/licenses/fixture-v1",
    });
    expect(ordinary.plugin.stateOwnership).toContainEqual({
      owner: "host",
      locator: "example.host:readonly-command-mode",
    });

    const locked = await readFile(path.join(root, EXTERNAL_PLUGINS_STATE_FILE), "utf8");
    const descriptorWithSortedRequests = fixtureDescriptor();
    const repeated = await registerExternalPlugin({
      root,
      descriptor: {
        ...descriptorWithSortedRequests,
        requests: {
          capabilities: [...descriptorWithSortedRequests.requests.capabilities].sort(),
          scopes: [...descriptorWithSortedRequests.requests.scopes].sort(),
          surfaces: [...descriptorWithSortedRequests.requests.surfaces].sort(),
        },
      },
    });
    expect(repeated.alreadyRegistered).toBe(true);
    expect(await readFile(path.join(root, EXTERNAL_PLUGINS_STATE_FILE), "utf8")).toBe(locked);
  });

  it("rejects reserved/unqualified IDs and incomplete or non-exact payload locks", async () => {
    const root = await workspace("Validation");
    await expect(
      registerExternalPlugin({ root, descriptor: fixtureDescriptor("assay.external") }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({ root, descriptor: fixtureDescriptor("unqualified") }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor(),
          payload: {
            ...fixtureDescriptor().payload,
            version: "^1.0.0",
            integrity: "latest",
          },
        },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    for (const projectPath of [
      "project",
      "project/plugin-state",
      "Project/plugin-state",
      "project\\plugin-state",
      ".assay/project/plugin-state",
    ]) {
      await expect(
        registerExternalPlugin({
          root,
          descriptor: {
            ...fixtureDescriptor(),
            state_ownership: [{ owner: "assay", path: projectPath }],
          },
        }),
      ).rejects.toThrow(/descriptor failed validation/);
    }
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor(),
          payload: { ...fixtureDescriptor().payload, integrity: "sha512-====" },
        },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor(),
          payload: {
            ...fixtureDescriptor().payload,
            version: "4.8.4",
            ref: "pkg@14.8.40",
          },
        },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({
        root,
        descriptor: { ...fixtureDescriptor(), payload: { locator: "npm:x" } },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    for (const unsafePath of ["D:..\\escape", "D:relative", "\\rooted\\escape"]) {
      await expect(
        registerExternalPlugin({
          root,
          descriptor: {
            ...fixtureDescriptor(),
            state_ownership: [{ owner: "assay", path: unsafePath }],
          },
        }),
      ).rejects.toThrow(/descriptor failed validation/);
    }
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor(),
          state_ownership: [{ owner: "assay", path: ".assay" }],
        },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor(),
          state_ownership: [{ owner: "host", locator: "not-namespaced" }],
        },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor(),
          provenance: {
            ...fixtureDescriptor().provenance,
            license: { spdx: "MIT", url: "not-a-url" },
          },
        },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor(),
          provenance: {
            ...fixtureDescriptor().provenance,
            license: {
              spdx: "not an SPDX id",
              url: "https://example.test/license",
            },
          },
        },
      }),
    ).rejects.toThrow(/descriptor failed validation/);
    await expect(
      registerExternalPlugin({
        root,
        descriptor: {
          ...fixtureDescriptor("example.sha256-integrity"),
          payload: {
            ...fixtureDescriptor().payload,
            integrity: `sha256:${"a".repeat(64)}`,
          },
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        plugin: expect.objectContaining({ id: "example.sha256-integrity" }),
      }),
    );
  });

  it("uses locale-independent ordinal normalization for non-ASCII ownership locators", async () => {
    const root = await workspace("OrdinalDigest");
    const descriptor = {
      ...fixtureDescriptor("example.ordinal-digest"),
      state_ownership: [
        { owner: "host", locator: "fixture.host:éclair" },
        { owner: "host", locator: "fixture.host:Ωmega" },
        { owner: "host", locator: "fixture.host:中" },
      ],
    } as const;
    const first = await registerExternalPlugin({ root, descriptor });
    const repeated = await registerExternalPlugin({
      root,
      descriptor: { ...descriptor, state_ownership: [...descriptor.state_ownership].reverse() },
    });

    expect(repeated.alreadyRegistered).toBe(true);
    expect(repeated.plugin.descriptorDigest).toBe(first.plugin.descriptorDigest);
  });

  it("keeps declaration-only state separate and grants no native capability or authority", async () => {
    const root = await workspace("DeclarationOnly");
    await registerExternalPlugin({ root, descriptor: fixtureDescriptor() });

    const listed = await listPlugins(root);
    expect(listed.plugins).toContainEqual(
      expect.objectContaining({
        id: "example.readonly-command",
        installed: false,
        health: "unverifiable",
        contributedCapabilities: [],
        operationalResponsibilities: [],
        providedResponsibilities: [],
        external: expect.objectContaining({
          assayEnabled: true,
          hostInstallation: "unobserved",
          hostActivation: "unobserved",
          health: "unverifiable",
          assayExecutes: false,
        }),
      }),
    );
    expect(await isCapabilityEnabled(root, "intent")).toBe(false);
    const checked = await checkPlugins(root);
    expect(checked.ok).toBe(true);
    expect(checked.rows).toContainEqual(
      expect.objectContaining({
        path: EXTERNAL_PLUGINS_STATE_FILE,
        status: "warning",
      }),
    );
  });

  it("detects a tampered descriptor lock during a non-executing check", async () => {
    const root = await workspace("TamperedLock");
    await registerExternalPlugin({ root, descriptor: fixtureDescriptor() });
    const file = path.join(root, EXTERNAL_PLUGINS_STATE_FILE);
    const state = JSON.parse(await readFile(file, "utf8"));
    state.plugins["example.readonly-command"].descriptor.payload.ref =
      "npm:@example/assay-plugin-fixture@9.9.9";
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const checked = await checkPlugins(root);
    expect(checked.ok).toBe(false);
    expect(checked.rows).toEqual([
      expect.objectContaining({
        path: EXTERNAL_PLUGINS_STATE_FILE,
        status: "error",
        message: expect.stringContaining("external plugin state failed validation"),
      }),
    ]);
  });

  it("accepts a matching host report and fail-closes identity, integrity, host, grant, and ownership mismatches", async () => {
    const root = await workspace("Observations");
    const registered = await registerExternalPlugin({ root, descriptor: fixtureDescriptor() });
    const observation = {
      __schema: 1,
      plugin_id: registered.plugin.id,
      descriptor_digest: registered.plugin.descriptorDigest,
      payload_integrity: registered.plugin.payload.integrity,
      host: "example.host",
      host_version: "9.4.0",
      granted_scopes: [...registered.plugin.requestedScopes],
      granted_surfaces: [...registered.plugin.requestedSurfaces],
      state_ownership: [...registered.plugin.stateOwnership],
      installation: "installed",
      activation: "active",
      health: "healthy",
      observed_at: "2026-08-07T01:00:00.000Z",
    } as const;

    const observed = await observeExternalPlugin({ root, observation });
    expect(observed.plugin.hostInstallation).toBe("installed");
    expect(observed.plugin.hostActivation).toBe("active");
    expect(observed.plugin.health).toBe("healthy");
    expect((await checkPlugins(root)).ok).toBe(true);

    for (const invalidObservation of [
      {
        ...observation,
        installation: "not-installed",
        activation: "active",
        health: "healthy",
      },
      {
        ...observation,
        installation: "not-installed",
        activation: "inactive",
        health: "unhealthy",
      },
      { ...observation, observed_at: "not-a-timestamp" },
    ]) {
      await expect(
        observeExternalPlugin({ root, observation: invalidObservation }),
      ).rejects.toThrow(/observation failed validation/);
    }

    await expect(
      observeExternalPlugin({
        root,
        observation: {
          ...observation,
          host: "example.legacy-host",
          host_version: "2.0.0",
        },
      }),
    ).rejects.toThrow(/target host version mismatch/);

    const mismatchCases = [
      { ...observation, plugin_id: "other.plugin" },
      { ...observation, descriptor_digest: `sha256:${"0".repeat(64)}` },
      { ...observation, payload_integrity: "sha512-bWlzbWF0Y2g=" },
      { ...observation, host: "other.host" },
      { ...observation, granted_scopes: ["fixture.command.write"] },
      { ...observation, granted_surfaces: ["fixture.other.surface"] },
      {
        ...observation,
        state_ownership: [{ owner: "host", locator: "other.host:foreign-state" }],
      },
    ];
    for (const mismatch of mismatchCases) {
      await expect(observeExternalPlugin({ root, observation: mismatch })).rejects.toThrow();
    }

    const unhealthy = await observeExternalPlugin({
      root,
      observation: {
        ...observation,
        activation: "inactive",
        health: "unhealthy",
        observed_at: "2026-08-07T02:00:00+00:00",
      },
    });
    expect(unhealthy.plugin).toEqual(
      expect.objectContaining({
        observedHost: "example.host",
        observedHostVersion: "9.4.0",
        health: "unhealthy",
      }),
    );
    expect((await listPlugins(root)).plugins).toContainEqual(
      expect.objectContaining({
        id: registered.plugin.id,
        health: "unhealthy",
        external: expect.objectContaining({
          observedHost: "example.host",
          observedHostVersion: "9.4.0",
          health: "unhealthy",
        }),
      }),
    );

    const notInstalled = await observeExternalPlugin({
      root,
      observation: {
        ...observation,
        installation: "not-installed",
        activation: "inactive",
        health: "unverifiable",
        observed_at: "2026-08-07T03:00:00Z",
      },
    });
    expect(notInstalled.plugin).toEqual(
      expect.objectContaining({
        hostInstallation: "not-installed",
        hostActivation: "inactive",
        health: "unverifiable",
      }),
    );
  });

  it("disables, re-enables, and removes only Assay records while preserving host ownership", async () => {
    const root = await workspace("ControlLifecycle");
    await registerExternalPlugin({ root, descriptor: fixtureDescriptor() });

    const disabled = await removePlugin({
      root,
      plugin: "example.readonly-command",
      mode: "disable",
    });
    expect(disabled).toMatchObject({ changed: true, hookRemoved: false, dataPreserved: true });
    expect((await listExternal(root)).assayEnabled).toBe(false);

    const enabled = await setExternalPluginEnabled({
      root,
      plugin: "example.readonly-command",
      enabled: true,
    });
    expect(enabled.changed).toBe(true);
    expect(enabled.plugin.assayEnabled).toBe(true);

    const removed = await removeExternalPlugin({ root, plugin: "example.readonly-command" });
    expect(removed).toEqual({
      root,
      plugin: "example.readonly-command",
      changed: true,
      hostStatePreserved: true,
    });
    expect((await loadExternalPluginsState(root))?.plugins).toEqual({});
  });
});

async function listExternal(root: string) {
  const entry = (await listPlugins(root)).plugins.find(
    (plugin) => plugin.id === "example.readonly-command",
  )?.external;
  if (!entry) throw new Error("external plugin missing");
  return entry;
}
