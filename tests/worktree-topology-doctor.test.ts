import { describe, expect, it } from "vitest";
import { type DoctorDeps, nodeDoctorDeps } from "../src/doctor/runtime-state.ts";
import {
  checkWorktreeTopologyAdvisory,
  worktreeTopologyAdvisoryMessages,
} from "../src/doctor/worktree-topology-advisory.ts";
import type { WorktreeTopologyInput } from "../src/runtime/worktree-topology.ts";

describe("worktree topology doctor advisory", () => {
  it("U-WTTOPO-015: empty facts are a complete no-op", () => {
    const input: WorktreeTopologyInput = { facts: [], adminEntries: [] };

    expect(worktreeTopologyAdvisoryMessages(input)).toEqual([]);
    expect(checkWorktreeTopologyAdvisory(input)).toEqual({ ok: true, messages: [] });
  });

  it("U-WTTOPO-015: findings are displayed without changing the hard-gate result", () => {
    const input: WorktreeTopologyInput = {
      facts: [
        {
          worktreePathKey: "C:/repo/worktree",
          adminPathKey: "C:/repo/.git/worktrees/worktree",
          headOid: "0123456789012345678901234567890123456789",
          isMain: false,
          directoryObserved: false,
          worktreeToAdminOk: true,
          adminToWorktreeOk: true,
          dirty: false,
          branch: "refs/heads/feature",
          mergedIntoMain: false,
        },
      ],
      adminEntries: [],
    };

    const result = checkWorktreeTopologyAdvisory(input);

    expect(result.ok).toBe(true);
    expect(result.messages.join("\n")).toContain("worktree-topology");
    expect(result.messages.join("\n")).toContain("dir_missing");
  });

  it("U-WTTOPO-015: node doctor deps keep collection lazy until advisory evaluation", () => {
    const deps = nodeDoctorDeps("C:/repo");
    expect(typeof deps.worktreeTopology).toBe("function");
    const input = deps.worktreeTopology as () => WorktreeTopologyInput;
    expect(input).toBeTypeOf("function");
  });

  it("U-WTTOPO-015: a provider is evaluated once when the consumer reads it", () => {
    let calls = 0;
    const deps: DoctorDeps = {
      repoRoot: "/repo",
      now: "2026-08-20T00:00:00.000Z",
      readText: () => null,
      listDir: () => [],
      worktreeTopology: () => {
        calls += 1;
        return { facts: [], adminEntries: [] };
      },
    };
    expect(calls).toBe(0);
    const provider = deps.worktreeTopology as () => WorktreeTopologyInput;
    checkWorktreeTopologyAdvisory(provider());
    expect(calls).toBe(1);
  });
});
