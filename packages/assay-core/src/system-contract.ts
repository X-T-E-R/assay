import { stringify as stringifyYaml } from "yaml";

import type { SystemStatus, SystemVcs } from "./schemas/index.js";

export interface SystemContractInput {
  readonly project: string;
  readonly name: string;
  readonly version: string;
  readonly status: SystemStatus;
  readonly vcs: SystemVcs;
  readonly vcsRef: string;
  readonly supersedes: readonly string[];
}

/**
 * Render the sidecar contract for a registered system. The contract is a
 * write-only projection of the registry record: nothing reads it back.
 */
export function renderSystemContract(input: SystemContractInput): string {
  return stringifyYaml({
    system: {
      project: input.project,
      name: input.name,
      version: input.version,
      status: input.status,
      vcs: input.vcs,
      vcs_ref: input.vcsRef,
      supersedes: [...input.supersedes],
    },
    contract_managed_by: "assay",
  });
}
