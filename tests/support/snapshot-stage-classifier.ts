import { expect } from "vitest";

export interface SnapshotStageCall {
  readonly command: string;
  readonly args: readonly string[];
}

export type SnapshotStage = "git-clone" | "npm-install" | "db-rebuild" | "vitest";

export const SNAPSHOT_RESOLVER_GIT_READS = [
  "rev-parse --show-toplevel",
  "rev-parse head",
  "status --porcelain=v1 -z --untracked-files=all",
  "rev-parse --verify origin/main^{commit}",
  "rev-parse --verify origin/head^{commit}",
] as const;
const snapshotResolverGitReadSet: ReadonlySet<string> = new Set(SNAPSHOT_RESOLVER_GIT_READS);

const OPTIONS_WITH_VALUES = new Set([
  "-c",
  "--git-dir",
  "--work-tree",
  "--prefix",
  "--workspace",
  "-w",
  "--userconfig",
  "--cache",
  "--registry",
]);

function normalize(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function firstCommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (OPTIONS_WITH_VALUES.has(arg ?? "")) {
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

export function isSnapshotResolverGitRead(command: string, args: readonly string[]): boolean {
  const executable = normalize(command).split("/").pop() ?? "";
  return (
    ["git", "git.exe"].includes(executable) &&
    snapshotResolverGitReadSet.has(args.map(normalize).join(" "))
  );
}

export function classifySnapshotStageCalls(calls: readonly SnapshotStageCall[]): SnapshotStage[] {
  const stages: SnapshotStage[] = [];
  const nodePath = normalize(process.execPath);

  for (const call of calls) {
    const command = normalize(call.command);
    const args = call.args.map(normalize);
    const executable = command.split("/").pop() ?? "";
    const isNode = command === nodePath || ["node", "node.exe"].includes(executable);

    if (["git", "git.exe"].includes(executable) && firstCommand(args) === "clone") {
      stages.push("git-clone");
      continue;
    }

    const npmCliCommand =
      isNode &&
      args[0]?.endsWith("/npm/bin/npm-cli.js") &&
      ["ci", "install", "i"].includes(firstCommand(args.slice(1)) ?? "");
    const directNpmCommand =
      ["npm", "npm.cmd", "npm.exe"].includes(executable) &&
      ["ci", "install", "i"].includes(firstCommand(args) ?? "");
    if (npmCliCommand || directNpmCommand) {
      stages.push("npm-install");
      continue;
    }

    const cliPath = args[0];
    if (
      isNode &&
      (cliPath === "src/cli.ts" || cliPath?.endsWith("/src/cli.ts")) &&
      args[1] === "db" &&
      args[2] === "rebuild"
    ) {
      stages.push("db-rebuild");
      continue;
    }

    const vitestScript = /(?:^|\/)node_modules\/vitest\/vitest\.mjs$/.test(args[0] ?? "");
    if ((isNode && vitestScript) || ["vitest", "vitest.cmd", "vitest.exe"].includes(executable)) {
      stages.push("vitest");
    }
  }
  return stages;
}

export function expectNoForbiddenSnapshotStages(
  calls: readonly SnapshotStageCall[],
  name: string,
): void {
  const stages = classifySnapshotStageCalls(calls);
  for (const stage of ["git-clone", "npm-install", "db-rebuild", "vitest"] as const) {
    expect(
      stages.filter((observed) => observed === stage),
      `${name} ${stage} spawn count`,
    ).toHaveLength(0);
  }
}
