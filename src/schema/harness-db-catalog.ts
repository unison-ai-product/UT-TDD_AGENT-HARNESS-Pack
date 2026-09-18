import { HARNESS_DB_INDEXES } from "./harness-db-indexes.ts";
import { HARNESS_DB_CORE_TABLES } from "./harness-db-tables-core.ts";
import { HARNESS_DB_EVALUATION_TABLES } from "./harness-db-tables-evaluation.ts";
import { HARNESS_DB_GITHUB_TABLES } from "./harness-db-tables-github.ts";
import { HARNESS_DB_GRAPH_EXPORT_TABLES } from "./harness-db-tables-graph.ts";
import { HARNESS_DB_SPEC_IR_TABLES } from "./harness-db-tables-spec-ir.ts";
import { HARNESS_DB_VMODEL_TABLES } from "./harness-db-tables-vmodel.ts";

export const HARNESS_DB_TABLES = [
  ...HARNESS_DB_CORE_TABLES,
  ...HARNESS_DB_GRAPH_EXPORT_TABLES,
  ...HARNESS_DB_GITHUB_TABLES,
  ...HARNESS_DB_EVALUATION_TABLES,
  ...HARNESS_DB_VMODEL_TABLES,
  ...HARNESS_DB_SPEC_IR_TABLES,
];

export { HARNESS_DB_INDEXES };
