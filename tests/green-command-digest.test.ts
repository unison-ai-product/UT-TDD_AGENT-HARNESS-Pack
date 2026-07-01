import { describe, expect, it } from "vitest";
import {
  auditGreenCommandDigests,
  type DigestAuditDeps,
  greenCommandDigestMessages,
} from "../src/lint/green-command-digest";
import type { ParsedReviewPlan } from "../src/lint/review-evidence";

function plan(
  planId: string,
  greenCommands: { evidence_path: string; output_digest: string }[],
): ParsedReviewPlan {
  return {
    file: `docs/plans/${planId}.md`,
    plan_id: planId,
    kind: "impl",
    status: "confirmed",
    updated: "2026-06-23",
    hasEvidence: true,
    crossEntries: [
      {
        review_kind: "intra_runtime_subagent",
        green_commands: greenCommands.map((g) => ({
          kind: "unit_test",
          command: "bun test",
          runner: "bun",
          scope: "targeted",
          exit_code: 0,
          evidence_path: g.evidence_path,
          output_digest: g.output_digest,
        })),
      },
    ],
  };
}

// deterministic fake content store + hash
const STORE: Record<string, string> = {
  "tests/real.test.ts": "real-content",
};
const deps: DigestAuditDeps = {
  readBytes: (p) => (p in STORE ? Buffer.from(STORE[p]) : null),
  // fake hash = "sha256:" + reversed content padded — deterministic, not real sha256, fine for the unit.
  hash: (bytes) => `sha256:${Buffer.from(bytes).toString("hex")}`,
};

describe("green-command-digest (PLAN-L7-132) — digest 実体検査", () => {
  const realDigest = `sha256:${Buffer.from("real-content").toString("hex")}`;

  it("passes when output_digest matches the real hash of evidence_path", () => {
    const mismatches = auditGreenCommandDigests(
      [plan("PLAN-OK", [{ evidence_path: "tests/real.test.ts", output_digest: realDigest }])],
      deps,
    );
    expect(mismatches).toEqual([]);
  });

  it("flags a fake/placeholder digest as digest-mismatch (the L7-110/114 hole)", () => {
    const mismatches = auditGreenCommandDigests(
      [
        plan("PLAN-FAKE", [
          { evidence_path: "tests/real.test.ts", output_digest: "sha256:110feedbac000001" },
        ]),
      ],
      deps,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.reason).toBe("digest-mismatch");
    expect(mismatches[0]?.plan_id).toBe("PLAN-FAKE");
  });

  it("flags a missing evidence_path file", () => {
    const mismatches = auditGreenCommandDigests(
      [
        plan("PLAN-GONE", [
          { evidence_path: "tests/missing.test.ts", output_digest: "sha256:abc123abc123abc1" },
        ]),
      ],
      deps,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.reason).toBe("file-missing");
    expect(mismatches[0]?.actual).toBe("");
  });

  it("skips entries with empty path or digest", () => {
    const mismatches = auditGreenCommandDigests(
      [plan("PLAN-EMPTY", [{ evidence_path: "", output_digest: "" }])],
      deps,
    );
    expect(mismatches).toEqual([]);
  });

  it("renders an OK message when clean and a note when mismatched (non-breaking advisory)", () => {
    expect(greenCommandDigestMessages([])[0]).toContain("OK");
    const note = greenCommandDigestMessages([
      {
        plan_id: "PLAN-FAKE",
        evidence_path: "tests/real.test.ts",
        claimed: "sha256:dead",
        actual: "sha256:beef",
        reason: "digest-mismatch",
      },
    ])[0];
    expect(note).toContain("note:");
    expect(note).toContain("PLAN-FAKE");
  });
});
