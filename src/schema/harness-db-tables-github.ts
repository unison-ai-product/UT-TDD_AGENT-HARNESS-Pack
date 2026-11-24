import type { TableDef } from "./harness-db.ts";
import { pk, requiredCol } from "./harness-db-table-builders.ts";

export const HARNESS_DB_GITHUB_TABLES: TableDef[] = [
  {
    name: "github_project_item_projection",
    columns: [
      pk("projection_id"),
      requiredCol("repository_id"),
      requiredCol("project_id"),
      requiredCol("project_item_id"),
      requiredCol("plan_id"),
      requiredCol("plan_revision"),
      requiredCol("content_node_id"),
      requiredCol("head_sha"),
      requiredCol("sync_status"),
      requiredCol("last_reconciled_at"),
    ],
    unique: [["repository_id", "plan_id", "plan_revision"]],
  },
  {
    name: "github_object_bindings",
    columns: [
      pk("binding_id"),
      requiredCol("repository_id"),
      requiredCol("plan_id"),
      requiredCol("plan_revision"),
      requiredCol("project_item_id"),
      requiredCol("object_kind"),
      requiredCol("object_id"),
      requiredCol("object_url"),
      requiredCol("head_sha"),
      requiredCol("state"),
      requiredCol("observed_at"),
    ],
    unique: [["repository_id", "object_kind", "object_id"]],
  },
  {
    name: "github_projection_outbox",
    columns: [
      pk("outbox_id"),
      requiredCol("repository_id"),
      requiredCol("plan_id"),
      requiredCol("plan_revision"),
      requiredCol("operation"),
      requiredCol("payload_json"),
      requiredCol("payload_digest"),
      requiredCol("status"),
      requiredCol("attempt_count", "INTEGER"),
      requiredCol("last_error"),
      requiredCol("created_at"),
      requiredCol("updated_at"),
    ],
    unique: [["repository_id", "plan_id", "plan_revision", "operation"]],
  },
];
