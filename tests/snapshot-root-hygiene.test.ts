/**
 * 共有の os.tmpdir() を数えるテストの衛生 (issue #1665 の Red)。
 * 契約: docs/design/harness/L6-function-design/snapshot-runner-lock.md §10、
 * oracle: docs/test-design/harness/L7-snapshot-runner-lock-test-design.md §3.4。
 */
import { describe, expect, it } from "vitest";
import { redWithPreparationPair } from "./support/red-pair.ts";
import { ownSnapshotRootEntries } from "./support/snapshot-root-entries.ts";

describe("snapshot root hygiene", () => {
  it("exposes the helper", () => {
    expect(typeof ownSnapshotRootEntries).toBe("function");
  });

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-029: only this pid's snapshot roots are returned",
    (t) => {
      const names = [
        "ut-tdd-vitest-123-1",
        "ut-tdd-vitest-head-123-1",
        "ut-tdd-vitest-cache-123-1",
        "ut-tdd-vitest-456-1",
        "ut-tdd-vitest-1230-1",
        "ut-tdd-vitest-leases",
        "ut-tdd-snapshot-runner-lock",
        "other",
      ];
      t.expect(ownSnapshotRootEntries(names, 123)).toEqual(names.slice(0, 3));
    },
  );
});
