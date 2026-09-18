import { describe, expect, it } from "vitest";
import { headSnapshotRoot, workspaceRead } from "./support/workspace-roots.ts";

describe("repository test workspace roots", () => {
  it("U-TESTHYGIENE-012: exposes the detached HEAD snapshot as the sole repository read root", () => {
    expect(headSnapshotRoot()).not.toBe(process.cwd());
    expect(
      workspaceRead({
        id: "U-TESTHYGIENE-012",
        mode: "head_snapshot",
        reason: "repository source contract",
      }),
    ).toBe(headSnapshotRoot());
  });
});
