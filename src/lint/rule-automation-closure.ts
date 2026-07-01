import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RuleAutomationStatus = "closed" | "scheduled" | "gap" | "parked" | "PO decision";

export interface RuleAutomationClosureDoc {
  file: string;
  content: string;
}

export interface RuleAutomationClosureRow {
  file: string;
  rule: string;
  owner: string;
  status: RuleAutomationStatus;
}

export interface RuleAutomationClosureViolation {
  file: string;
  rule?: string;
  reason:
    | "missing_section"
    | "missing_table"
    | "malformed_row"
    | "missing_owner"
    | "unknown_owner"
    | "unknown_status";
}

export interface RuleAutomationClosureResult {
  checked: number;
  rows: RuleAutomationClosureRow[];
  openRows: RuleAutomationClosureRow[];
  violations: RuleAutomationClosureViolation[];
  ok: boolean;
}

const SECTION_RE = /^##\s+Section\s+2\.3\s+Rule Automation Closure Required\s*$/m;
const NEXT_SECTION_RE = /^##\s+/m;
const VALID_STATUSES = new Set<RuleAutomationStatus>([
  "closed",
  "scheduled",
  "gap",
  "parked",
  "PO decision",
]);
const OWNER_PATTERN =
  /\b(doctor|plan-?lint|vmodel|hook|db|database|ci|projection|writer|analyzer|checker|lint|handover|fr-roadmap-coverage)\b/i;

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

function normalizeStatus(raw: string): RuleAutomationStatus | null {
  const cleaned = raw.replaceAll("`", "").trim();
  return VALID_STATUSES.has(cleaned as RuleAutomationStatus)
    ? (cleaned as RuleAutomationStatus)
    : null;
}

export function analyzeRuleAutomationClosure(
  docs: RuleAutomationClosureDoc[],
): RuleAutomationClosureResult {
  const rows: RuleAutomationClosureRow[] = [];
  const violations: RuleAutomationClosureViolation[] = [];

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
    const ruleIndex = header.indexOf("rule");
    const ownerIndex = header.indexOf("required automation owner");
    const statusIndex = header.indexOf("current status");
    if (ruleIndex < 0 || ownerIndex < 0 || statusIndex < 0) {
      violations.push({ file: doc.file, reason: "malformed_row" });
      continue;
    }

    for (const cells of parsed.slice(1)) {
      const rule = cells[ruleIndex]?.trim() ?? "";
      const owner = cells[ownerIndex]?.trim() ?? "";
      const statusRaw = cells[statusIndex]?.trim() ?? "";
      if (!rule || !owner || !statusRaw) {
        violations.push({ file: doc.file, rule: rule || undefined, reason: "malformed_row" });
        continue;
      }
      if (!owner.replaceAll("`", "").trim()) {
        violations.push({ file: doc.file, rule, reason: "missing_owner" });
        continue;
      }
      if (!OWNER_PATTERN.test(owner)) {
        violations.push({ file: doc.file, rule, reason: "unknown_owner" });
        continue;
      }
      const status = normalizeStatus(statusRaw);
      if (!status) {
        violations.push({ file: doc.file, rule, reason: "unknown_status" });
        continue;
      }
      rows.push({ file: doc.file, rule, owner, status });
    }
  }

  const openRows = rows.filter((row) => row.status !== "closed");
  return {
    checked: docs.length,
    rows,
    openRows,
    violations,
    ok: violations.length === 0,
  };
}

export function loadRuleAutomationClosureDocs(
  repoRoot: string = process.cwd(),
): RuleAutomationClosureDoc[] {
  const target = join(repoRoot, "docs", "plans", "PLAN-L3-04-upstream-schedule-reconciliation.md");
  if (!existsSync(target)) return [];
  return [
    {
      file: join("docs", "plans", "PLAN-L3-04-upstream-schedule-reconciliation.md"),
      content: readFileSync(target, "utf8"),
    },
  ];
}

export function ruleAutomationClosureMessages(result: RuleAutomationClosureResult): string[] {
  if (result.checked === 0) {
    return ["rule-automation-closure - violation: closure table not found"];
  }
  if (result.violations.length > 0) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.file}${v.rule ? `:${v.rule}` : ""}:${v.reason}`)
      .join(", ");
    return [
      `rule-automation-closure - violation ${result.violations.length} (${sample}); every rule needs an automation owner and known status`,
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
    const sample = result.openRows
      .slice(0, 5)
      .map((row) => `${row.rule}:${row.status}`)
      .join(", ");
    return [
      `rule-automation-closure - non-closed ${result.openRows.length} (${summary}); ${sample}`,
    ];
  }
  return [`rule-automation-closure - OK (checked=${result.checked}, rows=${result.rows.length})`];
}
