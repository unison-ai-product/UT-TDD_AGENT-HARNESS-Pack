import { HARNESS_DB_TABLES } from "../schema/harness-db.ts";
import type { HarnessDb } from "./index.ts";

const REBUILD_PERSISTENT_TABLES = new Set([
  "refactor_candidates",
  "github_object_bindings",
  "github_project_item_projection",
  "github_projection_outbox",
]);

/** 再構築可能な投影だけをFK逆順で消去し、永続負債ledgerは保持する。 */
export function clearRebuildableProjectionTables(db: HarnessDb): void {
  for (const table of [...HARNESS_DB_TABLES].reverse()) {
    if (REBUILD_PERSISTENT_TABLES.has(table.name)) continue;
    db.prepare(`DELETE FROM ${table.name}`).run();
  }
}
