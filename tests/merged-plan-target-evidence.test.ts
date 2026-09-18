import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSnapshot } from "../scripts/run-vitest-snapshot.ts";
import {
  analyzeMergedPlanStatus,
  loadMergedPlanStatusInput,
} from "../src/lint/merged-plan-status.ts";
import {
  classifyTargetArtifacts,
  resolveMergedPlanTargetEvidence,
  selectCanonicalMergedTarget,
} from "../src/lint/merged-plan-target-evidence.ts";

describe("merged-plan canonical target evidence", () => {
  it("selects the remote default branch instead of the immediate stacked PR base", () => {
    const evidence = selectCanonicalMergedTarget({
      candidates: [
        { ref: "origin/main", source: "remote_default", exists: true, sha: "a".repeat(40) },
        { ref: "main", source: "local_main", exists: true, sha: "a".repeat(40) },
      ],
      subjectHeadSha: "c".repeat(40),
      immediateBaseRef: "work/parent",
      immediateBaseSha: "b".repeat(40),
      mergeBaseSha: "a".repeat(40),
    });

    expect(evidence).toMatchObject({
      decision: "canonical_target",
      targetRef: "origin/main",
      targetSha: "a".repeat(40),
      immediateBaseRef: "work/parent",
      immediateBaseSha: "b".repeat(40),
    });
  });

  it("classifies only paths present on the canonical target as landed", () => {
    expect(
      classifyTargetArtifacts(
        ["src/main-debt.ts", "src/stacked.ts"],
        new Set(["src/main-debt.ts"]),
      ),
    ).toEqual([
      { path: "src/main-debt.ts", decision: "landed_on_target" },
      { path: "src/stacked.ts", decision: "absent_from_target" },
    ]);
  });

  it("resolves origin/HEAD as canonical target and records stacked-base evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-target-evidence-"));
    const eventPath = join(root, "event.json");
    const previousEvent = process.env.GITHUB_EVENT_PATH;
    try {
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writeFileSync(join(root, "src", "main.ts"), "export const main = true;\n", "utf8");
      writePlan(root, "PLAN-TEST-main-debt.md", "src/main.ts");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "main"]);
      const mainSha = gitText(root, ["rev-parse", "HEAD"]);
      git(root, ["remote", "add", "origin", root]);
      git(root, ["fetch", "origin", "main:refs/remotes/origin/main"]);
      git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      git(root, ["checkout", "-b", "work/parent"]);
      writeFileSync(join(root, "src", "parent.ts"), "export const parent = true;\n", "utf8");
      writePlan(root, "PLAN-TEST-stacked-parent.md", "src/parent.ts");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "parent"]);
      const parentSha = gitText(root, ["rev-parse", "HEAD"]);
      git(root, ["checkout", "-b", "work/child"]);
      writeFileSync(join(root, "src", "child.ts"), "export const child = true;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "child"]);
      const childSha = gitText(root, ["rev-parse", "HEAD"]);
      writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { default_branch: "main" },
          pull_request: { base: { ref: "work/parent", sha: parentSha } },
        }),
        "utf8",
      );
      process.env.GITHUB_EVENT_PATH = eventPath;

      const evidence = resolveMergedPlanTargetEvidence(root);
      expect(evidence).toMatchObject({
        decision: "canonical_target",
        targetRef: "origin/main",
        targetSha: mainSha,
        subjectHeadSha: childSha,
        mergeBaseSha: mainSha,
        immediateBaseRef: "work/parent",
        immediateBaseSha: parentSha,
      });
      const input = loadMergedPlanStatusInput(root);
      expect(input.targetEvidence).toEqual(evidence);
      expect(
        input.plans.find((plan) => plan.planId === "PLAN-TEST-main-debt")?.mergedArtifacts,
      ).toEqual(["src/main.ts"]);
      expect(
        input.plans.find((plan) => plan.planId === "PLAN-TEST-stacked-parent")?.mergedArtifacts,
      ).toEqual([]);
      expect(
        input.plans.find((plan) => plan.planId === "PLAN-TEST-stacked-parent")?.artifactDecisions,
        // issue #162: 三点比較の追加で、親 PR が持ち込んだ deliverable は absent ではなく
        // inherited_from_base として区別される。RECOVERY-18 の不変条件 (immediate base を landed 判定に
        // 使わない / 子 PR を violation にしない) は下の violations 検査がそのまま保っている。
      ).toEqual([{ path: "src/parent.ts", decision: "inherited_from_base" }]);
      expect(
        analyzeMergedPlanStatus(input).violations.map((violation) => violation.planId),
      ).toEqual(["PLAN-TEST-main-debt"]);
    } finally {
      if (previousEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEvent;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed in a Git repository when no canonical target can be verified", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-target-missing-"));
    try {
      git(root, ["init", "-b", "work/only"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writeFileSync(join(root, "src", "only.ts"), "export const only = true;\n", "utf8");
      writePlan(root, "PLAN-TEST-no-target.md", "src/only.ts");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "unanchored"]);

      expect(resolveMergedPlanTargetEvidence(root).decision).toBe("no_verified_target");
      expect(() => loadMergedPlanStatusInput(root)).toThrow(
        "merged-plan canonical target could not be verified",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to main when a known non-main default branch is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-target-non-main-"));
    const eventPath = join(root, "event.json");
    const previousEvent = process.env.GITHUB_EVENT_PATH;
    try {
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      writeFileSync(join(root, "base.txt"), "base\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "main"]);
      writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: "trunk" } }), "utf8");
      process.env.GITHUB_EVENT_PATH = eventPath;

      expect(resolveMergedPlanTargetEvidence(root).decision).toBe("no_verified_target");
    } finally {
      if (previousEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEvent;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses event base SHA only when the PR base is the repository default branch", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-target-default-base-"));
    const eventPath = join(root, "event.json");
    const previousEvent = process.env.GITHUB_EVENT_PATH;
    try {
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      writeFileSync(join(root, "base.txt"), "base\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "main"]);
      const mainSha = gitText(root, ["rev-parse", "HEAD"]);
      git(root, ["checkout", "-b", "work/child"]);
      writeFileSync(join(root, "child.txt"), "child\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "child"]);
      writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { default_branch: "main" },
          pull_request: { base: { ref: "main", sha: mainSha } },
        }),
        "utf8",
      );
      process.env.GITHUB_EVENT_PATH = eventPath;

      expect(resolveMergedPlanTargetEvidence(root)).toMatchObject({
        decision: "canonical_target",
        targetRef: mainSha,
        targetSha: mainSha,
        source: "event_default_base",
      });
    } finally {
      if (previousEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEvent;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function git(root: string, args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

function gitStatus(root: string, args: string[]): number | null {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    return 0;
  } catch {
    return 1;
  }
}

function gitText(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function writePlan(root: string, name: string, artifactPath: string): void {
  writeFileSync(
    join(root, "docs", "plans", name),
    [
      "---",
      `plan_id: ${name.replace(/\.md$/, "")}`,
      "title: target evidence fixture",
      "kind: impl",
      "layer: L7",
      "drive: agent",
      "status: draft",
      "generates:",
      `  - artifact_path: ${artifactPath}`,
      "    artifact_type: source_module",
      "dependencies:",
      "  parent: null",
      "  requires: []",
      "  blocks: []",
      "---",
      "",
      "fixture",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * issue #186 の end-to-end 回帰フェンス。
 *
 * 欠陥は「stacked PR (base ≠ default branch) では canonical target の入力そのものが得られず、
 * `merged-plan-status` が内容と無関係に throw する」だった。原因は 2 つの面の合成である:
 * (a) doctor の実行面が snapshot clone で、CI checkout に local branch が無いため
 *     default branch の ref が生えない、(b) 候補列挙の第 1 候補 (event の base SHA) が
 *     `base ref == default branch` のときしか使われない。
 *
 * `PLAN-L7-461` の ref 注入 (`createSnapshot` → `injectDefaultBranchRef`) が (a) を塞いだが、
 * **両方の面を合成した回帰は無かった** — 注入側は `U-TESTHYGIENE-053/054` が、候補列挙側は
 * 上の stacked-base ケースが、それぞれ**別々に**固定しているだけだった。どちらか一方の変更で
 * 静かに再発しうるので、合成面をここで固定する。
 */
describe("stacked PR canonical target inside a snapshot (issue #186)", () => {
  /** CI checkout と同型の面 (detached + local branch なし) を作り、その snapshot を返す。 */
  const stackedSnapshot = (): {
    snapshot: string;
    mainSha: string;
    childSha: string;
    cleanup: () => void;
  } => {
    const origin = mkdtempSync(join(tmpdir(), "ut-tdd-186-origin-"));
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-186-checkout-"));
    rmSync(checkout, { recursive: true, force: true });
    const snapshot = `${checkout}-snapshot`;
    git(origin, ["init", "-b", "main"]);
    git(origin, ["config", "user.email", "test@example.invalid"]);
    git(origin, ["config", "user.name", "UT-TDD test"]);
    mkdirSync(join(origin, "src"), { recursive: true });
    writeFileSync(join(origin, "src", "main.ts"), "export const main = true;\n", "utf8");
    git(origin, ["add", "."]);
    git(origin, ["commit", "-m", "main"]);
    const mainSha = gitText(origin, ["rev-parse", "HEAD"]);

    git(tmpdir(), ["clone", "--no-tags", origin, checkout]);
    git(checkout, ["config", "user.email", "test@example.invalid"]);
    git(checkout, ["config", "user.name", "UT-TDD test"]);
    writeFileSync(join(checkout, "src", "child.ts"), "export const child = true;\n", "utf8");
    git(checkout, ["add", "."]);
    git(checkout, ["commit", "-m", "child"]);
    const childSha = gitText(checkout, ["rev-parse", "HEAD"]);
    git(checkout, ["checkout", "--detach", childSha]);
    git(checkout, ["branch", "-D", "main"]);

    return {
      snapshot,
      mainSha,
      childSha,
      cleanup: () => {
        rmSync(origin, { recursive: true, force: true });
        rmSync(checkout, { recursive: true, force: true });
        rmSync(snapshot, { recursive: true, force: true });
      },
    };
  };

  const withStackedEvent = (dir: string, run: () => void): void => {
    const eventPath = join(dir, "stacked-event.json");
    const previous = process.env.GITHUB_EVENT_PATH;
    writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { default_branch: "main" },
        // stacked: 直近 base は default branch ではない
        pull_request: { base: { ref: "work/parent", sha: "b".repeat(40) } },
      }),
      "utf8",
    );
    process.env.GITHUB_EVENT_PATH = eventPath;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previous;
    }
  };

  it("resolves the canonical target even though the immediate base is not the default branch", () => {
    const { snapshot, mainSha, childSha, cleanup } = stackedSnapshot();
    try {
      const checkout = snapshot.replace(/-snapshot$/, "");
      // 前提: 素の面には default branch の ref が無い (これが #186 の入口)。
      expect(gitStatus(checkout, ["rev-parse", "--verify", "refs/heads/main^{commit}"])).not.toBe(
        0,
      );
      createSnapshot(checkout, snapshot);

      withStackedEvent(snapshot, () => {
        const evidence = resolveMergedPlanTargetEvidence(snapshot);
        expect(evidence).toMatchObject({
          decision: "canonical_target",
          targetRef: "origin/main",
          targetSha: mainSha,
          subjectHeadSha: childSha,
          // 直近 base は evidence に残るが target には採らない (#138 の countermeasure は不変)。
          immediateBaseRef: "work/parent",
          source: "remote_default",
        });
      });
    } finally {
      cleanup();
    }
  });

  it("stays fail-closed when the source face has no resolvable default branch", () => {
    const { snapshot, cleanup } = stackedSnapshot();
    try {
      const checkout = snapshot.replace(/-snapshot$/, "");
      // default branch の痕跡を全て落とす = 注入元が無い面。
      git(checkout, ["remote", "remove", "origin"]);
      createSnapshot(checkout, snapshot);

      withStackedEvent(snapshot, () => {
        expect(resolveMergedPlanTargetEvidence(snapshot)).toMatchObject({
          decision: "no_verified_target",
          targetRef: null,
          targetSha: null,
        });
      });
    } finally {
      cleanup();
    }
  });
});
