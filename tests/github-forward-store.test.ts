import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { clearRebuildableProjectionTables } from "../src/state-db/sqlite-projection-rebuild.ts";

describe("GitHub Forward SQLite store", () => {
  it("U-GHPROJ-012: keeps pending projection intent across rebuild clear", () => {
    const db = openHarnessDb(":memory:");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS github_projection_outbox (
          outbox_id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          plan_revision TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          last_error TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (repository_id, plan_id, plan_revision, operation)
        )
      `);
      migrate(db);
      const payload = JSON.stringify({
        owner: "unison-ai-product",
        projectNumber: 6,
        readiness: "着手可能",
        currentGate: "G7",
        headSha: "abcdef1",
      });
      const payloadDigest = createHash("sha256").update(payload).digest("hex");
      db.prepare(
        `INSERT INTO github_projection_outbox (
          outbox_id, repository_id, plan_id, plan_revision, operation, payload_json,
          payload_digest, status, attempt_count, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "test-outbox-012",
        "repo",
        "PLAN-L7-1-a",
        "rev1",
        "project-item-upsert",
        payload,
        payloadDigest,
        "pending",
        0,
        "",
        "2026-07-29T01:00:00Z",
        "2026-07-29T01:00:00Z",
      );
      clearRebuildableProjectionTables(db);
      const pending = db
        .prepare(
          "SELECT payload_json, payload_digest, status, attempt_count FROM github_projection_outbox",
        )
        .get();
      expect(pending).toEqual({
        payload_json: payload,
        payload_digest: payloadDigest,
        status: "pending",
        attempt_count: 0,
      });
    } finally {
      db.close();
    }
  });
});
