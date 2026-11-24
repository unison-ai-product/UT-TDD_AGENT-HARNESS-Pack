import { describe, expect, it } from "vitest";
import {
  CandidatePreconditionFailure,
  verifySnapshotCandidate,
} from "./support/snapshot-candidate.ts";

describe("snapshot candidate verification failure safety", () => {
  it("throws when the fixture precondition is not met", async () => {
    await expect(
      verifySnapshotCandidate(
        "helper-precondition",
        () => {},
        async () => {
          throw new CandidatePreconditionFailure("fixture was unavailable");
        },
      ),
    ).rejects.toThrow("fixture was unavailable");
  });

  it("throws when setup fails before contract assertions are reached", async () => {
    await expect(
      verifySnapshotCandidate(
        "helper-pre-assertion",
        () => {},
        async () => {
          throw new Error("runner harness setup failed");
        },
      ),
    ).rejects.toThrow("runner harness setup failed");
  });

  it("throws when the action completes without reaching contract assertions", async () => {
    await expect(
      verifySnapshotCandidate(
        "helper-no-assertions",
        () => {},
        async () => {},
      ),
    ).rejects.toThrow("completed without reaching contract assertions");
  });

  it("throws when cleanup fails after contract assertions are reached", async () => {
    await expect(
      verifySnapshotCandidate(
        "helper-cleanup",
        () => {
          throw new Error("fixture cleanup failed");
        },
        async (assertionsReached) => {
          assertionsReached();
        },
      ),
    ).rejects.toThrow("fixture cleanup failed");
  });
});
