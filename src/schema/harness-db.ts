import { HARNESS_DB_INDEXES, HARNESS_DB_TABLES } from "./harness-db-catalog";

export { HARNESS_DB_INDEXES, HARNESS_DB_TABLES } from "./harness-db-catalog";

/**
 * harness.db projection schema — 単一正本 (PLAN-L7-45, 工程表 PLAN-L7-44 span ①)。
 *
 * `.ut-tdd/harness.db` の projection table を **TS の table registry として単一正本化**する。
 * migration (src/state-db/migration.ts) はこの registry から DDL を生成し、projection-writer
 * (span ②) はこの registry の列名で行を書く。table 追加は registry への append + SCHEMA_VERSION
 * bump の 1 箇所で済む (CLAUDE.md: ハードコード単一正本化 / 将来拡張容易性)。
 *
 * 設計正本: docs/design/harness/L5-detailed-design/physical-data.md §2.7 (基本 7) + §9.1 (拡張 10)。
 * 本 span は core 17 table を載せる。§9.4-§9.7 (UT evidence / relation-graph / MCP / doc-export) の
 * projection table は、それぞれの射影を配線する span (46+) が registry に追記する。
 *
 * 注: physical-data.md は列を列挙するが SQLite 型を明示しない。id/path/status/timestamp 系を TEXT、
 * value/threshold/score を REAL、真偽/件数/rank を INTEGER として型付けする (SQLite は動的型のため
 * affinity ヒント)。各 table の列・PK・index は §2.7/§9.1/§9.3 に準拠。
 */

export const SCHEMA_VERSION = 19;

export type ColumnType = "TEXT" | "INTEGER" | "REAL";

export interface ColumnDef {
  name: string;
  type: ColumnType;
  /** PRIMARY KEY 列 (1 table 1 列、physical-data の PK に準拠)。 */
  primaryKey?: boolean;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
}

export interface IndexDef {
  name: string;
  table: string;
  columns: string[];
}

/**
 * SQL 識別子検証 (injection 防止)。table / column / index 名は ? でバインドできず DDL/DML に
 * 文字列展開するため、英数字 + アンダースコアの正規識別子のみ許可する (値は別途バインド)。
 * schema (安定核) に置き、state-db adapter からも再利用する (単一正本)。
 */
export const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertSqlIdentifier(name: string): void {
  if (!SQL_IDENTIFIER.test(name)) {
    throw new Error(`不正な SQL 識別子 (英数字/アンダースコアのみ許可): ${name}`);
  }
}

export const HARNESS_DB_TABLE_BY_NAME: ReadonlyMap<string, TableDef> = new Map(
  HARNESS_DB_TABLES.map((t) => [t.name, t]),
);

/** CREATE TABLE DDL を registry から生成 (deterministic、IF NOT EXISTS)。 */
export function createTableSql(table: TableDef): string {
  const cols = table.columns.map((c) => {
    const constraint = c.primaryKey ? " PRIMARY KEY" : "";
    return `  ${c.name} ${c.type}${constraint}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${cols.join(",\n")}\n)`;
}

/** CREATE INDEX DDL。 */
export function createIndexSql(index: IndexDef): string {
  return `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table} (${index.columns.join(", ")})`;
}

/** schema 全体の DDL 文 (table → index の順、deterministic)。 */
export function schemaDdl(): string[] {
  return [...HARNESS_DB_TABLES.map(createTableSql), ...HARNESS_DB_INDEXES.map(createIndexSql)];
}
// registry identifiers are validated at module load so invalid DDL fails before projection writes.
for (const table of HARNESS_DB_TABLES) {
  assertSqlIdentifier(table.name);
  for (const column of table.columns) assertSqlIdentifier(column.name);
}
for (const index of HARNESS_DB_INDEXES) {
  assertSqlIdentifier(index.name);
  assertSqlIdentifier(index.table);
  for (const column of index.columns) assertSqlIdentifier(column);
}

export function primaryKeyOf(table: TableDef): string {
  const key = table.columns.find((c) => c.primaryKey);
  if (!key) throw new Error(`table ${table.name} has no primary key column`);
  return key.name;
}
