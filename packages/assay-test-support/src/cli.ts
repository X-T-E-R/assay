import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BuiltCliRunner {
  readonly packageRoot: string;
  readonly cliPath: string;
  runCli(args: readonly string[], options?: RunCliOptions): Promise<CliResult>;
  runCliIn(
    cwd: string,
    args: readonly string[],
    options?: Omit<RunCliOptions, "cwd">,
  ): Promise<CliResult>;
}

export interface BuiltCliRunnerOptions {
  readonly packageRoot?: string;
  readonly cliPath?: string;
  readonly registryRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createBuiltCliRunner(options: BuiltCliRunnerOptions = {}): BuiltCliRunner {
  const packageRoot = options.packageRoot ?? process.cwd();
  const cliPath = options.cliPath ?? path.join(packageRoot, "dist", "cli.js");

  async function runCli(
    args: readonly string[],
    runOptions: RunCliOptions = {},
  ): Promise<CliResult> {
    return runCliIn(
      runOptions.cwd ?? packageRoot,
      args,
      runOptions.env ? { env: runOptions.env } : {},
    );
  }

  async function runCliIn(
    cwd: string,
    args: readonly string[],
    runOptions: Omit<RunCliOptions, "cwd"> = {},
  ): Promise<CliResult> {
    const env = {
      ...process.env,
      ...(options.registryRoot ? { ASSAY_PROJECT_REGISTRY_ROOT: options.registryRoot } : {}),
      ...options.env,
      ...runOptions.env,
    };

    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
        cwd,
        env,
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

  return { packageRoot, cliPath, runCli, runCliIn };
}
