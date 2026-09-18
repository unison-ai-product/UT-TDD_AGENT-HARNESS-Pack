import { HARNESS_DB_INDEXES, HARNESS_DB_TABLES } from "./harness-db-catalog.ts";

export { HARNESS_DB_INDEXES, HARNESS_DB_TABLES } from "./harness-db-catalog.ts";

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

export const SCHEMA_VERSION = 29;

export type ColumnType = "TEXT" | "INTEGER" | "REAL";

export type ReferentialAction = "CASCADE" | "RESTRICT" | "SET NULL" | "NO ACTION";

export interface ColumnReference {
  table: string;
  column: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export type CheckScalar = string | number;

/** raw SQLを受け取らずにCHECKを表現する閉じた式木。 */
export type CheckExpression =
  | { kind: "in"; column: string; values: readonly CheckScalar[] }
  | {
      kind: "compare";
      column: string;
      operator: "=" | "!=" | "<" | "<=" | ">" | ">=";
      value: CheckScalar;
    }
  | { kind: "not-contains"; column: string; value: string }
  | { kind: "is-null"; column: string; negate?: boolean }
  | { kind: "and"; expressions: readonly CheckExpression[] }
  | { kind: "or"; expressions: readonly CheckExpression[] }
  | { kind: "not"; expression: CheckExpression };

export interface ForeignKeyDef {
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export interface ColumnDef {
  name: string;
  type: ColumnType;
  /** PRIMARY KEY 列 (1 table 1 列、physical-data の PK に準拠)。 */
  primaryKey?: boolean;
  notNull?: boolean;
  references?: ColumnReference;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  /** 2列以上の複合PK。既存のColumnDef.primaryKeyとの併用は禁止。 */
  primaryKey?: readonly string[];
  unique?: readonly (readonly string[])[];
  checks?: readonly CheckExpression[];
  foreignKeys?: readonly ForeignKeyDef[];
}

export interface IndexDef {
  name: string;
  table: string;
  columns: string[];
  unique?: boolean;
  predicate?: IndexPredicate;
}

export type IndexPredicate =
  | { kind: "is-null"; column: string }
  | { kind: "equals"; column: string; value: CheckScalar };

export interface TriggerDef {
  name: string;
  table: string;
  timing: "BEFORE";
  event: "UPDATE" | "DELETE";
  action: { kind: "raise-abort"; message: string };
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

function assertKnownColumns(table: TableDef, columns: readonly string[], subject: string): void {
  if (columns.length === 0) throw new Error(`${table.name} ${subject} の列が空です`);
  const known = new Set(table.columns.map((column) => column.name));
  for (const column of columns) {
    assertSqlIdentifier(column);
    if (!known.has(column)) throw new Error(`${table.name} ${subject} の未知列: ${column}`);
  }
}

function validateCheck(table: TableDef, expression: CheckExpression): void {
  if (expression.kind === "and" || expression.kind === "or") {
    if (expression.expressions.length === 0) {
      throw new Error(`${table.name} CHECK ${expression.kind} の式が空です`);
    }
    for (const child of expression.expressions) validateCheck(table, child);
    return;
  }
  if (expression.kind === "not") {
    validateCheck(table, expression.expression);
    return;
  }
  assertKnownColumns(table, [expression.column], "CHECK");
  if (expression.kind === "in" && expression.values.length === 0) {
    throw new Error(`${table.name} CHECK IN の値が空です`);
  }
  if (expression.kind === "not-contains" && expression.value.length === 0) {
    throw new Error(`${table.name} CHECK not-contains の値が空です`);
  }
  const values =
    expression.kind === "in"
      ? expression.values
      : expression.kind === "compare"
        ? [expression.value]
        : expression.kind === "not-contains"
          ? [expression.value]
          : [];
  for (const value of values) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${table.name} CHECK に有限でない数値は使えません`);
    }
  }
}

export function validateTableDef(table: TableDef): void {
  assertSqlIdentifier(table.name);
  if (table.columns.length === 0) throw new Error(`${table.name} の列が空です`);
  const names = new Set<string>();
  for (const column of table.columns) {
    assertSqlIdentifier(column.name);
    if (names.has(column.name))
      throw new Error(`${table.name} の列が重複しています: ${column.name}`);
    names.add(column.name);
    if (column.references) {
      assertSqlIdentifier(column.references.table);
      assertSqlIdentifier(column.references.column);
    }
  }
  const inlineKeys = table.columns
    .filter((column) => column.primaryKey)
    .map((column) => column.name);
  if (inlineKeys.length > 1 || (inlineKeys.length > 0 && table.primaryKey)) {
    throw new Error(`${table.name} のPRIMARY KEY定義が競合しています`);
  }
  if (table.primaryKey) {
    if (table.primaryKey.length < 2)
      throw new Error(`${table.name} の複合PRIMARY KEYは2列以上必要です`);
    assertKnownColumns(table, table.primaryKey, "PRIMARY KEY");
    if (new Set(table.primaryKey).size !== table.primaryKey.length) {
      throw new Error(`${table.name} のPRIMARY KEY列が重複しています`);
    }
  }
  for (const columns of table.unique ?? []) {
    assertKnownColumns(table, columns, "UNIQUE");
    if (new Set(columns).size !== columns.length)
      throw new Error(`${table.name} のUNIQUE列が重複しています`);
  }
  for (const foreignKey of table.foreignKeys ?? []) {
    assertKnownColumns(table, foreignKey.columns, "FOREIGN KEY");
    assertSqlIdentifier(foreignKey.referencedTable);
    for (const column of foreignKey.referencedColumns) assertSqlIdentifier(column);
    if (foreignKey.columns.length !== foreignKey.referencedColumns.length) {
      throw new Error(`${table.name} のFOREIGN KEY列数が一致しません`);
    }
  }
  for (const check of table.checks ?? []) validateCheck(table, check);
}

export const HARNESS_DB_TABLE_BY_NAME: ReadonlyMap<string, TableDef> = new Map(
  HARNESS_DB_TABLES.map((t) => [t.name, t]),
);

/** CREATE TABLE DDL を registry から生成 (deterministic、IF NOT EXISTS)。 */
export function createTableSql(table: TableDef): string {
  validateTableDef(table);
  const cols = table.columns.map((c) => {
    const constraints = [
      c.primaryKey ? "PRIMARY KEY" : "",
      c.notNull ? "NOT NULL" : "",
      c.references ? renderReference(c.references) : "",
    ].filter(Boolean);
    return `  ${c.name} ${c.type}${constraints.length > 0 ? ` ${constraints.join(" ")}` : ""}`;
  });
  const constraints = [
    ...(table.primaryKey ? [`  PRIMARY KEY (${table.primaryKey.join(", ")})`] : []),
    ...(table.unique ?? []).map((columns) => `  UNIQUE (${columns.join(", ")})`),
    ...(table.foreignKeys ?? []).map(
      (foreignKey) =>
        `  FOREIGN KEY (${foreignKey.columns.join(", ")}) REFERENCES ${foreignKey.referencedTable} (${foreignKey.referencedColumns.join(", ")})${renderActions(foreignKey)}`,
    ),
    ...(table.checks ?? []).map((check) => `  CHECK (${renderCheck(check)})`),
  ];
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${[...cols, ...constraints].join(",\n")}\n)`;
}

function renderActions(input: {
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}): string {
  return `${input.onDelete ? ` ON DELETE ${input.onDelete}` : ""}${input.onUpdate ? ` ON UPDATE ${input.onUpdate}` : ""}`;
}

function renderReference(reference: ColumnReference): string {
  return `REFERENCES ${reference.table} (${reference.column})${renderActions(reference)}`;
}

function renderScalar(value: CheckScalar): string {
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function renderCheck(expression: CheckExpression): string {
  switch (expression.kind) {
    case "in":
      return `${expression.column} IN (${expression.values.map(renderScalar).join(", ")})`;
    case "compare":
      return `${expression.column} ${expression.operator} ${renderScalar(expression.value)}`;
    case "not-contains":
      return `INSTR(${expression.column}, ${renderScalar(expression.value)}) = 0`;
    case "is-null":
      return `${expression.column} IS ${expression.negate ? "NOT " : ""}NULL`;
    case "and":
    case "or":
      return expression.expressions
        .map((child) => `(${renderCheck(child)})`)
        .join(` ${expression.kind.toUpperCase()} `);
    case "not":
      return `NOT (${renderCheck(expression.expression)})`;
  }
}

/** CREATE INDEX DDL。 */
export function createIndexSql(index: IndexDef): string {
  assertSqlIdentifier(index.name);
  assertSqlIdentifier(index.table);
  if (index.columns.length === 0) throw new Error(`${index.name} INDEX の列が空です`);
  for (const column of index.columns) assertSqlIdentifier(column);
  if (index.predicate) assertSqlIdentifier(index.predicate.column);
  const predicate = index.predicate
    ? ` WHERE ${index.predicate.column} ${index.predicate.kind === "is-null" ? "IS NULL" : `= ${renderScalar(index.predicate.value)}`}`
    : "";
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${index.name} ON ${index.table} (${index.columns.join(", ")})${predicate}`;
}

export function createTriggerSql(trigger: TriggerDef): string {
  assertSqlIdentifier(trigger.name);
  assertSqlIdentifier(trigger.table);
  const message = trigger.action.message.replaceAll("'", "''");
  return `CREATE TRIGGER IF NOT EXISTS ${trigger.name} ${trigger.timing} ${trigger.event} ON ${trigger.table} BEGIN SELECT RAISE(ABORT, '${message}'); END`;
}

/** schema 全体の DDL 文 (table → index の順、deterministic)。 */
export function schemaDdl(): string[] {
  return [...HARNESS_DB_TABLES.map(createTableSql), ...HARNESS_DB_INDEXES.map(createIndexSql)];
}
// registry identifiers are validated at module load so invalid DDL fails before projection writes.
for (const table of HARNESS_DB_TABLES) {
  validateTableDef(table);
}
for (const index of HARNESS_DB_INDEXES) {
  assertSqlIdentifier(index.name);
  assertSqlIdentifier(index.table);
  for (const column of index.columns) assertSqlIdentifier(column);
}

export function primaryKeyOf(table: TableDef): string {
  if (table.primaryKey) {
    throw new Error(`table ${table.name} has a composite primary key; use primaryKeyColumnsOf`);
  }
  const key = table.columns.find((c) => c.primaryKey);
  if (!key) throw new Error(`table ${table.name} has no primary key column`);
  return key.name;
}

export function primaryKeyColumnsOf(table: TableDef): readonly string[] {
  if (table.primaryKey) return [...table.primaryKey];
  return [primaryKeyOf(table)];
}
