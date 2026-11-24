import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTestTree } from "./temp-tree.ts";

export type PairFixtureFiles = Record<string, string | undefined>;

export function designDoc(layer: string, testDesign: string): string {
  return [
    "---",
    `layer: ${layer}`,
    "artifact_type: design_doc",
    "status: confirmed",
    `pair_artifact: ${testDesign}`,
    "---",
    `# Synthetic ${layer} design`,
    "",
  ].join("\n");
}

export function testDesignDoc(designDirectory: string): string {
  return [
    "---",
    "layer: L7",
    "artifact_type: test_design",
    "status: confirmed",
    `pair_artifact: ${designDirectory}`,
    "---",
    "# Synthetic test design",
    "",
  ].join("\n");
}

export function createPairRetirementGitFixture(
  base: PairFixtureFiles,
  head: PairFixtureFiles,
  advancedBase?: PairFixtureFiles,
) {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-pair-retirement-"));
  const snapshots: string[] = [];
  const runGit = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  };
  const writeTree = (files: PairFixtureFiles) => {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === undefined) continue;
      const fullPath = join(root, ...path.split("/"));
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, contents, "utf8");
    }
  };
  const commitTree = (message: string) => {
    runGit(["add", "--all"]);
    runGit([
      "-c",
      "user.name=UT-TDD fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ]);
    return runGit(["rev-parse", "HEAD"]);
  };

  try {
    execFileSync("git", ["init", "--quiet", root], { encoding: "utf8", windowsHide: true });
    runGit(["config", "commit.gpgsign", "false"]);
    runGit(["config", "gc.auto", "0"]);
    writeTree(base);
    const commonCommit = commitTree("synthetic common ancestor");

    let baseCommit = commonCommit;
    if (advancedBase) {
      writeTree(advancedBase);
      baseCommit = commitTree("synthetic base branch advances");
      runGit(["checkout", "--detach", commonCommit]);
    }

    // Fixture repositories contain only generated docs. Reset that tree before writing the head.
    removeTestTree(join(root, "docs"));
    writeTree(head);
    const headCommit = commitTree("synthetic comparison head");
    const materializedBase = new Map(
      Object.entries({ ...base, ...(advancedBase ?? {}) }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const versions = new Map<string, Map<string, string>>([
      [
        commonCommit,
        new Map(
          Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      ],
      [baseCommit, materializedBase],
      [
        headCommit,
        new Map(
          Object.entries(head).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      ],
    ]);

    return {
      root,
      commonCommit,
      baseCommit,
      headCommit,
      removeLooseBlob(commit: string, path: string): void {
        const blob = runGit(["rev-parse", `${commit}:${path}`]);
        unlinkSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
        runGit(["cat-file", "-e", `${commit}^{commit}`]);
      },
      readAt(commit: string, path: string): string | null {
        const result = spawnSync("git", ["-C", root, "show", `${commit}:${path}`], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (result.error) throw result.error;
        return result.status === 0 ? result.stdout : null;
      },
      materialize(commit: string): string {
        const files = versions.get(commit);
        if (!files) throw new Error(`unknown synthetic commit ${commit}`);
        const snapshot = mkdtempSync(join(tmpdir(), "ut-tdd-pair-snapshot-"));
        snapshots.push(snapshot);
        for (const [path, contents] of files) {
          const fullPath = join(snapshot, ...path.split("/"));
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, contents, "utf8");
        }
        return snapshot;
      },
      cleanup(): void {
        for (const snapshot of snapshots) removeTestTree(snapshot);
        removeTestTree(root);
      },
    };
  } catch (error) {
    removeTestTree(root);
    throw error;
  }
}
