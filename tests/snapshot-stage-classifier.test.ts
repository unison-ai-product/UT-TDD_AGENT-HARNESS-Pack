import { describe, expect, it } from "vitest";
import {
  classifySnapshotStageCalls,
  isSnapshotResolverGitRead,
  SNAPSHOT_RESOLVER_GIT_READS,
  type SnapshotStage,
  type SnapshotStageCall,
} from "./support/snapshot-stage-classifier.ts";

const call = (command: string, args: string[]): SnapshotStageCall => ({ command, args });

describe("snapshot stage call classifier", () => {
  it("allowlists only the snapshot resolver's read-only Git calls", () => {
    const reads = SNAPSHOT_RESOLVER_GIT_READS.map((args) =>
      call("C:\\Program Files\\Git\\cmd\\git.exe", args.split(" ")),
    );
    expect(reads.map(({ command, args }) => isSnapshotResolverGitRead(command, args))).toEqual(
      Array(reads.length).fill(true),
    );
    expect(
      [
        call("git", ["rev-parse", "--show-toplevel", "--quiet"]),
        call("git", ["clone", "repo"]),
        call("npm", ["ci"]),
      ].map(({ command, args }) => isSnapshotResolverGitRead(command, args)),
    ).toEqual([false, false, false]);
    expect(classifySnapshotStageCalls(reads)).toEqual([]);
  });

  it("classifies blocked stages across path forms and permits unrelated Git reads", () => {
    const windowsNode = process.execPath.toUpperCase();
    const windowsHelpCalls = [
      call("C:\\Program Files\\Git\\cmd\\git.exe", ["clone", "repo"]),
      call(windowsNode, ["C:\\work\\node_modules\\npm\\bin\\npm-cli.js", "ci"]),
      call(windowsNode, ["C:\\work\\src\\cli.ts", "db", "rebuild"]),
      call(windowsNode, ["node_modules\\vitest\\vitest.mjs", "run"]),
      call("C:\\Program Files\\Git\\cmd\\git.exe", ["rev-parse", "--show-toplevel"]),
    ];
    const posixUnknownCalls = [
      call("/usr/bin/git", ["clone", "repo"]),
      call(process.execPath, ["/repo/node_modules/npm/bin/npm-cli.js", "install"]),
      call(process.execPath, ["/repo/src/cli.ts", "db", "rebuild"]),
      call(process.execPath, ["node_modules/vitest/vitest.mjs", "run"]),
      call("/usr/bin/git", ["rev-parse", "--show-toplevel"]),
    ];
    const expectedStages: SnapshotStage[] = ["git-clone", "npm-install", "db-rebuild", "vitest"];

    expect(classifySnapshotStageCalls(windowsHelpCalls)).toEqual(expectedStages);
    expect(classifySnapshotStageCalls(posixUnknownCalls)).toEqual(expectedStages);

    const directNpmCalls: SnapshotStageCall[] = [];
    for (const command of ["npm", "C:\\Program Files\\nodejs\\npm.cmd", "/usr/bin/npm"]) {
      for (const verb of ["install", "ci", "i"]) {
        directNpmCalls.push(call(command, [verb]));
      }
    }
    expect(classifySnapshotStageCalls(directNpmCalls)).toEqual(Array(9).fill("npm-install"));

    for (const relativeVitest of [
      "node_modules\\vitest\\vitest.mjs",
      "node_modules/vitest/vitest.mjs",
    ]) {
      expect(classifySnapshotStageCalls([call(process.execPath, [relativeVitest, "run"])])).toEqual(
        ["vitest"],
      );
      expect(
        classifySnapshotStageCalls([call(process.execPath, [`${relativeVitest}.backup`, "run"])]),
      ).toEqual([]);
    }

    expect(
      classifySnapshotStageCalls([
        call("git", ["-c", "core.longpaths=true", "clone", "repo"]),
        call("npm.cmd", ["--prefix", "C:/repo", "ci"]),
        call("npm", ["view", "ci"]),
        call("git", ["show", "clone"]),
        call(process.execPath, ["src/cli.ts", "db", "status"]),
      ]),
    ).toEqual(["git-clone", "npm-install"]);
  });
});
