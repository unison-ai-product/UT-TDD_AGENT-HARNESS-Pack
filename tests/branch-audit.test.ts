import { describe, expect, it } from "vitest";
import { analyzeBranches, parseBranchRefs, renderBranchAudit } from "../src/audit/branches";

describe("branch audit", () => {
  it("keeps current/protected branches and marks gone or merged branches as delete candidates", () => {
    const result = analyzeBranches({
      currentBranch: "main",
      now: new Date("2026-06-23T00:00:00.000Z"),
      staleDays: 30,
      mergedBranchNames: ["feature/merged"],
      branches: [
        {
          name: "main",
          upstream: "origin/main",
          upstreamTrack: "",
          commitDate: "2026-06-22T00:00:00.000Z",
        },
        {
          name: "release/1.0",
          upstream: "origin/release/1.0",
          upstreamTrack: "",
          commitDate: "2026-06-01T00:00:00.000Z",
        },
        {
          name: "feature/gone",
          upstream: "origin/feature/gone",
          upstreamTrack: "[gone]",
          commitDate: "2026-06-01T00:00:00.000Z",
        },
        {
          name: "feature/merged",
          upstream: "origin/feature/merged",
          upstreamTrack: "",
          commitDate: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    expect(result.byStatus.keep).toBe(2);
    expect(result.byStatus["delete-candidate"]).toBe(2);
    expect(result.rows.find((row) => row.name === "feature/gone")).toMatchObject({
      status: "delete-candidate",
      reason: "gone",
    });
    expect(result.rows.find((row) => row.name === "release/1.0")).toMatchObject({
      status: "keep",
      reason: "protected",
    });
    expect(renderBranchAudit(result)).toContain("branch audit:");
  });

  it("marks old unmerged branches for review instead of delete", () => {
    const result = analyzeBranches({
      currentBranch: "main",
      now: new Date("2026-06-23T00:00:00.000Z"),
      staleDays: 30,
      mergedBranchNames: [],
      branches: [
        {
          name: "feature/old",
          upstream: "origin/feature/old",
          upstreamTrack: "",
          commitDate: "2026-04-01T00:00:00.000Z",
        },
      ],
    });

    expect(result.rows[0]).toMatchObject({ status: "review", reason: "stale" });
  });

  it("parses git for-each-ref rows", () => {
    expect(
      parseBranchRefs(
        "main\torigin/main\t\t2026-06-23T00:00:00+09:00\nfeature/x\torigin/feature/x\t[gone]\t2026-06-01T00:00:00+09:00\n",
      ),
    ).toEqual([
      {
        name: "main",
        upstream: "origin/main",
        upstreamTrack: "",
        commitDate: "2026-06-23T00:00:00+09:00",
      },
      {
        name: "feature/x",
        upstream: "origin/feature/x",
        upstreamTrack: "[gone]",
        commitDate: "2026-06-01T00:00:00+09:00",
      },
    ]);
  });
});
