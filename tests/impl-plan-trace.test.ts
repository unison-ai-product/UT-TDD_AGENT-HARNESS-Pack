// PLAN-REVERSE-40 塊A: impl→PLAN トレーサビリティ検査 (IMP-088)。
// src module/CLI/lint/doctor check が PLAN generates に紐づくか。NEW orphan を fail-close。
// design-source traceで3件をback-fillした後のknown-debtは5件。IMP-087の4件もREVERSE-40へback-fill済。

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeImplPlanTrace,
  IMPL_PLAN_TRACE_BASELINE,
  loadImplPlanTraceInput,
} from "../src/lint/impl-plan-trace.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

function makeOwnerWritableTree(root: string): void {
  const visit = (path: string): void => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;

    const permissions = stat.mode & 0o777;
    if (stat.isDirectory()) {
      chmodSync(path, permissions | 0o700);
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }

    chmodSync(path, permissions | 0o200);
  };

  visit(root);
}

function makeImplPlanTraceFixture(options: {
  sourcePaths: string[];
  includePlan?: boolean;
  planPaths?: string[];
  designPaths?: string[];
}): string {
  const root = mkdtempSync(join(tmpdir(), "impl-plan-trace-"));
  if (options.includePlan !== false) mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "design", "harness", "L6-function-design"), {
    recursive: true,
  });
  for (const sourcePath of options.sourcePaths) {
    const absolutePath = join(root, sourcePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, "export {};\n", "utf8");
  }
  if (options.includePlan !== false) {
    writeFileSync(
      join(root, "docs", "plans", "PLAN-fixture.md"),
      (options.planPaths ?? []).join("\n"),
      "utf8",
    );
  }
  writeFileSync(
    join(root, "docs", "design", "harness", "L6-function-design", "fixture.md"),
    (options.designPaths ?? []).join("\n"),
    "utf8",
  );
  return root;
}

describe("analyzeImplPlanTrace (U-IPT-001..003)", () => {
  const base = {
    tracedPaths: new Set(["src/cli.ts"]),
    baseline: new Set(["src/lint/shared.ts"]),
  };

  it("U-IPT-001: traced でも baseline でもない src は orphan (NEW orphan fail-close)", () => {
    const r = analyzeImplPlanTrace({ srcFiles: ["src/new/feature.ts"], ...base });
    expect(r.orphans).toContain("src/new/feature.ts");
    expect(r.ok).toBe(false);
  });

  it("U-IPT-002: PLAN generates に traced な src は orphan でない", () => {
    const r = analyzeImplPlanTrace({ srcFiles: ["src/cli.ts"], ...base });
    expect(r.orphans).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("U-IPT-003: baseline 済 src は orphan でない (known-debt)", () => {
    const r = analyzeImplPlanTrace({ srcFiles: ["src/lint/shared.ts"], ...base });
    expect(r.orphans).toHaveLength(0);
  });
});

describe("impl-plan trace baseline shrink-only (U-IPT-005)", () => {
  it("U-IPT-005: baselineは shrink-only の既存負の回帰網を維持する", () => {
    // 縮小のみ可の回帰網: 新規モジュールを baseline へ足して gate を黙らせない
    // (2026-08-05 に一度 9 件化した実例の再発防止。trace は PLAN 側で持つ)。
    expect(IMPL_PLAN_TRACE_BASELINE.has("src/plan/parent-drive-mismatch-baseline.ts")).toBe(false);
    // IMP-087 orphan は baseline でなく back-fill (trace) で解消
    expect(IMPL_PLAN_TRACE_BASELINE.has("src/lint/rule-drift.ts")).toBe(false);
    expect(IMPL_PLAN_TRACE_BASELINE.has("src/gate/review-tier.ts")).toBe(false);
  });

  it("legacy U-IPT-005 citation: module ownership reduces baseline to empty", () => {
    expect([...IMPL_PLAN_TRACE_BASELINE].sort()).toEqual([]);
  });
});

describe("U-IPT-006: loadImplPlanTraceInput design-source trace", () => {
  const root = makeImplPlanTraceFixture({
    sourcePaths: ["src/runtime/windows-hide.ts", "src/doctor/windows-hide.ts"],
    planPaths: ["no implementation path is declared here"],
    designPaths: ["src/runtime/windows-hide.ts", "src/doctor/windows-hide.ts"],
  });

  beforeAll(() => {
    expect(existsSync(join(root, "src/runtime/windows-hide.ts"))).toBe(true);
    expect(existsSync(join(root, "src/doctor/windows-hide.ts"))).toBe(true);
    expect(existsSync(join(root, "docs/plans/PLAN-fixture.md"))).toBe(true);
    expect(existsSync(join(root, "docs/design/harness/L6-function-design/fixture.md"))).toBe(true);
  });

  afterAll(() => removeTestTree(root));

  it("the isolated fixture has both source files and their design references", () => {
    expect([...loadImplPlanTraceInput(root).srcFiles].sort()).toEqual([
      "src/doctor/windows-hide.ts",
      "src/runtime/windows-hide.ts",
    ]);
  });

  it("U-IPT-006: design-only source references cover new src", () => {
    const input = loadImplPlanTraceInput(root);
    const result = analyzeImplPlanTrace(input);
    expect(input.tracedPaths.has("src/runtime/windows-hide.ts")).toBe(true);
    expect(input.tracedPaths.has("src/doctor/windows-hide.ts")).toBe(true);
    expect(result.orphans).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("src absent from PLAN and design remains an orphan", () => {
    const root = makeImplPlanTraceFixture({
      sourcePaths: ["src/unowned.ts"],
      planPaths: ["no implementation path is declared here"],
      designPaths: ["no implementation path is declared here"],
    });
    try {
      const input = loadImplPlanTraceInput(root);
      const result = analyzeImplPlanTrace(input);
      expect(input.tracedPaths.has("src/unowned.ts")).toBe(false);
      expect(result.orphans).toEqual(["src/unowned.ts"]);
      expect(result.ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });
});

describe("Impl-Plan-Trace module ownership candidates (U-IPT-007..011)", () => {
  const moduleOwnerRoot = makeImplPlanTraceFixture({
    includePlan: false,
    sourcePaths: ["src/foo/a.ts", "src/foo/b.ts", "src/glob/a.ts", "src/glob/b.ts"],
    designPaths: ["src/foo/", "src/glob/*.ts"],
  });
  const unownedModuleRoot = makeImplPlanTraceFixture({
    includePlan: false,
    sourcePaths: ["src/foo/a.ts", "src/bar/c.ts"],
    designPaths: ["src/foo/", "foo/src/bar/"],
  });
  const planOnlyRoot = makeImplPlanTraceFixture({
    sourcePaths: ["src/bar/c.ts"],
    planPaths: ["src/bar/", "src/bar/c.ts"],
  });
  const topLevelRoot = makeImplPlanTraceFixture({
    includePlan: false,
    sourcePaths: ["src/cli.ts", "src/secret.ts"],
    designPaths: ["src/cli.ts"],
  });
  const mutationModule = "ut_tdd_issue1354_unmentioned_probe_20261026";
  let detachedRepoInput: ReturnType<typeof loadImplPlanTraceInput>;
  let mutationRoot = "";
  let mutationInput: ReturnType<typeof loadImplPlanTraceInput>;

  heavyBeforeAll("git", () => {
    for (const root of [moduleOwnerRoot, unownedModuleRoot, planOnlyRoot, topLevelRoot]) {
      expect(existsSync(join(root, "src"))).toBe(true);
      expect(existsSync(join(root, "docs/plans/PLAN-fixture.md"))).toBe(root === planOnlyRoot);
      expect(existsSync(join(root, "docs/design/harness/L6-function-design/fixture.md"))).toBe(
        true,
      );
    }
    expect(existsSync(join(moduleOwnerRoot, "src/foo/a.ts"))).toBe(true);
    expect(existsSync(join(moduleOwnerRoot, "src/glob/b.ts"))).toBe(true);
    expect(existsSync(join(unownedModuleRoot, "src/bar/c.ts"))).toBe(true);
    expect(existsSync(join(planOnlyRoot, "src/bar/c.ts"))).toBe(true);
    expect(existsSync(join(topLevelRoot, "src/secret.ts"))).toBe(true);

    const snapshotRoot = headSnapshotRoot();
    detachedRepoInput = loadImplPlanTraceInput(snapshotRoot);
    expect(detachedRepoInput.srcFiles.length).toBeGreaterThan(0);
    expect(existsSync(join(snapshotRoot, "docs/design"))).toBe(true);
    expect(detachedRepoInput.tracedPaths.size).toBeGreaterThan(0);

    mutationRoot = mkdtempSync(join(tmpdir(), "impl-plan-trace-module-mutation-"));
    for (const sourcePath of detachedRepoInput.srcFiles) {
      const target = join(mutationRoot, sourcePath);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "export {};\n", "utf8");
    }
    const mutationSource = join(mutationRoot, "src", mutationModule, "probe.ts");
    mkdirSync(join(mutationSource, ".."), { recursive: true });
    writeFileSync(mutationSource, "export {};\n", "utf8");
    cpSync(join(snapshotRoot, "docs", "design"), join(mutationRoot, "docs", "design"), {
      recursive: true,
    });
    expect(
      existsSync(join(mutationRoot, "docs/design/harness/L6-function-design/module-drift.md")),
    ).toBe(true);
    mutationInput = loadImplPlanTraceInput(mutationRoot);
    expect(mutationInput.srcFiles).toContain(`src/${mutationModule}/probe.ts`);
    expect(mutationInput.srcFiles.length).toBe(detachedRepoInput.srcFiles.length + 1);
    expect(mutationInput.tracedPaths.size).toBeGreaterThan(0);
  });

  heavyAfterAll("teardown", () => {
    for (const root of [moduleOwnerRoot, unownedModuleRoot, planOnlyRoot, topLevelRoot]) {
      removeTestTree(root);
    }
    if (mutationRoot) {
      makeOwnerWritableTree(join(mutationRoot, "docs", "design"));
      removeTestTree(mutationRoot);
    }
  });

  it("U-IPT-007: the real detached repository is owned with an empty baseline", () => {
    const result = analyzeImplPlanTrace(detachedRepoInput);
    expect({
      baseline: [...detachedRepoInput.baseline].sort(),
      orphans: result.orphans,
      ok: result.ok,
    }).toEqual({ baseline: [], orphans: [], ok: true });
  });

  it("U-IPT-007: an unmentioned module added to a derived repo is the sole orphan", () => {
    const result = analyzeImplPlanTrace(mutationInput);
    expect(result).toEqual({
      orphans: [`src/${mutationModule}/probe.ts`],
      ok: false,
    });
  });

  it("U-IPT-008: module and glob mentions own all files in that module", () => {
    const result = analyzeImplPlanTrace(loadImplPlanTraceInput(moduleOwnerRoot));
    expect(result).toEqual({ orphans: [], ok: true });
  });

  it("U-IPT-009: unmentioned modules remain orphaned at the path boundary", () => {
    const result = analyzeImplPlanTrace(loadImplPlanTraceInput(unownedModuleRoot));
    expect(result).toEqual({ orphans: ["src/bar/c.ts"], ok: false });
  });

  it("U-IPT-010: PLAN-only module and file references do not confer ownership", () => {
    const input = loadImplPlanTraceInput(planOnlyRoot);
    const result = analyzeImplPlanTrace(input);
    expect({ tracedByPlanOnlyPath: input.tracedPaths.has("src/bar/c.ts"), result }).toEqual({
      tracedByPlanOnlyPath: false,
      result: { orphans: ["src/bar/c.ts"], ok: false },
    });
  });

  it("U-IPT-011: top-level files require their own exact design path", () => {
    const result = analyzeImplPlanTrace(loadImplPlanTraceInput(topLevelRoot));
    expect(result).toEqual({ orphans: ["src/secret.ts"], ok: false });
  });
});
