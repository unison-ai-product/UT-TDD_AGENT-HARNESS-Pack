import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CycleP4VerificationStatus = "closed" | "human_required" | "out_of_scope";

export interface CycleP4VerificationDoc {
  file: string;
  content: string;
}

export interface CycleP4VerificationRow {
  file: string;
  requirement: string;
  scope: string;
  requiredEvidence: string;
  currentEvidence: string;
  automationOwner: string;
  status: CycleP4VerificationStatus;
  evidencePaths: string[];
}

export interface CycleP4VerificationViolation {
  file: string;
  requirement?: string;
  reason:
    | "missing_section"
    | "missing_table"
    | "malformed_row"
    | "missing_expected_requirement"
    | "unknown_status"
    | "unknown_owner"
    | "missing_evidence_path"
    | "forbidden_legacy_source_term";
}

export interface CycleP4VerificationResult {
  checked: number;
  rows: CycleP4VerificationRow[];
  violations: CycleP4VerificationViolation[];
  ok: boolean;
}

const SECTION_RE = /^##\s+Cycle P4 Verification Closure Matrix\s*$/m;
const NEXT_SECTION_RE = /^##\s+/m;
const VALID_STATUSES = new Set<CycleP4VerificationStatus>([
  "closed",
  "human_required",
  "out_of_scope",
]);
const EXPECTED_REQUIREMENTS = [
  "Cycle P4 L7 DB integration",
  "L8-L14 local verification band",
  "UT-TDD Run P4 L9-L11 boundary",
  "Production and PO signoff boundary",
  "Handover current action",
  "Source isolation current vocabulary",
  "Telemetry and self-improvement closure",
  "Feature residual closure",
  "Placeholder-deps carry boundary",
  "Skill assignment closure",
  "Source migration coverage",
] as const;
const OWNER_RE =
  /\b(doctor|db|projection|roadmap|handover|telemetry|fr-roadmap|test-design|verification|skill|source-isolation|migration)\b/i;
const EVIDENCE_PATH_RE = /`([^`]+)`/g;
const CURRENT_OPERATIONAL_FILES = [
  "docs/design/harness/L3-functional/roadmap.md",
  "docs/plans/PLAN-M-00-verify-cutover.md",
  "docs/plans/PLAN-M-01-cutover-backfill.md",
  ".ut-tdd/audit/A-136-cycle-p4-verification-audit.md",
  "src/lint/roadmap-registry.ts",
] as const;
const LEGACY_RUNTIME_NAME = ["he", "lix"].join("");
const FORBIDDEN_LEGACY_SOURCE_RE = new RegExp(
  [
    String.raw`Phase 4 \(L7 DB\)`,
    "Phase4",
    "phase4",
    `${LEGACY_RUNTIME_NAME} to UT`,
    `${LEGACY_RUNTIME_NAME} runtime`,
    `${LEGACY_RUNTIME_NAME} cutover`,
    `${LEGACY_RUNTIME_NAME} to`,
  ].join("|"),
  "i",
);

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

function normalizeStatus(raw: string): CycleP4VerificationStatus | null {
  const cleaned = raw.replaceAll("`", "").trim();
  return VALID_STATUSES.has(cleaned as CycleP4VerificationStatus)
    ? (cleaned as CycleP4VerificationStatus)
    : null;
}

function evidencePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(EVIDENCE_PATH_RE)) {
    const value = match[1]?.trim();
    if (!value) continue;
    if (
      value.startsWith(".ut-tdd/") ||
      value.startsWith("docs/") ||
      value.startsWith("src/") ||
      value.startsWith("tests/") ||
      value === ".ut-tdd/harness.db"
    ) {
      paths.push(value);
    }
  }
  return paths;
}

function pathExists(repoRoot: string, path: string): boolean {
  if (path === ".ut-tdd/harness.db") {
    return (
      existsSync(join(repoRoot, ".ut-tdd")) &&
      existsSync(join(repoRoot, "src", "state-db", "projection-writer.ts"))
    );
  }
  // join は "/" 区切りを全 OS で正規化する (Linux で "\\" に置換すると literal バックスラッシュ名になり existsSync が常に false = CI 失敗、cross-platform 第一級)。
  return existsSync(join(repoRoot, path));
}

export function analyzeCycleP4Verification(
  docs: CycleP4VerificationDoc[],
  repoRoot: string = process.cwd(),
): CycleP4VerificationResult {
  const rows: CycleP4VerificationRow[] = [];
  const violations: CycleP4VerificationViolation[] = [];

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
      scope: header.indexOf("scope"),
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
      const scope = cells[indexes.scope] ?? "";
      const requiredEvidence = cells[indexes.required] ?? "";
      const currentEvidence = cells[indexes.current] ?? "";
      const automationOwner = cells[indexes.owner] ?? "";
      const status = normalizeStatus(cells[indexes.status] ?? "");
      if (!requirement || !scope || !requiredEvidence || !currentEvidence || !automationOwner) {
        violations.push({
          file: doc.file,
          requirement: requirement || undefined,
          reason: "malformed_row",
        });
        continue;
      }
      if (!OWNER_RE.test(automationOwner)) {
        violations.push({ file: doc.file, requirement, reason: "unknown_owner" });
      }
      if (!status) {
        violations.push({ file: doc.file, requirement, reason: "unknown_status" });
        continue;
      }
      const paths = evidencePaths(currentEvidence);
      if (paths.length === 0 || paths.some((p) => !pathExists(repoRoot, p))) {
        violations.push({ file: doc.file, requirement, reason: "missing_evidence_path" });
      }
      rows.push({
        file: doc.file,
        requirement,
        scope,
        requiredEvidence,
        currentEvidence,
        automationOwner,
        status,
        evidencePaths: paths,
      });
    }

    const seen = new Set(rows.filter((row) => row.file === doc.file).map((row) => row.requirement));
    for (const requirement of EXPECTED_REQUIREMENTS) {
      if (!seen.has(requirement)) {
        violations.push({ file: doc.file, requirement, reason: "missing_expected_requirement" });
      }
    }
  }

  for (const file of CURRENT_OPERATIONAL_FILES) {
    const target = join(repoRoot, file);
    if (!existsSync(target)) continue;
    const content = readFileSync(target, "utf8");
    if (FORBIDDEN_LEGACY_SOURCE_RE.test(content)) {
      violations.push({ file, reason: "forbidden_legacy_source_term" });
    }
  }

  return { checked: docs.length, rows, violations, ok: violations.length === 0 };
}

export function loadCycleP4VerificationDocs(
  repoRoot: string = process.cwd(),
): CycleP4VerificationDoc[] {
  const target = join(repoRoot, ".ut-tdd", "audit", "A-136-cycle-p4-verification-audit.md");
  if (!existsSync(target)) return [];
  return [
    {
      file: join(".ut-tdd", "audit", "A-136-cycle-p4-verification-audit.md"),
      content: readFileSync(target, "utf8"),
    },
  ];
}

export function cycleP4VerificationMessages(result: CycleP4VerificationResult): string[] {
  if (result.checked === 0) {
    return ["cycle-p4-verification - violation: Cycle P4 closure audit not found"];
  }
  if (result.violations.length > 0) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.file}${v.requirement ? `:${v.requirement}` : ""}:${v.reason}`)
      .join(", ");
    return [
      `cycle-p4-verification - violation ${result.violations.length} (${sample}); Cycle P4 closure needs explicit evidence paths and accepted UT-TDD boundary statuses`,
    ];
  }
  const byStatus = result.rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byStatus)
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  return [
    `cycle-p4-verification - OK (checked=${result.checked}, rows=${result.rows.length}, ${summary})`,
  ];
}
