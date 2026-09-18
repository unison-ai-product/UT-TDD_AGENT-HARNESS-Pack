import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GitAuthoringProvenance } from "../../src/disposition/adapters/git-authoring-provenance.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";
import { migrate } from "../../src/state-db/migration.ts";
import { projectVmodelAuthoring } from "../../src/state-db/vmodel-projections.ts";

const tables = [
  "vmodel_sources",
  "vmodel_categories",
  "vmodel_meta_source_mappings",
  "vmodel_semantic_items",
  "vmodel_source_item_edges",
  "vmodel_source_target_edges",
  "vmodel_item_target_edges",
  "document_scale_profiles",
] as const;

describe("I-DISP-001 V-model projection", () => {
  it("materializes exact tracked identities and is a delete/rebuild fixed point", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db);
      projectVmodelAuthoring(process.cwd(), db);
      expect(count(db, "vmodel_sources")).toBe(109);
      expect(count(db, "vmodel_categories")).toBe(21);
      expect(count(db, "vmodel_meta_source_mappings")).toBe(1);
      expect(count(db, "vmodel_semantic_items")).toBe(163);
      expect(count(db, "vmodel_item_target_edges")).toBe(163);
      expect(
        Number(
          db
            .prepare("SELECT COUNT(*) AS count FROM findings WHERE source = ?")
            .get("vmodel-item-target")?.count ?? 0,
        ),
      ).toBe(163);
      expect(count(db, "document_scale_profiles")).toBe(8);
      const first = snapshot(db);
      projectVmodelAuthoring(process.cwd(), db);
      expect(snapshot(db)).toEqual(first);
      clear(db);
      projectVmodelAuthoring(process.cwd(), db);
      expect(snapshot(db)).toEqual(first);
    } finally {
      db.close();
    }
  });

  it("rolls back deletion when tracked provenance is tampered", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db);
      projectVmodelAuthoring(process.cwd(), db);
      const before = snapshot(db);
      const provenance = new GitAuthoringProvenance(process.cwd());
      let projectionFailure: unknown;
      db.exec("BEGIN IMMEDIATE");
      try {
        clear(db);
        projectVmodelAuthoring(process.cwd(), db, {
          provenance,
          read: (path) =>
            path.endsWith("vmodel-source-manifest.md")
              ? new TextEncoder().encode("tampered")
              : readFileSync(path),
        });
      } catch (error) {
        projectionFailure = error;
      } finally {
        db.exec("ROLLBACK");
      }
      expect(projectionFailure).toBeInstanceOf(Error);
      expect(String(projectionFailure)).toContain("catalog-provenance-invalid");
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

function seedPlan(db: ReturnType<typeof openHarnessDb>): void {
  db.prepare("INSERT INTO plan_registry (plan_id) VALUES (?)").run(
    "PLAN-L7-417-source-disposition-profile-projection",
  );
}

function count(db: ReturnType<typeof openHarnessDb>, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function snapshot(db: ReturnType<typeof openHarnessDb>) {
  return {
    ...Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
    ),
    findings: db
      .prepare("SELECT * FROM findings WHERE source = ? ORDER BY finding_id")
      .all("vmodel-item-target"),
  };
}

function clear(db: ReturnType<typeof openHarnessDb>): void {
  for (const table of [...tables].reverse()) db.exec(`DELETE FROM ${table}`);
  db.prepare("DELETE FROM findings WHERE source = ?").run("vmodel-item-target");
}
