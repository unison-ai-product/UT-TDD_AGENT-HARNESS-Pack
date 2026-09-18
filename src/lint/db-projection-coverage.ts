import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTableSql,
  HARNESS_DB_INDEXES,
  HARNESS_DB_TABLE_BY_NAME,
  HARNESS_DB_TABLES,
  primaryKeyColumnsOf,
  type TableDef,
} from "../schema/harness-db.ts";

/** lintがstate-db実装へ逆依存しないためのSQLite introspection port。 */
export interface DbIntrospectionPort {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

export interface DbProjectionRequirement {
  section: string;
  table: string;
  primaryKey: string;
  columns: string[];
}

export interface DbProjectionIndexRequirement {
  section: string;
  name: string;
  columns: string[];
}

export interface DbProjectionCoverageResult {
  checked: number;
  checkedIndexes: number;
  missingTables: DbProjectionRequirement[];
  missingColumns: Array<{
    table: string;
    section: string;
    columns: string[];
  }>;
  primaryKeyMismatches: Array<{
    table: string;
    section: string;
    expected: string;
    actual: string;
  }>;
  missingIndexes: DbProjectionIndexRequirement[];
  indexColumnMismatches: Array<{
    index: string;
    section: string;
    expected: string[];
    actual: string[];
  }>;
  ok: boolean;
}

export interface DbProjectionRequirements {
  tables: DbProjectionRequirement[];
  indexes: DbProjectionIndexRequirement[];
}

export interface DbConstraintCoverageFinding {
  table: string;
  constraint: "table" | "not-null" | "primary-key" | "foreign-key" | "unique" | "check";
  expected: string;
  actual: string;
}

export interface DbConstraintCoverageResult {
  checked: number;
  findings: DbConstraintCoverageFinding[];
  ok: boolean;
}

const TARGET_SECTION_RE = /^###?\s+.*(?:2\.7 SQLite projection DB|9\.(?:[13456789]|[1-9]\d+) .*)/;
const HEADING_RE = /^(#{1,6})\s+/;
const TABLE_SEPARATOR_CELL_RE = /^-{3,}$/;
const INDEX_MARKER_RE = /^(?:必須|必要) index:$/;
const INDEX_BULLET_RE = /^\s*-\s+`([^`(]+)\(([^`)]+)\)`/;

function backtickValues(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter(Boolean);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function normalizedHeaderCell(value: string): string {
  let normalized = value.trim();
  const wrappers = ["**", "__", "`", "*", "_"] as const;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const wrapper of wrappers) {
      if (
        normalized.length >= wrapper.length * 2 &&
        normalized.startsWith(wrapper) &&
        normalized.endsWith(wrapper)
      ) {
        normalized = normalized.slice(wrapper.length, -wrapper.length).trim();
        stripped = true;
        break;
      }
    }
  }
  return normalized.toLowerCase();
}

function isTableSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL_RE.test(cell));
}

function isProjectionTableHeader(cells: readonly string[]): boolean {
  const first = normalizedHeaderCell(cells[0] ?? "");
  const second = normalizedHeaderCell(cells[1] ?? "");
  return first === "table" && (second === "primary key" || second === "主キー");
}

function headingSectionNumber(line: string): string | undefined {
  return /^#{1,6}\s+§?(\d+(?:\.\d+)*)/.exec(line)?.[1];
}

function isLogicalDescendant(section: string | undefined, parent: string | undefined): boolean {
  return Boolean(section && parent && section.startsWith(`${parent}.`));
}

function fenceParts(line: string): { marker: "`" | "~"; length: number; rest: string } | undefined {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  return { marker: match[1][0] as "`" | "~", length: match[1].length, rest: match[2] };
}

export function extractDbProjectionRequirements(content: string): DbProjectionRequirement[] {
  return extractDbProjectionCoverageRequirements(content).tables;
}

export function extractDbProjectionCoverageRequirements(content: string): DbProjectionRequirements {
  const requirements: DbProjectionRequirement[] = [];
  const indexes: DbProjectionIndexRequirement[] = [];
  let section = "";
  let targetDepth = 0;
  let targetSectionNumber: string | undefined;
  let indexBlock: "none" | "armed" | "collecting" = "none";
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let pendingHeader: string[] | undefined;
  let tableKind: "none" | "projection" | "other" = "none";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const fenceMatch = fenceParts(line);
    if (fence) {
      if (
        fenceMatch?.marker === fence.marker &&
        fenceMatch.length >= fence.length &&
        fenceMatch.rest.trim() === ""
      ) {
        fence = undefined;
        pendingHeader = undefined;
        tableKind = "none";
        indexBlock = "none";
      }
      continue;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch.marker,
        length: fenceMatch.length,
      };
      pendingHeader = undefined;
      tableKind = "none";
      indexBlock = "none";
      continue;
    }

    if (targetDepth > 0 && INDEX_MARKER_RE.test(trimmed)) {
      indexBlock = "armed";
      continue;
    }
    if (indexBlock !== "none") {
      if (indexBlock === "armed" && trimmed === "") continue;
      const indexMatch = INDEX_BULLET_RE.exec(line);
      if (indexMatch) {
        indexBlock = "collecting";
        indexes.push({
          section,
          name: indexMatch[1],
          columns: indexMatch[2]
            .split(",")
            .map((column) => column.trim())
            .filter(Boolean),
        });
        continue;
      }
      indexBlock = "none";
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const sectionNumber = headingSectionNumber(line);
      const leavesNumberedTarget =
        targetDepth > 0 &&
        Boolean(sectionNumber) &&
        sectionNumber !== targetSectionNumber &&
        !isLogicalDescendant(sectionNumber, targetSectionNumber);
      const leavesUnnumberedTarget = targetDepth > 0 && !sectionNumber && depth <= targetDepth;
      if (leavesNumberedTarget || leavesUnnumberedTarget) {
        targetDepth = 0;
        targetSectionNumber = undefined;
      }
      section = line.replace(/^#+\s*/, "").trim();
      if (TARGET_SECTION_RE.test(line)) {
        targetDepth = depth;
        targetSectionNumber = sectionNumber;
      }
      pendingHeader = undefined;
      tableKind = "none";
      indexBlock = "none";
      continue;
    }
    if (targetDepth === 0) continue;

    if (!(trimmed.startsWith("|") && trimmed.endsWith("|"))) {
      pendingHeader = undefined;
      tableKind = "none";
      continue;
    }

    const cells = splitTableRow(line);
    if (isTableSeparator(cells)) {
      tableKind =
        pendingHeader && cells.length === pendingHeader.length
          ? isProjectionTableHeader(pendingHeader)
            ? "projection"
            : "other"
          : "none";
      pendingHeader = undefined;
      continue;
    }

    if (tableKind === "none") {
      pendingHeader = cells;
      continue;
    }
    if (tableKind === "other") continue;
    if (cells.length < 3) continue;
    const table = backtickValues(cells[0])[0];
    const primaryKey = backtickValues(cells[1])[0] ?? "";
    const columns = backtickValues(cells[2]);
    if (!table) continue;
    requirements.push({ section, table, primaryKey, columns });
  }
  return { tables: requirements, indexes };
}

export function analyzeDbProjectionCoverage(
  input: DbProjectionRequirement[] | DbProjectionRequirements,
): DbProjectionCoverageResult {
  const requirements = Array.isArray(input) ? input : input.tables;
  const indexRequirements = Array.isArray(input) ? [] : input.indexes;
  const missingTables: DbProjectionRequirement[] = [];
  const missingColumns: DbProjectionCoverageResult["missingColumns"] = [];
  const primaryKeyMismatches: DbProjectionCoverageResult["primaryKeyMismatches"] = [];
  const missingIndexes: DbProjectionIndexRequirement[] = [];
  const indexColumnMismatches: DbProjectionCoverageResult["indexColumnMismatches"] = [];

  for (const requirement of requirements) {
    const table = HARNESS_DB_TABLE_BY_NAME.get(requirement.table);
    if (!table) {
      missingTables.push(requirement);
      continue;
    }
    const actualPk = primaryKeyColumnsOf(table).join(",");
    if (requirement.primaryKey && actualPk !== requirement.primaryKey) {
      primaryKeyMismatches.push({
        table: requirement.table,
        section: requirement.section,
        expected: requirement.primaryKey,
        actual: actualPk,
      });
    }
    const actualColumns = new Set(table.columns.map((column) => column.name));
    const missing = requirement.columns.filter((column) => !actualColumns.has(column));
    if (missing.length > 0) {
      missingColumns.push({
        table: requirement.table,
        section: requirement.section,
        columns: missing,
      });
    }
  }

  const indexesByName = new Map(HARNESS_DB_INDEXES.map((index) => [index.name, index]));
  for (const requirement of indexRequirements) {
    const index = indexesByName.get(requirement.name);
    if (!index) {
      missingIndexes.push(requirement);
      continue;
    }
    if (index.columns.join("|") !== requirement.columns.join("|")) {
      indexColumnMismatches.push({
        index: requirement.name,
        section: requirement.section,
        expected: requirement.columns,
        actual: index.columns,
      });
    }
  }

  return {
    checked: requirements.length,
    checkedIndexes: indexRequirements.length,
    missingTables,
    missingColumns,
    primaryKeyMismatches,
    missingIndexes,
    indexColumnMismatches,
    ok:
      requirements.length > 0 &&
      missingTables.length === 0 &&
      missingColumns.length === 0 &&
      primaryKeyMismatches.length === 0 &&
      missingIndexes.length === 0 &&
      indexColumnMismatches.length === 0,
  };
}

function normalized(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toUpperCase();
}

function checkClauses(sql: string): string[] {
  const clauses: string[] = [];
  const upper = sql.toUpperCase();
  let cursor = 0;
  while (cursor < sql.length) {
    const check = upper.indexOf("CHECK", cursor);
    if (check < 0) break;
    const open = sql.indexOf("(", check + 5);
    if (open < 0) break;
    let depth = 0;
    let quoted = false;
    let close = -1;
    for (let index = open; index < sql.length; index++) {
      const character = sql[index];
      if (character === "'") {
        if (quoted && sql[index + 1] === "'") index++;
        else quoted = !quoted;
      } else if (!quoted && character === "(") depth++;
      else if (!quoted && character === ")" && --depth === 0) {
        close = index;
        break;
      }
    }
    if (close < 0) break;
    clauses.push(normalized(sql.slice(open + 1, close)));
    cursor = close + 1;
  }
  return clauses.sort();
}

function setDiff(expected: readonly string[], actual: readonly string[]): string[] {
  const remaining = [...actual];
  return expected.filter((item) => {
    const index = remaining.indexOf(item);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

function actualPrimaryKey(db: DbIntrospectionPort, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((row) => Number(row.pk ?? 0) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
}

function actualUniqueKeys(db: DbIntrospectionPort, table: string): string[] {
  return db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .filter((row) => Number(row.unique ?? 0) === 1 && String(row.origin ?? "") !== "pk")
    .map((row) => {
      const name = String(row.name);
      return db
        .prepare(`PRAGMA index_info(${name})`)
        .all()
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => String(column.name))
        .join(",");
    })
    .sort();
}

function expectedForeignKeys(table: TableDef): string[] {
  const inline = table.columns.flatMap((column) =>
    column.references
      ? [
          [
            column.name,
            column.references.table,
            column.references.column,
            column.references.onUpdate ?? "NO ACTION",
            column.references.onDelete ?? "NO ACTION",
          ].join("|"),
        ]
      : [],
  );
  const composite = (table.foreignKeys ?? []).map((key) =>
    [
      key.columns.join(","),
      key.referencedTable,
      key.referencedColumns.join(","),
      key.onUpdate ?? "NO ACTION",
      key.onDelete ?? "NO ACTION",
    ].join("|"),
  );
  return [...inline, ...composite].sort();
}

function actualForeignKeys(db: DbIntrospectionPort, table: string): string[] {
  const groups = new Map<number, Record<string, unknown>[]>();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
    const id = Number(row.id);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return [...groups.values()]
    .map((rows) => {
      const ordered = rows.sort((left, right) => Number(left.seq) - Number(right.seq));
      return [
        ordered.map((row) => String(row.from)).join(","),
        String(ordered[0]?.table ?? ""),
        ordered.map((row) => String(row.to)).join(","),
        String(ordered[0]?.on_update ?? "NO ACTION"),
        String(ordered[0]?.on_delete ?? "NO ACTION"),
      ].join("|");
    })
    .sort();
}

/** registryのtyped制約が実SQLite schemaにも存在することをfail-closeで照合する。 */
export function analyzeDbConstraintCoverage(
  db: DbIntrospectionPort,
  tables: readonly TableDef[] = HARNESS_DB_TABLES,
): DbConstraintCoverageResult {
  const findings: DbConstraintCoverageFinding[] = [];
  const existing = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  for (const table of tables) {
    if (!existing.has(table.name)) {
      findings.push({
        table: table.name,
        constraint: "table",
        expected: "present",
        actual: "missing",
      });
      continue;
    }
    const info = db.prepare(`PRAGMA table_info(${table.name})`).all();
    const notNull = new Set(
      info.filter((row) => Number(row.notnull ?? 0) === 1).map((row) => String(row.name)),
    );
    for (const column of table.columns.filter((item) => item.notNull)) {
      if (!notNull.has(column.name))
        findings.push({
          table: table.name,
          constraint: "not-null",
          expected: column.name,
          actual: "nullable",
        });
    }
    const expectedPk = primaryKeyColumnsOf(table);
    const actualPk = actualPrimaryKey(db, table.name);
    if (expectedPk.join("|") !== actualPk.join("|"))
      findings.push({
        table: table.name,
        constraint: "primary-key",
        expected: expectedPk.join(","),
        actual: actualPk.join(","),
      });

    const expectedFk = expectedForeignKeys(table);
    const actualFk = actualForeignKeys(db, table.name);
    for (const missing of setDiff(expectedFk, actualFk))
      findings.push({
        table: table.name,
        constraint: "foreign-key",
        expected: missing,
        actual: actualFk.join(";"),
      });

    const expectedUnique = (table.unique ?? []).map((columns) => columns.join(",")).sort();
    const actualUnique = actualUniqueKeys(db, table.name);
    for (const missing of setDiff(expectedUnique, actualUnique))
      findings.push({
        table: table.name,
        constraint: "unique",
        expected: missing,
        actual: actualUnique.join(";"),
      });

    const schemaRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table.name);
    const expectedChecks = checkClauses(createTableSql(table));
    const actualChecks = checkClauses(String(schemaRow?.sql ?? ""));
    for (const missing of setDiff(expectedChecks, actualChecks))
      findings.push({
        table: table.name,
        constraint: "check",
        expected: missing,
        actual: actualChecks.join(";"),
      });
  }
  return { checked: tables.length, findings, ok: tables.length > 0 && findings.length === 0 };
}

export function loadDbProjectionRequirements(repoRoot: string): DbProjectionRequirements {
  const path = join(
    repoRoot,
    "docs",
    "design",
    "harness",
    "L5-detailed-design",
    "physical-data.md",
  );
  if (!existsSync(path)) throw new Error("physical-data.md is missing");
  return extractDbProjectionCoverageRequirements(readFileSync(path, "utf8"));
}

export function dbProjectionCoverageMessages(result: DbProjectionCoverageResult): string[] {
  if (result.ok) {
    return [
      `db-projection-coverage - OK (${result.checked} physical-data tables, ${result.checkedIndexes} indexes covered)`,
    ];
  }
  const messages = ["db-projection-coverage - violation"];
  for (const table of result.missingTables) {
    messages.push(`missing table ${table.table} (${table.section})`);
  }
  for (const item of result.missingColumns) {
    messages.push(`missing columns ${item.table}: ${item.columns.join(", ")} (${item.section})`);
  }
  for (const item of result.primaryKeyMismatches) {
    messages.push(
      `primary key mismatch ${item.table}: expected ${item.expected}, actual ${item.actual} (${item.section})`,
    );
  }
  for (const index of result.missingIndexes) {
    messages.push(`missing index ${index.name} (${index.section})`);
  }
  for (const item of result.indexColumnMismatches) {
    messages.push(
      `index columns mismatch ${item.index}: expected ${item.expected.join(", ")}, actual ${item.actual.join(", ")} (${item.section})`,
    );
  }
  return messages;
}

export function dbConstraintCoverageMessages(result: DbConstraintCoverageResult): string[] {
  if (result.ok) return [`db-constraint-coverage - OK (${result.checked} tables)`];
  return [
    "db-constraint-coverage - violation",
    ...result.findings.map(
      (finding) =>
        `${finding.table} ${finding.constraint}: expected ${finding.expected}, actual ${finding.actual}`,
    ),
  ];
}
