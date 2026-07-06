import { type AssayProjectRegistryCommand, recordProjectLifecycleBestEffort } from "assay-core";

export interface CommandProjectLifecycleOptions {
  readonly dryRun?: boolean;
  readonly noTrack?: boolean;
}

export async function recordCommandProjectLifecycle(
  projectPath: string,
  command: AssayProjectRegistryCommand,
  options: CommandProjectLifecycleOptions = {},
): Promise<void> {
  if (options.dryRun === true) {
    return;
  }

  await recordProjectLifecycleBestEffort(
    projectPath,
    command,
    options.noTrack === undefined ? {} : { noTrack: options.noTrack },
  );
}
