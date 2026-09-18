import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { analyzeTraceImpact } from "../src/trace/impact.ts";

function insertSpec(
  db: ReturnType<typeof openHarnessDb>,
  specId: string,
  specKind: string,
  layer = "L6",
): void {
  upsertRow(db, {
    table: "spec_defs",
    primaryKey: "spec_id",
    row: {
      spec_id: specId,
      spec_kind: specKind,
      layer,
      sub_doc: "function-spec",
      owner_artifact_id: specId,
      owner_path: `docs/${specId}.md`,
      section_anchor: `spec.defines:${specId}`,
      title: specId,
      lifecycle_status: "confirmed",
      plan_id: "",
      source_path: `docs/${specId}.md`,
      source_hash: `sha256:${specId}`,
      indexed_at: "2026-07-08T00:00:00.000Z",
    },
  });
}

function insertRelation(
  db: ReturnType<typeof openHarnessDb>,
  from: string,
  relationKind: string,
  to: string,
): void {
  upsertRow(db, {
    table: "spec_relations",
    primaryKey: "relation_id",
    row: {
      relation_id: `spec-relation:${from}:${relationKind}:${to}`,
      from_spec_id: from,
      to_spec_id: to,
      relation_kind: relationKind,
      plan_id: "PLAN-L6-60-trace-impact-traversal-command",
      status: "active",
      source: "tests/trace-impact.test.ts",
      evidence_path: `${from}.${relationKind}.${to}`,
      indexed_at: "2026-07-08T00:00:00.000Z",
    },
  });
}

describe("trace impact traversal", () => {
  it("traverses typed spec IDs from a changed design ID to downstream specs and tests", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSpec(db, "REQ-001", "requirement", "L1");
      insertSpec(db, "VMS-001", "typed-source", "L6");
      insertSpec(db, "VMS-002", "typed-projection", "L7");
      insertSpec(db, "TVMS-001", "unit-oracle", "L7");
      insertRelation(db, "VMS-001", "traces_from", "REQ-001");
      insertRelation(db, "VMS-001", "traces_to", "VMS-002");
      insertRelation(db, "VMS-001", "tests", "TVMS-001");

      const result = analyzeTraceImpact(db, "VMS-001");

      expect(result.ok).toBe(true);
      expect(result.root).toMatchObject({ spec_id: "VMS-001" });
      expect(result.upstream.map((node) => node.spec_id)).toEqual(["REQ-001"]);
      expect(result.downstream.map((node) => node.spec_id)).toEqual(["VMS-002"]);
      expect(result.tests.map((node) => node.spec_id)).toEqual(["TVMS-001"]);
      expect(result.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from_spec_id: "REQ-001", to_spec_id: "VMS-001" }),
          expect.objectContaining({ from_spec_id: "VMS-001", to_spec_id: "VMS-002" }),
          expect.objectContaining({ from_spec_id: "VMS-001", to_spec_id: "TVMS-001" }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("fails closed when the requested spec ID is absent", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSpec(db, "VMS-001", "typed-source");

      const result = analyzeTraceImpact(db, "VMS-NOPE");

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "trace-impact-root-missing",
            severity: "error",
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });
});
