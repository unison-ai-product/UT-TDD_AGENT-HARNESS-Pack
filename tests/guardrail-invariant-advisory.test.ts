import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectGuardrailInvariants } from "../src/guardrail/ledger.ts";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";
import { removeTestTree } from "./support/temp-tree.ts";

describe("IT-GUARDRAIL-ADVISORY-01: invariant inspection and advisory retirement", () => {
  it("inspects review model pairs and human approval evidence", () => {
    const sameModel = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
      reviewer_model: "claude-opus-4-8",
      worker_model: "claude-opus-4-8",
    });
    expect(sameModel.violations.map((v) => v.rule)).toContain("same-model-self-review");
    expect(sameModel.normalizedDecision).toBe("block");

    const crossModel = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
      reviewer_model: "gpt-5.4",
      worker_model: "claude-opus-4-8",
    });
    expect(crossModel.violations).toHaveLength(0);

    const sameProvider = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
      reviewer_model: "claude-sonnet-4-6",
      worker_model: "claude-opus-4-8",
    });
    expect(sameProvider.violations.map((v) => v.rule)).toContain("same-provider-cross-review");
    expect(sameProvider.normalizedDecision).toBe("block");

    // Omitted reviewer and worker models leave model-pair checks inactive.
    const blank = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
    });
    expect(blank.violations).toHaveLength(0);

    const humanRequired = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "pii_scope",
      decision: "human-required",
      mode: "review",
      evidence_path: "",
    });
    expect(humanRequired.violations.map((v) => v.rule)).toContain(
      "human-required-without-evidence",
    );
  });

  it("preserves legacy review evidence and produces zero guardrail advisories on rebuild", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-guardrail-legacy-review-"));
    let db: ReturnType<typeof openHarnessDb> | undefined;
    try {
      db = openHarnessDb(":memory:");
      migrate(db);
      const legacyReview = {
        review_evidence_id: "review-evidence:PLAN-SAME-MODEL-CROSS",
        plan_id: "PLAN-SAME-MODEL-CROSS",
        kind: "impl",
        status: "confirmed",
        has_evidence: 1,
        review_kind: "cross_agent",
        verdict: "approve",
        reviewed_at: "2026-06-15T00:00:00Z",
        tests_green_at: "2026-06-15T00:00:00Z",
        worker_model: "claude-opus-4-8",
        reviewer_model: "claude-opus-4-8",
        source: "docs/plans/PLAN-SAME-MODEL-CROSS.md",
        indexed_at: "2026-06-15T00:00:00Z",
      };
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: legacyReview,
      });

      const legacyTable = db.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_evidence_registry'",
      );
      const reviewRows = db.prepare("SELECT * FROM review_evidence_registry");
      const beforeSchema = legacyTable.get();
      const beforeRows = reviewRows.all();
      expect(beforeSchema).toBeDefined();
      expect(beforeRows).toEqual([legacyReview]);

      expect(rebuildHarnessDb({ repoRoot, db, skipTokenTelemetry: true }).ok).toBe(true);

      expect(legacyTable.get()).toEqual(beforeSchema);
      expect(reviewRows.all()).toEqual(beforeRows);
      expect(
        db.prepare("SELECT kind FROM findings WHERE source = 'guardrail-invariant-advisory'").all(),
      ).toEqual([]);
    } finally {
      db?.close();
      removeTestTree(repoRoot);
    }
  });
});
