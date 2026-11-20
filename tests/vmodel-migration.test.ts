import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/schema/harness-db.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";

const LEGACY_V25_PROJECTION_DDLS = [
  "CREATE TABLE document_catalog_entries (document_catalog_entry_id TEXT PRIMARY KEY, doc_type_id TEXT)",
  "CREATE TABLE document_scale_profile_entries (document_scale_profile_entry_id TEXT PRIMARY KEY, profile_id TEXT, doc_type_id TEXT)",
  "CREATE TABLE document_scale_profile_reviews (document_scale_profile_review_id TEXT PRIMARY KEY)",
] as const;

function createV25LegacyProjectionTables(db: ReturnType<typeof openHarnessDb>): void {
  for (const ddl of LEGACY_V25_PROJECTION_DDLS) db.exec(ddl);
}

describe("V-model version 26 projection migration", () => {
  it("rebuilds derived profile tables with typed constraints instead of nullable ALTER", () => {
    const db = openHarnessDb(":memory:");
    try {
      createV25LegacyProjectionTables(db);
      db.exec("INSERT INTO document_catalog_entries VALUES ('old','DOC-OLD')");
      db.setUserVersion(25);
      const result = migrate(db);
      expect(result.toVersion).toBe(SCHEMA_VERSION);
      expect(
        db
          .prepare("PRAGMA table_info(document_scale_profile_entries)")
          .all()
          .map((row) => row.name),
      ).toContain("row_digest");
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM document_catalog_entries").get()?.count,
      ).toBe(0);
      expect(() =>
        db.exec(
          "INSERT INTO document_scale_profile_entries (document_scale_profile_entry_id,profile_id,doc_type_id,decision,detail_override,status_override,reason,row_digest,source_path,indexed_at) VALUES ('e','missing','DOC-OLD','adopt','standard','required','r','d','p','t')",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
