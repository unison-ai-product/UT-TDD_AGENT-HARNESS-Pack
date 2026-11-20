/**
 * Issue #1559 Red: baseline conflict の merge preview 再計算 oracle。
 * 契約: docs/design/harness/L6-function-design/merge-gate-check-run-selection.md §6.6。
 * 注入境界は checkBaselineConflict(repoRoot, headSha, { gates, pr })。
 */
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASELINE_GATES,
  checkBaselineConflict,
  evaluateBaselineConflict,
} from "../src/feedback/baseline-conflict.ts";
import { CODE_SIZE_BASELINE_PATH } from "../src/lint/code-size.ts";
import {
  buildFixture,
  buildFunctionExcessFixture,
  buildGateSelectionFixture,
  buildLineBaselineGrowthFixture,
  canonicalPath,
  captureWorktreeObservation,
  changedPaths,
  checkWithGates as checkWithGatesForPr,
  cleanFixture,
  type Fixture,
  gateSelectionGates,
  type InjectedGate,
  injectedGate,
  isFixtureLinkedPreviewRoot,
  runMerge,
  SMALL_BASELINE,
  smallFiles,
  TARGET,
  verifyConflictAndCleanPreview,
  verifyFunctionExcessFixture,
  verifyLineBaselineGrowthFixture,
  worktreePaths,
} from "./fixtures/baseline-recompute-fixture.ts";
import { heavyAfterAll } from "./support/hook-bounds.ts";

const gitFault = vi.hoisted(() => ({
  active: false,
  needles: [] as string[],
  hits: 0,
  mergeBases: [] as Array<{
    repoRoot: string;
    sha: string;
    commonDir: string;
    registeredWorktreePaths: string[];
  }>,
  mergeTreeCalls: [] as string[][],
  commitTreeCalls: [] as string[][],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const command = args[0];
      const commandArgs = args[1];
      if (
        gitFault.active &&
        String(command) === "git" &&
        Array.isArray(commandArgs) &&
        gitFault.needles.every((needle) => commandArgs.includes(needle))
      ) {
        gitFault.hits += 1;
        throw new Error("injected git failure");
      }
      if (
        String(command) === "git" &&
        Array.isArray(commandArgs) &&
        commandArgs.includes("merge-tree")
      ) {
        gitFault.mergeTreeCalls.push(commandArgs.map(String));
      }
      if (
        String(command) === "git" &&
        Array.isArray(commandArgs) &&
        commandArgs.includes("commit-tree")
      ) {
        gitFault.commitTreeCalls.push(commandArgs.map(String));
      }
      const output = actual.execFileSync(...args);
      if (
        String(command) === "git" &&
        Array.isArray(commandArgs) &&
        commandArgs.includes("merge-base") &&
        commandArgs.includes("HEAD") &&
        commandArgs.includes("origin/main")
      ) {
        const rootIndex = commandArgs.indexOf("-C");
        const repoRoot = rootIndex >= 0 ? String(commandArgs[rootIndex + 1]) : "";
        const observation = captureWorktreeObservation(repoRoot, (args) =>
          String(
            actual.execFileSync("git", args, {
              encoding: "utf8",
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            }),
          ),
        );
        gitFault.mergeBases.push({
          sha: String(output).trim(),
          ...observation,
        });
      }
      return output;
    },
  };
});

const fixtures = new Map<string, Fixture>();

function checkWithGates(repoRoot: string, headSha: string, gates: readonly InjectedGate[]) {
  return checkWithGatesForPr(repoRoot, headSha, { gates, pr: 1559 });
}

function fixture(key: string): Fixture {
  const value = fixtures.get(key);
  if (!value) throw new Error(`fixture prerequisite did not register: ${key}`);
  return value;
}

afterEach(() => {
  gitFault.active = false;
  gitFault.needles = [];
  gitFault.hits = 0;
  gitFault.mergeBases = [];
  gitFault.mergeTreeCalls = [];
  gitFault.commitTreeCalls = [];
});

describe.sequential("review merge gate baseline recompute (Issue #1559)", {
  timeout: 240_000,
}, () => {
  it("prerequisite: fixtures, merge graph, conflict paths and gates are valid", () => {
    const small = smallFiles();
    fixtures.set("small", buildFixture(small.base, small.branches));
    const lineBaselineGrowth = buildLineBaselineGrowthFixture();
    fixtures.set("line-baseline-growth", lineBaselineGrowth);
    const lineBaselineGate = injectedGate("code-size-baseline-grown", {
      name: "code-size",
      baselinePath: CODE_SIZE_BASELINE_PATH,
      forceFinding: true,
      reason: "lines",
    });
    expect(
      evaluateBaselineConflict(
        changedPaths(
          lineBaselineGrowth.work,
          lineBaselineGrowth.baseSha,
          lineBaselineGrowth.headSha,
        ),
        changedPaths(
          lineBaselineGrowth.work,
          lineBaselineGrowth.baseSha,
          lineBaselineGrowth.mainSha,
        ),
        [lineBaselineGate],
      ).conflicts,
    ).toEqual([{ gate: "code-size", paths: [TARGET] }]);
    verifyConflictAndCleanPreview(lineBaselineGrowth, [lineBaselineGate], () => {});
    verifyLineBaselineGrowthFixture(lineBaselineGrowth);
    const smallPreviewTree = verifyConflictAndCleanPreview(
      fixture("small"),
      [injectedGate(null)],
      (previewPath) => {
        expect(injectedGate(null).check(previewPath)).toMatchObject({ ok: true, findings: [] });
        expect(
          injectedGate("code-size-baseline-grown", { over: 0, stale: 0 }).check(previewPath),
        ).toMatchObject({ ok: false, summary: { over: 0, stale: 0 } });
        expect(
          injectedGate("code-size-stale-baseline", { stale: 1 }).check(previewPath).findings,
        ).toHaveLength(1);
        expect(() => injectedGate(null, { throwOnCheck: true }).check(previewPath)).toThrow(
          "fixture gate check failed",
        );
        expect(() =>
          checkWithGates(fixture("small").work, fixture("small").headSha, [
            injectedGate(null, { throwOnCheck: true }),
          ]),
        ).not.toThrow();
      },
    );
    expect(smallPreviewTree).toMatch(/^[0-9a-f]{40,64}$/);

    fixtures.set(
      "required",
      buildFixture(
        { [SMALL_BASELINE]: "{}\n" },
        {
          pr: { [TARGET]: "line-a\nline-b\nline-c\n" },
          main: { [SMALL_BASELINE]: '{"main-change":1}\n' },
        },
      ),
    );
    verifyConflictAndCleanPreview(
      fixture("required"),
      [injectedGate("code-size-required")],
      (previewPath) => {
        expect(injectedGate("code-size-required").check(previewPath).findings).toMatchObject([
          { kind: "code-size-required" },
        ]);
      },
    );

    for (const key of ["code", "doc", "both", "none"] as const) {
      fixtures.set(`selection-${key}`, buildGateSelectionFixture(key));
    }

    const contentConflict = buildFixture(
      { [TARGET]: "base-line\n", [SMALL_BASELINE]: '{"baseline":1}\n' },
      { pr: { [TARGET]: "pr-line\n" }, main: { [TARGET]: "main-line\n" } },
    );
    fixtures.set("content-conflict", contentConflict);
    expect(
      execFileSync(
        "git",
        ["-C", contentConflict.work, "merge-base", contentConflict.headSha, "origin/main"],
        {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim(),
    ).toBe(contentConflict.baseSha);
    let mergeTreeHadConflict = false;
    try {
      execFileSync(
        "git",
        [
          "-C",
          contentConflict.work,
          "merge-tree",
          "--write-tree",
          contentConflict.mainSha,
          contentConflict.headSha,
        ],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
      const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
      const status = error instanceof Error && "status" in error ? error.status : undefined;
      mergeTreeHadConflict =
        status === 1 && `${stdout ?? ""}\n${stderr ?? ""}`.includes("CONFLICT");
    }
    expect(mergeTreeHadConflict).toBe(true);

    const functionExcess = buildFunctionExcessFixture();
    fixtures.set("function-excess", functionExcess);
    expect(
      execFileSync(
        "git",
        ["-C", functionExcess.work, "merge-base", functionExcess.headSha, "origin/main"],
        {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim(),
    ).toBe(functionExcess.baseSha);
    verifyConflictAndCleanPreview(
      functionExcess,
      BASELINE_GATES as unknown as InjectedGate[],
      () => {},
    );
    verifyFunctionExcessFixture(functionExcess);
    expect(() =>
      checkBaselineConflict(functionExcess.work, functionExcess.headSha, { pr: 1559 }),
    ).not.toThrow();
    expect(() => runMerge(functionExcess)).not.toThrow();

    for (const needles of [["--version"], ["commit-tree"], ["worktree", "add"]]) {
      gitFault.active = true;
      gitFault.needles = needles;
      expect(() => execFileSync("git", ["-C", fixture("small").work, ...needles])).toThrow(
        "injected git failure",
      );
      expect(gitFault.hits).toBe(1);
      expect(() =>
        checkWithGates(fixture("small").work, fixture("small").headSha, [injectedGate(null)]),
      ).not.toThrow();
      gitFault.active = false;
      gitFault.needles = [];
      gitFault.hits = 0;
    }
    expect(() =>
      checkWithGates(fixture("small").work, fixture("small").headSha, [injectedGate(null)]),
    ).not.toThrow();
    gitFault.active = true;
    gitFault.needles = ["--version"];
    expect(() =>
      checkWithGates(fixture("small").work, fixture("small").headSha, [injectedGate(null)]),
    ).not.toThrow();
    gitFault.active = false;
    gitFault.needles = [];
    expect(() =>
      checkWithGates(fixture("small").work, fixture("small").headSha, [
        injectedGate(null, { throwOnCheck: true }),
      ]),
    ).not.toThrow();

    for (const gate of BASELINE_GATES as unknown as Array<{ name: string; check?: unknown }>) {
      expect(["code-size", "doc-split"]).toContain(gate.name);
    }
  });

  it("U-RVMG-050: finding 0 件の injected gate なら checker は許可する", () => {
    expect(
      checkWithGates(fixture("small").work, fixture("small").headSha, [injectedGate(null)]),
    ).toBeNull();
  });

  it("U-RVMG-051(a): baseline に無い上限超過 finding は拒否する", () => {
    expect(
      checkWithGates(fixture("required").work, fixture("required").headSha, [
        injectedGate("code-size-required"),
      ]),
    ).toBe("baseline_conflict_recomputed:fixture-gate=code-size-required");
  });

  it("U-RVMG-051(b): over=0 stale=0 でも baseline-grown は拒否する", () => {
    expect(
      checkWithGates(
        fixture("line-baseline-growth").work,
        fixture("line-baseline-growth").headSha,
        [
          injectedGate("code-size-baseline-grown", {
            over: 0,
            stale: 0,
            name: "code-size",
            baselinePath: CODE_SIZE_BASELINE_PATH,
            forceFinding: true,
            reason: "lines",
          }),
        ],
      ),
    ).toBe("baseline_conflict_recomputed:code-size=code-size-baseline-grown");
  });

  it("U-RVMG-051(c): stale-baseline finding は拒否する", () => {
    expect(
      checkWithGates(fixture("small").work, fixture("small").headSha, [
        injectedGate("code-size-stale-baseline", { stale: 1 }),
      ]),
    ).toBe("baseline_conflict_recomputed:fixture-gate=code-size-stale-baseline");
  });

  it("U-RVMG-052(b): merge-tree 非対応時は unknown で拒否する", () => {
    gitFault.active = true;
    gitFault.needles = ["--version"];
    const testFixture = fixture("small");
    const run = runMerge(testFixture);
    expect(run.result.reason).toMatch(/^baseline_conflict_unknown:/);
    expect(run.merges).toBe(0);
    expect(gitFault.hits).toBeGreaterThan(0);
  });

  it("U-RVMG-052(a): merge-tree content conflict は従来どおり拒否する", () => {
    const testFixture = fixture("content-conflict");
    const calls: string[] = [];
    gitFault.mergeTreeCalls = [];
    const run = runMerge(testFixture, false, (repoRoot, headSha) =>
      checkWithGates(repoRoot, headSha, [injectedGate(null, { calls })]),
    );
    expect(run.result.reason).toMatch(/^baseline_conflict:/);
    expect(run.merges).toBe(0);
    expect(gitFault.mergeTreeCalls).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("U-RVMG-052(c): commit-tree / worktree 失敗時は unknown で拒否する", () => {
    const testFixture = fixture("small");
    gitFault.active = true;
    gitFault.needles = ["commit-tree"];
    gitFault.hits = 0;
    const run = runMerge(testFixture);
    expect(run.result.reason).toMatch(/^baseline_conflict_unknown:/);
    expect(run.merges).toBe(0);
    expect(gitFault.hits).toBe(1);
  });

  it("U-RVMG-052(c): worktree add 失敗時は unknown で拒否する", () => {
    const testFixture = fixture("small");
    gitFault.active = true;
    gitFault.needles = ["worktree", "add"];
    gitFault.hits = 0;
    const run = runMerge(testFixture);
    expect(run.result.reason).toMatch(/^baseline_conflict_unknown:/);
    expect(run.merges).toBe(0);
    expect(gitFault.hits).toBe(1);
  });

  it("U-RVMG-052(d): gate check 例外は unknown で拒否する", () => {
    const testFixture = fixture("small");
    const calls: string[] = [];
    const run = runMerge(testFixture, false, (repoRoot, headSha) =>
      checkWithGates(repoRoot, headSha, [injectedGate(null, { throwOnCheck: true, calls })]),
    );
    expect(run.result.reason).toMatch(/^baseline_conflict_unknown:/);
    expect(run.merges).toBe(0);
    expect(calls).toEqual(["fixture-gate"]);
  });

  it("U-RVMG-053: 実 BASELINE_GATES は両方の check を持つ", () => {
    const gates = BASELINE_GATES as unknown as Array<{ name: string; check?: unknown }>;
    expect(gates.map((gate) => gate.name).sort()).toEqual(["code-size", "doc-split"]);
    for (const gate of gates) expect(typeof gate.check).toBe("function");
  });

  it("U-RVMG-053(a): code-size のみ再計算する", () => {
    const testFixture = fixture("selection-code");
    const calls: string[] = [];
    const reason = checkWithGates(testFixture.work, testFixture.headSha, gateSelectionGates(calls));
    expect(reason).toBeNull();
    expect(calls).toEqual(["code-size"]);
  });

  it("U-RVMG-053(b): doc-split のみ再計算する", () => {
    const testFixture = fixture("selection-doc");
    const calls: string[] = [];
    const reason = checkWithGates(testFixture.work, testFixture.headSha, gateSelectionGates(calls));
    expect(reason).toBeNull();
    expect(calls).toEqual(["doc-split"]);
  });

  it("U-RVMG-053(c): 両gateを再計算する", () => {
    const testFixture = fixture("selection-both");
    const calls: string[] = [];
    const reason = checkWithGates(testFixture.work, testFixture.headSha, gateSelectionGates(calls));
    expect(reason).toBeNull();
    expect(calls).toEqual(["code-size", "doc-split"]);
  });

  it("U-RVMG-053(d): 非競合時は再計算しない", () => {
    gitFault.mergeTreeCalls = [];
    gitFault.commitTreeCalls = [];
    const testFixture = fixture("selection-none");
    const calls: string[] = [];
    const reason = checkWithGates(testFixture.work, testFixture.headSha, gateSelectionGates(calls));
    expect(reason).toBeNull();
    expect(calls).toEqual([]);
    expect(gitFault.mergeTreeCalls).toEqual([]);
    expect(gitFault.commitTreeCalls).toEqual([]);
  });

  it("U-RVMG-054: 比較元は元 merge-base でなく現 main", () => {
    const testFixture = fixture("function-excess");
    gitFault.mergeBases = [];
    const run = runMerge(testFixture);
    expect(run.result.ok).toBe(false);
    expect(run.result.reason).toMatch(
      /^baseline_conflict_recomputed:code-size=code-size-baseline-grown/,
    );
    expect(run.merges).toBe(0);
    expect(
      gitFault.mergeBases.some(
        (entry) =>
          isFixtureLinkedPreviewRoot(entry, testFixture) && entry.sha === testFixture.mainSha,
      ),
    ).toBe(true);
    const previewRoots = gitFault.mergeBases.filter((entry) =>
      isFixtureLinkedPreviewRoot(entry, testFixture),
    );
    expect(previewRoots.length).toBeGreaterThan(0);
    const registeredAfterDecision = new Set(worktreePaths(testFixture.work).map(canonicalPath));
    for (const entry of previewRoots) {
      expect(registeredAfterDecision.has(entry.repoRoot)).toBe(false);
    }
  });

  heavyAfterAll("teardown", () => {
    for (const testFixture of fixtures.values()) cleanFixture(testFixture);
  });
});
