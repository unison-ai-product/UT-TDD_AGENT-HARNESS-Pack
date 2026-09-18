import { describe, expect, it } from "vitest";
import {
  analyzeWorktreeTopology,
  remapTopologyIdentities,
  type TopologyFinding,
  topologyDigest,
  type WorktreeFact,
} from "../src/runtime/worktree-topology.ts";

const oid = "a".repeat(40);
function fact(overrides: Partial<WorktreeFact> = {}): WorktreeFact {
  return {
    worktreePathKey: "/repo/w",
    adminPathKey: "/repo/.git/worktrees/w",
    headOid: oid,
    isMain: false,
    directoryObserved: true,
    worktreeToAdminOk: true,
    adminToWorktreeOk: true,
    dirty: false,
    branch: "feature/w",
    mergedIntoMain: false,
    ...overrides,
  };
}
const main = fact({
  worktreePathKey: "/repo",
  adminPathKey: "/repo/.git",
  isMain: true,
  branch: "main",
});
const input = (facts: WorktreeFact[], observations: TopologyFinding[] = []) => ({
  facts,
  adminEntries: facts
    .filter((item) => !item.isMain)
    .map((item) => ({ adminPathKey: item.adminPathKey, registered: true })),
  observations,
});

describe("worktree topology PF1", () => {
  it("U-WTTOPO-001: 正常linkをhealthyとidentityへ入れる", () => {
    const report = analyzeWorktreeTopology(input([main, fact()]));
    expect(report).toMatchObject({ healthy: 2, counts: { main: 1, active: 1 }, findings: [] });
  });
  it("U-WTTOPO-002/003: 双方向link不整合を個別に検出する", () => {
    // U-WTTOPO-003: admin -> worktreeの逆方向も独立して保持する。
    for (const broken of [fact({ worktreeToAdminOk: false }), fact({ adminToWorktreeOk: false })])
      expect(analyzeWorktreeTopology(input([main, broken])).findings[0]?.kind).toBe("link_broken");
  });
  it("U-WTTOPO-004/005: directory不在とorphan adminを区別する", () => {
    // U-WTTOPO-005: orphan adminはworktree factが無くても検出する。
    expect(
      analyzeWorktreeTopology(input([main, fact({ directoryObserved: false })])).findings[0]?.kind,
    ).toBe("dir_missing");
    expect(
      analyzeWorktreeTopology({
        facts: [main],
        adminEntries: [{ adminPathKey: "/repo/.git/worktrees/orphan", registered: false }],
      }).findings[0]?.kind,
    ).toBe("orphan_admin");
  });
  it("U-WTTOPO-006: dirtyはdetached/mergedより優先し排他的に数える", () => {
    const report = analyzeWorktreeTopology(
      input([main, fact({ dirty: true, mergedIntoMain: true, branch: undefined })]),
    );
    expect(report.counts).toMatchObject({ dirty: 1, detached: 0, merged: 0 });
    expect(report.retirable).toEqual([]);
  });
  it("U-WTTOPO-008/010/011: mainはidentityへ入れ、finding面はhealthy/retirableから除く", () => {
    // U-WTTOPO-010: finding面はhealthyに混入させない。
    // U-WTTOPO-011: finding面のmerged既定値もretirableへ昇格させない。
    const report = analyzeWorktreeTopology(
      input([main, fact({ worktreeToAdminOk: false, mergedIntoMain: true })]),
    );
    expect(report).toMatchObject({ healthy: 1, retirable: [], counts: { main: 1, merged: 1 } });
  });
  it("U-WTTOPO-009: 全出力はfacts/admin/observationsの入力順に不変", () => {
    const facts = [
      main,
      fact({ worktreePathKey: "/repo/b", mergedIntoMain: true }),
      fact({ worktreePathKey: "/repo/a", branch: undefined, detachedRetained: true }),
    ];
    const observations = [
      { kind: "collector_parse_error" as const, operation: "parse", evidenceCode: "x" },
    ];
    const left = analyzeWorktreeTopology(input(facts, observations));
    const right = analyzeWorktreeTopology({
      facts: [...facts].reverse(),
      adminEntries: [...input(facts).adminEntries].reverse(),
      observations: [...observations].reverse(),
    });
    expect(right).toEqual(left);
  });
  it("PF1: canonical identityのdigestはUTF-8順・入力順不変でありcase-onlyを併合しない", () => {
    const one = {
      worktreePathKey: "c:\\Repo\\A\\",
      adminPathKey: "c:\\Git\\A\\",
      headOid: oid,
      isMain: false,
    };
    const two = { ...one, worktreePathKey: "C:/Repo/a", adminPathKey: "C:/Git/a" };
    expect(topologyDigest([one, two])).toBe(topologyDigest([two, one]));
    expect(topologyDigest([one, two])).not.toBe(topologyDigest([one]));
  });
  it("PF1: root/prefix longest remapとalias factをcanonicalかつ安全に扱う", () => {
    const identities = [
      {
        worktreePathKey: "/repo/w",
        adminPathKey: "/repo/.git/worktrees/w",
        headOid: oid,
        isMain: false,
      },
    ];
    expect(
      remapTopologyIdentities(identities, [{ fromPrefix: "/", toPrefix: "/moved" }])[0],
    ).toMatchObject({ worktreePathKey: "/moved/repo/w" });
    expect(
      remapTopologyIdentities(identities, [
        { fromPrefix: "/", toPrefix: "/moved" },
        { fromPrefix: "/repo", toPrefix: "/x" },
      ])[0],
    ).toMatchObject({ worktreePathKey: "/x/w" });
  });
  it("PF1: escape、many-to-one、cross-path collisionを拒否する", () => {
    const identities = [
      { worktreePathKey: "/a/w", adminPathKey: "/a/g", headOid: "a", isMain: false },
      { worktreePathKey: "/b/w", adminPathKey: "/b/g", headOid: "b", isMain: false },
    ];
    expect(() =>
      remapTopologyIdentities(identities, [{ fromPrefix: "../a", toPrefix: "/x" }]),
    ).toThrow("escape");
    expect(() =>
      remapTopologyIdentities(identities, [
        { fromPrefix: "/a", toPrefix: "/x" },
        { fromPrefix: "/b", toPrefix: "/x" },
      ]),
    ).toThrow("collision");
    expect(() =>
      remapTopologyIdentities(
        [{ worktreePathKey: "/a/w", adminPathKey: "/b/w", headOid: "a", isMain: false }],
        [{ fromPrefix: "/a", toPrefix: "/b" }],
      ),
    ).toThrow("collision");
  });
});
