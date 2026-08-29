import type { Command, CommandUnknownOpts } from "@commander-js/extra-typings";

/**
 * Top-level names the suite answers itself. Each half spells these for its own
 * view — absorb sees the whole study surface, own-work filters it and adds
 * build validation — so neither half's copy is mounted.
 */
export const SUITE_OWNED_COMMANDS = ["init", "check", "status", "prime", "explain"] as const;

/**
 * `.assay` is assay's native envelope, so the suite mounts no command whose job
 * is to rename it away. The escape hatch stays where it belongs: `absorb
 * migrate-envelope` or `ownwork migrate-envelope`.
 */
export const UNMOUNTED_COMMANDS = ["migrate-envelope"] as const;

const DENIED = new Set<string>([...SUITE_OWNED_COMMANDS, ...UNMOUNTED_COMMANDS]);

/**
 * Re-parent every remaining subcommand of one half onto the suite program. Each
 * action closure keeps the output injected when the half's program was built,
 * and a name that collides with an already-mounted one throws here rather than
 * shadowing it silently.
 */
export function mountHalf(program: Command, half: CommandUnknownOpts): readonly string[] {
  const mounted: string[] = [];
  for (const command of [...half.commands]) {
    const name = command.name();
    if (DENIED.has(name)) continue;
    program.addCommand(command);
    mounted.push(name);
  }
  return mounted;
}
