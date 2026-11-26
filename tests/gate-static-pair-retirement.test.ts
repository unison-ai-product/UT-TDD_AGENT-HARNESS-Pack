import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { analyzePairFreeze, loadPairDocs } from "../src/vmodel/lint.ts";
import {
  createPairRetirementGitFixture,
  designDoc,
  testDesignDoc,
} from "./support/pair-retirement-fixture.ts";

describe("design-pair retirement", () => {
  const shared = "docs/test-design/harness/L7-pair/shared.md";
  const designA = "docs/design/harness/L1-requirements/a.md";
  const designB = "docs/design/harness/L2-screen/b.md";
  const designC = "docs/design/harness/L3-functional/c.md";
  const testC = "docs/test-design/harness/L7-pair/c.md";

  function sharedPairFiles() {
    return {
      [designA]: designDoc("L1", shared),
      [designB]: designDoc("L2", shared),
      [shared]: testDesignDoc(`docs/design/harness/`),
    };
  }

  type ComparisonResult = { ok: boolean };
  type ComparisonEnv = Record<string, string | undefined>;
  type RetirementChecks = {
    checkPairRetirement?: (root: string, base: string, head: string) => ComparisonResult;
    checkPairRetirementFromEnvironment?: (root: string, env: ComparisonEnv) => ComparisonResult;
  };

  // Green connects U-RCDEV-037 and this test to the same CI entry point.
  async function retirementChecks(): Promise<RetirementChecks> {
    return (await import("../src/gate/static.ts")) as unknown as RetirementChecks;
  }

  async function observePairRetirement(
    repoRoot: string,
    baseCommit: string,
    headCommit: string,
  ): Promise<ComparisonResult> {
    const { checkPairRetirement } = await retirementChecks();
    if (!checkPairRetirement) throw new Error("checkPairRetirement export missing");
    return checkPairRetirement(repoRoot, baseCommit, headCommit);
  }

  async function observeCiComparison(
    repoRoot: string,
    env: ComparisonEnv,
  ): Promise<ComparisonResult> {
    const { checkPairRetirementFromEnvironment } = await retirementChecks();
    if (!checkPairRetirementFromEnvironment) {
      throw new Error("checkPairRetirementFromEnvironment export missing");
    }
    return checkPairRetirementFromEnvironment(repoRoot, env);
  }

  it("synthetic Git positive control has independently readable base/head snapshots with equal pair counts", () => {
    const baseFiles = sharedPairFiles();
    const headFiles: Record<string, string | undefined> = {
      ...baseFiles,
      [designA]: undefined,
      "docs/design/harness/L4-architecture/replacement.md": designDoc("L4", shared),
    };
    const fixture = createPairRetirementGitFixture(baseFiles, headFiles);
    try {
      expect(fixture.baseCommit).not.toBe(fixture.headCommit);
      expect(fixture.readAt(fixture.baseCommit, designA)).toContain(shared);
      expect(fixture.readAt(fixture.headCommit, designA)).toBeNull();
      expect(
        fixture.readAt(fixture.headCommit, "docs/design/harness/L4-architecture/replacement.md"),
      ).toContain(shared);
      expect(fixture.readAt(fixture.baseCommit, shared)).toContain("docs/design/harness/");

      const baseRoot = fixture.materialize(fixture.baseCommit);
      const headRoot = fixture.materialize(fixture.headCommit);
      const basePairs = analyzePairFreeze(loadPairDocs(baseRoot));
      const headPairs = analyzePairFreeze(loadPairDocs(headRoot));
      expect(basePairs).toMatchObject({ ok: true, pairs: 2 });
      expect(headPairs).toMatchObject({ ok: true, pairs: 2 });
    } finally {
      fixture.cleanup();
    }
  });

  it("U-GSPAIR-001 accepts an additional valid pair without a retirement declaration", async () => {
    const fixture = createPairRetirementGitFixture(sharedPairFiles(), {
      ...sharedPairFiles(),
      [designC]: designDoc("L3", testC),
      [testC]: testDesignDoc("docs/design/harness/L3-functional/"),
    });
    try {
      const result = await observePairRetirement(
        fixture.root,
        fixture.baseCommit,
        fixture.headCommit,
      );
      expect(result).toMatchObject({ ok: true });
    } finally {
      fixture.cleanup();
    }
  });

  it("U-GSPAIR-002 rejects an equal-count replacement and identifies both old paths", async () => {
    const baseFiles = sharedPairFiles();
    const headFiles = {
      ...baseFiles,
      [designA]: undefined,
      "docs/design/harness/L4-architecture/replacement.md": designDoc("L4", shared),
    };
    const fixture = createPairRetirementGitFixture(baseFiles, headFiles);
    try {
      const base = analyzePairFreeze(loadPairDocs(fixture.materialize(fixture.baseCommit)));
      const head = analyzePairFreeze(loadPairDocs(fixture.materialize(fixture.headCommit)));
      expect(base.pairs).toBe(head.pairs);
      const result = await observePairRetirement(
        fixture.root,
        fixture.baseCommit,
        fixture.headCommit,
      );
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).toContain(designA);
      expect(JSON.stringify(result)).toContain(shared);
    } finally {
      fixture.cleanup();
    }
  });

  it("U-GSPAIR-003 keys shared test designs by the complete design/test pair", async () => {
    const baseFiles = sharedPairFiles();
    const declaration = "docs/governance/design-pair-retirements/issue-1073.json";
    const fixture = createPairRetirementGitFixture(baseFiles, {
      ...baseFiles,
      [designA]: undefined,
      [declaration]: JSON.stringify({ pairs: [{ design: designA, testDesign: shared }] }),
    });
    try {
      const exact = await observePairRetirement(
        fixture.root,
        fixture.baseCommit,
        fixture.headCommit,
      );
      expect(exact).toMatchObject({ ok: true });
      const wrongSideFixture = createPairRetirementGitFixture(baseFiles, {
        ...baseFiles,
        [designA]: undefined,
        [declaration]: JSON.stringify({
          pairs: [{ design: designA, testDesign: "docs/test-design/harness/L7-pair/other.md" }],
        }),
      });
      try {
        const wrong = await observePairRetirement(
          wrongSideFixture.root,
          wrongSideFixture.baseCommit,
          wrongSideFixture.headCommit,
        );
        expect(wrong).toMatchObject({ ok: false });
      } finally {
        wrongSideFixture.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("U-GSPAIR-004 rejects reused, duplicate, extra, and malformed retirement declarations", async () => {
    const baseFiles = sharedPairFiles();
    const declaration = "docs/governance/design-pair-retirements/issue-1073.json";
    const priorDeclaration = "docs/governance/design-pair-retirements/issue-1000.json";
    const cases = [
      {
        base: {
          ...baseFiles,
          [priorDeclaration]: JSON.stringify({ pairs: [{ design: designA, testDesign: shared }] }),
        },
        head: {
          ...baseFiles,
          [priorDeclaration]: JSON.stringify({ pairs: [{ design: designA, testDesign: shared }] }),
          [designA]: undefined,
        },
      },
      {
        base: baseFiles,
        head: {
          ...baseFiles,
          [designA]: undefined,
          [declaration]: JSON.stringify({
            pairs: [
              { design: designA, testDesign: shared },
              { design: designA, testDesign: shared },
            ],
          }),
        },
      },
      {
        base: baseFiles,
        head: {
          ...baseFiles,
          [declaration]: JSON.stringify({ pairs: [{ design: designA, testDesign: shared }] }),
        },
      },
      { base: baseFiles, head: { ...baseFiles, [designA]: undefined, [declaration]: "{" } },
    ];
    for (const testCase of cases) {
      const fixture = createPairRetirementGitFixture(testCase.base, testCase.head);
      try {
        const result = await observePairRetirement(
          fixture.root,
          fixture.baseCommit,
          fixture.headCommit,
        );
        expect(result).toMatchObject({ ok: false });
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("U-GSPAIR-005 compares merge-base to the event head, not the advanced base tip", async () => {
    const baseOnly = "docs/design/harness/L5-detailed-design/base-only.md";
    const headOnly = "docs/design/harness/L6-function-design/head-only.md";
    const common = sharedPairFiles();
    const fixture = createPairRetirementGitFixture(
      common,
      {
        ...sharedPairFiles(),
        [headOnly]: designDoc("L6", testC),
        [testC]: testDesignDoc("docs/design/harness/L6-function-design/"),
      },
      {
        [baseOnly]: designDoc("L5", shared),
      },
    );
    try {
      const mergeBase = spawnSync(
        "git",
        ["-C", fixture.root, "merge-base", fixture.baseCommit, fixture.headCommit],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );
      expect(mergeBase.status).toBe(0);
      expect(mergeBase.stdout.trim()).toBe(fixture.commonCommit);
      expect(fixture.readAt(fixture.baseCommit, baseOnly)).not.toBeNull();
      expect(fixture.readAt(fixture.headCommit, baseOnly)).toBeNull();
      expect(fixture.readAt(fixture.headCommit, headOnly)).not.toBeNull();
      const result = await observePairRetirement(
        fixture.root,
        fixture.baseCommit,
        fixture.headCommit,
      );
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain(baseOnly);
    } finally {
      fixture.cleanup();
    }
  });

  it("isolates a readable commit with a missing tracked blob", () => {
    const fixture = createPairRetirementGitFixture(sharedPairFiles(), sharedPairFiles());
    try {
      expect(fixture.readAt(fixture.headCommit, designB)).toContain(shared);
      fixture.removeLooseBlob(fixture.headCommit, designB);
      expect(fixture.readAt(fixture.headCommit, designB)).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it("U-GSPAIR-006 rejects unresolved commits and unreadable tracked documents", async () => {
    const base = sharedPairFiles();
    const fixture = createPairRetirementGitFixture(base, {
      ...base,
      [designB]: `${base[designB]}\nHead version\n`,
    });
    try {
      const positive = await observePairRetirement(
        fixture.root,
        fixture.baseCommit,
        fixture.headCommit,
      );
      expect(positive).toMatchObject({ ok: true });

      const unresolved = await observePairRetirement(
        fixture.root,
        "f".repeat(40),
        fixture.headCommit,
      );
      expect(unresolved).toMatchObject({ ok: false });

      fixture.removeLooseBlob(fixture.headCommit, designB);
      const unreadable = await observePairRetirement(
        fixture.root,
        fixture.baseCommit,
        fixture.headCommit,
      );
      expect(unreadable).toMatchObject({ ok: false });
      expect(JSON.stringify(unreadable)).toContain(designB);
    } finally {
      fixture.cleanup();
    }
  });

  it("U-GSPAIR-007 refuses golden-only fallback for incomplete or conflicting CI input", async () => {
    const base = sharedPairFiles();
    const fixture = createPairRetirementGitFixture(base, base, {
      [designC]: designDoc("L3", testC),
      [testC]: testDesignDoc("docs/design/harness/L3-functional/"),
    });
    try {
      const valid = {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        PAIR_RETIREMENT_EVENT_NAME: "pull_request",
        PAIR_RETIREMENT_BASE_SHA: fixture.baseCommit,
        PAIR_RETIREMENT_HEAD_SHA: fixture.headCommit,
      };
      expect(await observeCiComparison(fixture.root, valid)).toMatchObject({ ok: true });

      const push = {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        PAIR_RETIREMENT_EVENT_NAME: "push",
      };
      expect(await observeCiComparison(fixture.root, push)).toMatchObject({ ok: true });

      for (const env of [
        { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" },
        { ...valid, PAIR_RETIREMENT_EVENT_NAME: undefined },
        { ...valid, PAIR_RETIREMENT_BASE_SHA: undefined },
        { ...valid, PAIR_RETIREMENT_HEAD_SHA: undefined },
        { ...valid, PAIR_RETIREMENT_BASE_SHA: undefined, PAIR_RETIREMENT_HEAD_SHA: undefined },
        { ...valid, PAIR_RETIREMENT_BASE_SHA: "not-a-commit" },
        { ...valid, PAIR_RETIREMENT_HEAD_SHA: "not-a-commit" },
        { ...valid, PAIR_RETIREMENT_BASE_SHA: "f".repeat(40) },
        { ...valid, PAIR_RETIREMENT_HEAD_SHA: "f".repeat(40) },
        { ...valid, PAIR_RETIREMENT_EVENT_NAME: "push" },
        { ...valid, GITHUB_EVENT_NAME: "push" },
        { ...valid, GITHUB_ACTIONS: undefined },
        { ...push, PAIR_RETIREMENT_BASE_SHA: fixture.baseCommit },
        { ...push, PAIR_RETIREMENT_HEAD_SHA: fixture.headCommit },
      ]) {
        expect(await observeCiComparison(fixture.root, env), JSON.stringify(env)).toMatchObject({
          ok: false,
        });
      }
    } finally {
      fixture.cleanup();
    }

    const loss = createPairRetirementGitFixture(base, { ...base, [designA]: undefined });
    try {
      const result = await observeCiComparison(loss.root, {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        PAIR_RETIREMENT_EVENT_NAME: "pull_request",
        PAIR_RETIREMENT_BASE_SHA: loss.baseCommit,
        PAIR_RETIREMENT_HEAD_SHA: loss.headCommit,
      });
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).toContain(designA);
    } finally {
      loss.cleanup();
    }
  });
});
