import type { CheckExpression, TableDef } from "./harness-db.ts";
import { col, enumCheck, foreignKey, pk, requiredCol } from "./harness-db-table-builders.ts";

const dispositions = ["adopt", "merge", "reference", "defer", "not_applicable", "reject"];
const targetKinds = ["plan_alias", "artifact_family", "artifact_path", "target_slot"];
const itemStatuses = ["pending_review", ...dispositions];

const isNull = (column: string, negate = false): CheckExpression => ({
  kind: "is-null",
  column,
  ...(negate ? { negate } : {}),
});
const equals = (column: string, value: string): CheckExpression => ({
  kind: "compare",
  column,
  operator: "=",
  value,
});
const all = (...expressions: CheckExpression[]): CheckExpression => ({ kind: "and", expressions });
const any = (...expressions: CheckExpression[]): CheckExpression => ({ kind: "or", expressions });

export const HARNESS_DB_VMODEL_TABLES: TableDef[] = [
  {
    name: "vmodel_sources",
    columns: [
      pk("source_id"),
      requiredCol("ordinal", "INTEGER"),
      requiredCol("source_title"),
      requiredCol("disposition"),
      requiredCol("target_ref"),
      requiredCol("reason"),
      requiredCol("row_digest"),
      requiredCol("manifest_digest"),
    ],
    unique: [["ordinal"]],
    checks: [
      enumCheck("disposition", dispositions),
      { kind: "compare", column: "ordinal", operator: ">", value: 0 },
    ],
  },
  {
    name: "vmodel_categories",
    columns: [pk("category_id"), requiredCol("category_name"), requiredCol("row_digest")],
  },
  {
    name: "vmodel_meta_source_mappings",
    columns: [
      pk("meta_source_ref"),
      requiredCol("allowed_source_status"),
      requiredCol("source_file_policy"),
      requiredCol("reason"),
      requiredCol("row_digest"),
    ],
    checks: [enumCheck("source_file_policy", ["empty", "required"])],
  },
  {
    name: "vmodel_semantic_items",
    columns: [
      pk("item_id"),
      requiredCol("item_name"),
      requiredCol("category_id"),
      requiredCol("source_status"),
      requiredCol("source_ref"),
      requiredCol("source_file"),
      requiredCol("row_digest"),
    ],
    foreignKeys: [
      foreignKey(["category_id"], { table: "vmodel_categories", columns: ["category_id"] }),
    ],
  },
  {
    name: "vmodel_source_item_edges",
    columns: [
      pk("edge_id"),
      requiredCol("source_id"),
      requiredCol("item_id"),
      requiredCol("source_status"),
      requiredCol("source_file"),
      requiredCol("row_digest"),
    ],
    unique: [["source_id", "item_id"]],
    foreignKeys: [
      foreignKey(["item_id"], { table: "vmodel_semantic_items", columns: ["item_id"] }),
    ],
  },
  {
    name: "vmodel_source_target_edges",
    columns: [
      pk("edge_id"),
      requiredCol("source_id"),
      requiredCol("disposition"),
      requiredCol("target_type"),
      requiredCol("target_ref"),
      requiredCol("row_digest"),
    ],
    unique: [["source_id", "target_type", "target_ref"]],
    foreignKeys: [foreignKey(["source_id"], { table: "vmodel_sources", columns: ["source_id"] })],
    checks: [enumCheck("disposition", dispositions), enumCheck("target_type", targetKinds)],
  },
  {
    name: "vmodel_item_target_edges",
    columns: [
      pk("edge_id"),
      requiredCol("item_id"),
      requiredCol("target_status"),
      col("target_kind"),
      col("target_ref"),
      col("plan_id"),
      requiredCol("reason"),
      requiredCol("source_digest"),
    ],
    unique: [["item_id"]],
    foreignKeys: [
      foreignKey(["item_id"], { table: "vmodel_semantic_items", columns: ["item_id"] }),
      foreignKey(["plan_id"], { table: "plan_registry", columns: ["plan_id"] }),
    ],
    checks: [
      enumCheck("target_status", itemStatuses),
      any(isNull("target_kind"), enumCheck("target_kind", targetKinds)),
      any(
        all(equals("target_status", "pending_review"), isNull("target_kind"), isNull("target_ref")),
        all(
          enumCheck("target_status", ["adopt", "merge", "reference", "defer"]),
          isNull("target_kind", true),
          isNull("target_ref", true),
        ),
        enumCheck("target_status", ["not_applicable", "reject"]),
      ),
      any({ kind: "not", expression: equals("target_status", "defer") }, isNull("plan_id", true)),
    ],
  },
  {
    name: "document_scale_profiles",
    columns: [
      pk("profile_id"),
      requiredCol("profile_axis"),
      requiredCol("profile_rank", "INTEGER"),
      requiredCol("description"),
      requiredCol("default_status"),
      requiredCol("default_detail"),
      requiredCol("scope_policy"),
      requiredCol("row_digest"),
    ],
    unique: [["profile_axis", "profile_rank"]],
    checks: [
      enumCheck("profile_axis", ["size", "product"]),
      enumCheck("default_status", [
        "minimal",
        "standard",
        "required",
        "profile_controlled",
        "skipped",
      ]),
      enumCheck("default_detail", ["lite", "standard", "detailed"]),
    ],
  },
];
