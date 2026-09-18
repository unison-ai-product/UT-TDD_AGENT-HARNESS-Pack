import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeWorktreeTopology,
  topologyDigest,
  type WorktreeFact,
} from "../src/runtime/worktree-topology.ts";
import { evaluateTopologyMigration } from "../src/runtime/worktree-topology-migration.ts";

const oid = "0".repeat(40);

function fact(overrides: Partial<WorktreeFact> = {}): WorktreeFact {
  return {
    worktreePathKey: "/before/worktree-a",
    adminPathKey: "/before/.git/worktrees/a",
    headOid: oid,
    isMain: false,
    directoryObserved: true,
    worktreeToAdminOk: true,
    adminToWorktreeOk: true,
    dirty: false,
    branch: "feature/a",
    mergedIntoMain: false,
    ...overrides,
  };
}

function report(facts: WorktreeFact[]) {
  return analyzeWorktreeTopology({
    facts,
    adminEntries: facts
      .filter((item) => !item.isMain)
      .map((item) => ({ adminPathKey: item.adminPathKey, registered: true })),
  });
}

describe("worktree topology PF4 migration acceptance", () => {
  it("U-WTTOPO-013: 同じhealthy件数でもidentity集合が変われば移設を拒否する", () => {
    const before = report([fact()]);
    const after = report([
      fact({
        worktreePathKey: "/after/worktree-c",
        adminPathKey: "/after/.git/worktrees/c",
      }),
    ]);

    expect(before.healthy).toBe(after.healthy);
    expect(
      evaluateTopologyMigration({
        before,
        after,
        remaps: [{ fromPrefix: "/before", toPrefix: "/after" }],
      }),
    ).toMatchObject({ accepted: false, reason: "identity_mismatch" });
    expect(
      evaluateTopologyMigration({
        before,
        after: { ...after, digest: topologyDigest(before.identities) },
        remaps: [{ fromPrefix: "/before", toPrefix: "/after" }],
      }),
    ).toMatchObject({ accepted: false, reason: "identity_mismatch" });
  });

  it("U-WTTOPO-013: findings 0かつ許可remap後の集合一致だけを受理する", () => {
    const before = report([fact()]);
    const after = report([
      fact({
        worktreePathKey: "/after/worktree-a",
        adminPathKey: "/after/.git/worktrees/a",
      }),
    ]);

    expect(
      evaluateTopologyMigration({
        before,
        after,
        remaps: [{ fromPrefix: "/before", toPrefix: "/after" }],
      }),
    ).toMatchObject({ accepted: true, reason: "accepted" });
    expect(
      evaluateTopologyMigration({
        before,
        after: {
          ...after,
          findings: [
            {
              kind: "link_broken",
              operation: "test",
              evidenceCode: "injected",
              worktreePathKey: "/after/worktree-a",
            },
          ],
        },
        remaps: [{ fromPrefix: "/before", toPrefix: "/after" }],
      }),
    ).toMatchObject({ accepted: false, reason: "findings_present" });
  });

  it("U-WTTOPO-018: 文書のliteral byte vectorとdigestを固定し、安全でないremapを拒否する", () => {
    const preimage = Buffer.from(
      "746f706f6c6f67792d76313a000000052f7265706f0000000a2f7265706f2f2e67697400000028303030303030303030303030303030303030303030303030303030303030303030303030303030300000000131",
      "hex",
    );
    const expected = "73dd51f0db31880e84c9135c1f02558837ec85b95fa186372d4d358008db6758";
    const identity = {
      worktreePathKey: "/repo",
      adminPathKey: "/repo/.git",
      headOid: oid,
      isMain: true,
    };
    const secondByte = preimage.at(1);
    if (secondByte === undefined) throw new Error("preimage must have a second byte");

    expect(createHash("sha256").update(preimage).digest("hex")).toBe(expected);
    expect(topologyDigest([identity])).toBe(expected);
    for (const mutate of [
      Buffer.concat([preimage.subarray(0, 1), Buffer.from([secondByte ^ 1]), preimage.subarray(2)]),
      Buffer.concat([preimage.subarray(0, 12), Buffer.from([1, 0, 0, 0]), preimage.subarray(16)]),
    ])
      expect(createHash("sha256").update(mutate).digest("hex")).not.toBe(expected);

    const same = report([fact()]);
    expect(
      evaluateTopologyMigration({
        before: same,
        after: same,
        remaps: [{ fromPrefix: "../before", toPrefix: "/after" }],
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_remap" });
    expect(
      evaluateTopologyMigration({
        before: same,
        after: same,
        remaps: [
          { fromPrefix: "/before", toPrefix: "/after" },
          { fromPrefix: "/before", toPrefix: "/other" },
        ],
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_remap" });
  });
});
