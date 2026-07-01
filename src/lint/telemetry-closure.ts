import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TelemetryClosureStatus = "closed" | "partial" | "scheduled" | "gap" | "blocked-human";

export interface TelemetryClosureDoc {
  file: string;
  content: string;
}

export interface TelemetryClosureRow {
  file: string;
  requirement: string;
  requiredEvidence: string;
  currentEvidence: string;
  automationOwner: string;
  status: TelemetryClosureStatus;
}

export interface TelemetryClosureViolation {
  file: string;
  requirement?: string;
  reason:
    | "missing_section"
    | "missing_table"
    | "malformed_row"
    | "missing_expected_requirement"
    | "missing_required_evidence"
    | "missing_current_evidence"
    | "missing_automation_owner"
    | "unknown_status"
    | "unknown_owner";
}

export interface TelemetryClosureResult {
  checked: number;
  rows: TelemetryClosureRow[];
  openRows: TelemetryClosureRow[];
  violations: TelemetryClosureViolation[];
  ok: boolean;
}

const SECTION_RE = /^##\s+Telemetry Closure Matrix\s*$/m;
const NEXT_SECTION_RE = /^##\s+/m;
const EXPECTED_REQUIREMENTS = [
  "Skill firing parameters",
  "Trouble logs",
  "GitHub issue creation outside Forward",
  "Drive model firing-rate measurement",
  "Plan/workflow retry detection",
  "Bottleneck detection",
  "Improvement log",
  "Measurement-to-feedback loop",
  "Project hook configuration",
] as const;
const VALID_STATUSES = new Set<TelemetryClosureStatus>([
  "closed",
  "partial",
  "scheduled",
  "gap",
  "blocked-human",
]);
const OWNER_RE =
  /\b(db|doctor|cli|projection|feedback|improvement-backlog|github issue queue|hook|project-hook|session-log|quality_signals)\b/i;

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

function normalizeStatus(raw: string): TelemetryClosureStatus | null {
  const cleaned = raw.replaceAll("`", "").trim();
  return VALID_STATUSES.has(cleaned as TelemetryClosureStatus)
    ? (cleaned as TelemetryClosureStatus)
    : null;
}

export function analyzeTelemetryClosure(docs: TelemetryClosureDoc[]): TelemetryClosureResult {
  const rows: TelemetryClosureRow[] = [];
  const violations: TelemetryClosureViolation[] = [];

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
    const indexes = {
      requirement: header.indexOf("requirement"),
      required: header.indexOf("required evidence"),
      current: header.indexOf("current evidence"),
      owner: header.indexOf("automation owner"),
      status: header.indexOf("status"),
    };
    if (Object.values(indexes).some((index) => index < 0)) {
      violations.push({ file: doc.file, reason: "malformed_row" });
      continue;
    }

    for (const cells of parsed.slice(1)) {
      const requirement = cells[indexes.requirement] ?? "";
      const requiredEvidence = cells[indexes.required] ?? "";
      const currentEvidence = cells[indexes.current] ?? "";
      const automationOwner = cells[indexes.owner] ?? "";
      const status = normalizeStatus(cells[indexes.status] ?? "");
      if (!requirement || !requiredEvidence || !currentEvidence || !automationOwner) {
        violations.push({
          file: doc.file,
          requirement: requirement || undefined,
          reason: "malformed_row",
        });
        continue;
      }
      if (!requiredEvidence.trim()) {
        violations.push({ file: doc.file, requirement, reason: "missing_required_evidence" });
      }
      if (!currentEvidence.trim()) {
        violations.push({ file: doc.file, requirement, reason: "missing_current_evidence" });
      }
      if (!automationOwner.trim()) {
        violations.push({ file: doc.file, requirement, reason: "missing_automation_owner" });
      }
      if (!OWNER_RE.test(automationOwner)) {
        violations.push({ file: doc.file, requirement, reason: "unknown_owner" });
      }
      if (!status) {
        violations.push({ file: doc.file, requirement, reason: "unknown_status" });
        continue;
      }
      rows.push({
        file: doc.file,
        requirement,
        requiredEvidence,
        currentEvidence,
        automationOwner,
        status,
      });
    }

    const seen = new Set(rows.filter((row) => row.file === doc.file).map((row) => row.requirement));
    for (const requirement of EXPECTED_REQUIREMENTS) {
      if (!seen.has(requirement)) {
        violations.push({ file: doc.file, requirement, reason: "missing_expected_requirement" });
      }
    }
  }

  const openRows = rows.filter((row) => row.status !== "closed");
  return { checked: docs.length, rows, openRows, violations, ok: violations.length === 0 };
}

export function loadTelemetryClosureDocs(repoRoot: string = process.cwd()): TelemetryClosureDoc[] {
  const target = join(
    repoRoot,
    ".ut-tdd",
    "audit",
    "A-134-harness-telemetry-self-improvement-audit.md",
  );
  if (!existsSync(target)) return [];
  return [
    {
      file: join(".ut-tdd", "audit", "A-134-harness-telemetry-self-improvement-audit.md"),
      content: readFileSync(target, "utf8"),
    },
  ];
}

export function telemetryClosureMessages(result: TelemetryClosureResult): string[] {
  if (result.checked === 0) {
    return ["telemetry-closure - violation: telemetry closure matrix not found"];
  }
  if (result.violations.length > 0) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.file}${v.requirement ? `:${v.requirement}` : ""}:${v.reason}`)
      .join(", ");
    return [
      `telemetry-closure - violation ${result.violations.length} (${sample}); telemetry rows must name evidence, owner, and status`,
    ];
  }
  if (result.openRows.length > 0) {
    const byStatus = result.openRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(byStatus)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    return [
      `telemetry-closure - non-closed ${result.openRows.length} (${summary}); requirements=${result.openRows.map((row) => row.requirement).join(",")}`,
    ];
  }
  return [`telemetry-closure - OK (checked=${result.checked}, requirements=${result.rows.length})`];
}
