import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate } from "../src/state-db/migration";

function seedQueue(db: ReturnType<typeof openHarnessDb>): void {
  upsertRow(db, {
    table: "issue_queue",
    primaryKey: "issue_queue_id",
    row: {
      issue_queue_id: "queue-1",
      source_event_id: "feedback-1",
      plan_id: "",
      target: "github",
      title: "[ut-tdd telemetry] trouble_event_rate",
      body: "Review trouble_event_rate.",
      status: "queued_dry_run",
      human_approval_required: 1,
      approved_by: "",
      approved_at: "",
      external_issue_id: "",
      external_issue_url: "",
      created_at: "2026-06-12T00:00:00.000Z",
    },
  });
}

describe("GitHub issue queue evidence", () => {
  it("keeps queued GitHub issues as dry-run evidence until an external back-reference is recorded", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedQueue(db);

      const row = db.prepare("SELECT * FROM issue_queue WHERE issue_queue_id = ?").get("queue-1");

      expect(row).toMatchObject({
        target: "github",
        status: "queued_dry_run",
        human_approval_required: 1,
        external_issue_id: "",
        external_issue_url: "",
      });
    } finally {
      db.close();
    }
  });

  it("records only externally supplied issue back-references without creating GitHub issues", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedQueue(db);

      db.prepare(
        `UPDATE issue_queue
           SET status = ?,
               human_approval_required = 0,
               approved_by = ?,
               approved_at = ?,
               external_issue_id = ?,
               external_issue_url = ?
         WHERE issue_queue_id = ?`,
      ).run(
        "created",
        "po",
        "2026-06-12T01:02:03.000Z",
        "123",
        "https://github.com/owner/repo/issues/123",
        "queue-1",
      );

      const row = db.prepare("SELECT * FROM issue_queue WHERE issue_queue_id = ?").get("queue-1");
      expect(row).toMatchObject({
        status: "created",
        human_approval_required: 0,
        approved_by: "po",
        approved_at: "2026-06-12T01:02:03.000Z",
        external_issue_id: "123",
        external_issue_url: "https://github.com/owner/repo/issues/123",
      });
    } finally {
      db.close();
    }
  });
});
