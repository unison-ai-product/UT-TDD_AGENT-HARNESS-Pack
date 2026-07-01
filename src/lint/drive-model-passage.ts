import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DriveModelPassageDoc {
  file: string;
  content: string;
}

export interface DriveModelPassageRow {
  file: string;
  mode: string;
  requiredColumns: string;
}

export interface DriveModelPassageViolation {
  file: string;
  mode?: string;
  reason:
    | "missing_section"
    | "missing_table"
    | "malformed_row"
    | "missing_mode"
    | "missing_forward_target"
    | "missing_residual_status"
    | "missing_expected_mode";
}

export interface DriveModelPassageResult {
  checked: number;
  rows: DriveModelPassageRow[];
  violations: DriveModelPassageViolation[];
  ok: boolean;
}

const SECTION_RE = /^##\s+Section\s+2\.1\s+Drive-model Passage Certificate Required\s*$/m;
const NEXT_SECTION_RE = /^##\s+/m;
const EXPECTED_MODES = [
  "Discovery",
  "Scrum",
  "Reverse",
  "Recovery",
  "Incident",
  "Refactor",
  "Retrofit",
  "Add-feature",
  "Research",
] as const;

function section(content: string): string {
  const match = content.match(SECTION_RE);
  if (!match || match.index === undefined) return "";
  const rest = content.slice(match.index + match[0].length);
  const end = rest.search(NEXT_SECTION_RE);
  return end < 0 ? rest : rest.slice(0, end);
}

function tableRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function hasForwardTarget(text: string): boolean {
  return /forward|re-entry|route|target|routing/i.test(text);
}

function hasResidualStatus(text: string): boolean {
  return /residual status|status|gap|parked|po decision/i.test(text);
}

export function analyzeDriveModelPassage(docs: DriveModelPassageDoc[]): DriveModelPassageResult {
  const rows: DriveModelPassageRow[] = [];
  const violations: DriveModelPassageViolation[] = [];

  for (const doc of docs) {
    const body = section(doc.content);
    if (!body) {
      violations.push({ file: doc.file, reason: "missing_section" });
      continue;
    }
    const parsed = tableRows(body);
    if (parsed.length < 2) {
      violations.push({ file: doc.file, reason: "missing_table" });
      continue;
    }
    const header = parsed[0].map((cell) => cell.toLowerCase());
    const modeIndex = header.indexOf("drive model / entry mode");
    const columnsIndex = header.indexOf("required certificate columns");
    if (modeIndex < 0 || columnsIndex < 0) {
      violations.push({ file: doc.file, reason: "malformed_row" });
      continue;
    }

    for (const cells of parsed.slice(1)) {
      const mode = cells[modeIndex] ?? "";
      const requiredColumns = cells[columnsIndex] ?? "";
      if (!mode || !requiredColumns) {
        violations.push({ file: doc.file, mode: mode || undefined, reason: "malformed_row" });
        continue;
      }
      if (!hasForwardTarget(requiredColumns)) {
        violations.push({ file: doc.file, mode, reason: "missing_forward_target" });
      }
      if (!hasResidualStatus(requiredColumns)) {
        violations.push({ file: doc.file, mode, reason: "missing_residual_status" });
      }
      rows.push({ file: doc.file, mode, requiredColumns });
    }

    const seen = new Set(rows.filter((row) => row.file === doc.file).map((row) => row.mode));
    for (const mode of EXPECTED_MODES) {
      if (!seen.has(mode))
        violations.push({ file: doc.file, mode, reason: "missing_expected_mode" });
    }
  }

  return { checked: docs.length, rows, violations, ok: violations.length === 0 };
}

export function loadDriveModelPassageDocs(
  repoRoot: string = process.cwd(),
): DriveModelPassageDoc[] {
  const target = join(repoRoot, "docs", "plans", "PLAN-L3-04-upstream-schedule-reconciliation.md");
  if (!existsSync(target)) return [];
  return [
    {
      file: join("docs", "plans", "PLAN-L3-04-upstream-schedule-reconciliation.md"),
      content: readFileSync(target, "utf8"),
    },
  ];
}

export function driveModelPassageMessages(result: DriveModelPassageResult): string[] {
  if (result.checked === 0) {
    return ["drive-model-passage - violation: passage certificate table not found"];
  }
  if (result.violations.length > 0) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.file}${v.mode ? `:${v.mode}` : ""}:${v.reason}`)
      .join(", ");
    return [
      `drive-model-passage - violation ${result.violations.length} (${sample}); all entry modes need Forward target and residual status evidence`,
    ];
  }
  return [
    `drive-model-passage - OK (checked=${result.checked}, modes=${result.rows.length}, expected=9)`,
  ];
}
