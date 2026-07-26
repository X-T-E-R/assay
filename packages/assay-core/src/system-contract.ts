import { stringify as stringifyYaml } from "yaml";

import type { SystemIntentAuthority, SystemStatus, SystemVcs } from "./schemas/index.js";

export interface SystemContractInput {
  readonly project: string;
  readonly name: string;
  readonly version: string;
  readonly status: SystemStatus;
  readonly vcs: SystemVcs;
  readonly vcsRef: string;
  readonly supersedes: readonly string[];
  readonly intentAuthority?: SystemIntentAuthority | undefined;
}

/**
 * Render the sidecar contract for a registered system. The contract is a
 * write-only projection of the registry record: nothing reads it back, so
 * `intent_authority` appears here for humans while the registry stays the
 * machine-readable home.
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
      ...(input.intentAuthority
        ? {
            intent_authority: {
              mode: input.intentAuthority.mode,
              ...(input.intentAuthority.pointer === undefined
                ? {}
                : { pointer: input.intentAuthority.pointer }),
            },
          }
        : {}),
    },
    contract_managed_by: "assay",
  });
}
