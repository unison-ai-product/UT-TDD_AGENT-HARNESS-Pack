import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_DB_INDEXES, HARNESS_DB_TABLE_BY_NAME, primaryKeyOf } from "../schema/harness-db";

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

const TARGET_SECTION_RE = /^###?\s+.*(?:2\.7 SQLite projection DB|9\.[134567] .*)/;
const SECTION_RE = /^###?\s+/;

function backtickValues(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter(Boolean);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function extractDbProjectionRequirements(content: string): DbProjectionRequirement[] {
  return extractDbProjectionCoverageRequirements(content).tables;
}

export function extractDbProjectionCoverageRequirements(content: string): DbProjectionRequirements {
  const requirements: DbProjectionRequirement[] = [];
  const indexes: DbProjectionIndexRequirement[] = [];
  let section = "";
  let inTarget = false;
  for (const line of content.split(/\r?\n/)) {
    if (SECTION_RE.test(line)) {
      section = line.replace(/^#+\s*/, "").trim();
      inTarget = TARGET_SECTION_RE.test(line);
      continue;
    }
    if (!inTarget) continue;
    const indexMatch = line.match(/-\s+`([^`(]+)\(([^`)]+)\)`/);
    if (indexMatch) {
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
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-+\s*\|/.test(line) || /\|\s*table\s*\|/i.test(line)) continue;
    const cells = splitTableRow(line);
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
    const actualPk = primaryKeyOf(table);
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
