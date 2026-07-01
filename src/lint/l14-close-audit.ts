import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type L14CloseAuditStatus =
  | "closed"
  | "partial"
  | "human_required"
  | "external_required"
  | "parked_future";

export interface L14CloseAuditDoc {
  file: string;
  content: string;
}

export interface L14CloseAuditRow {
  file: string;
  item: string;
  question: string;
  evidence: string;
  gap: string;
  nextAction: string;
  status: L14CloseAuditStatus;
  evidencePaths: string[];
}

export interface L14CloseAuditViolation {
  file: string;
  item?: string;
  reason:
    | "missing_section"
    | "missing_table"
    | "malformed_row"
    | "missing_expected_item"
    | "unknown_status"
    | "missing_evidence_path"
    | "missing_required_evidence_path"
    | "missing_boundary_marker"
    | "partial_without_gap"
    | "open_without_next_action";
}

export interface L14CloseAuditResult {
  checked: number;
  rows: L14CloseAuditRow[];
  violations: L14CloseAuditViolation[];
  ok: boolean;
}

const SECTION_RE = /^##\s+L14 Close System Foundation Audit Matrix\s*$/m;
const NEXT_SECTION_RE = /^##\s+/m;
const EVIDENCE_PATH_RE = /`([^`]+)`/g;
const VALID_STATUSES = new Set<L14CloseAuditStatus>([
  "closed",
  "partial",
  "human_required",
  "external_required",
  "parked_future",
]);

const EXPECTED_ITEMS = [
  "workflow-definition",
  "system-foundation",
  "claude-codex-parity",
  "clean-distribution-package",
  "version-up-nonbreaking",
  "brownfield-onboarding",
  "cross-project-test-workflow",
  "l1-l2-mock-roundtrip",
  "l10-ux-close",
  "l11-uat-boundary",
  "l12-release-acceptance-boundary",
  "l13-post-deploy-boundary",
  "l14-ops-feedback-boundary",
  "drive-model-bookbinding",
  "l8-l14-right-arm",
  "release-publication-boundary",
  "green-evidence-integrity",
] as const;

const REQUIRED_EVIDENCE_BY_ITEM: Partial<Record<(typeof EXPECTED_ITEMS)[number], string[]>> = {
  "workflow-definition": [
    "docs/process/forward/L08-L14-verification-phase.md",
    "docs/process/forward/overview.md",
    "src/lint/roadmap-registry.ts",
    "tests/roadmap.test.ts",
  ],
  "system-foundation": [
    "src/doctor/index.ts",
    "tests/doctor.test.ts",
    "src/lint/runtime-portability.ts",
    "tests/runtime-portability.test.ts",
    "package.json",
  ],
  "claude-codex-parity": [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "src/lint/codex-hook-adapter.ts",
    "tests/codex-hook-adapter.test.ts",
    "tests/runtime-hook-entrypoints.test.ts",
  ],
  "clean-distribution-package": [
    "src/setup/index.ts",
    "tests/setup.test.ts",
    "tests/distribution-acceptance.test.ts",
    "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
    "docs/templates/adapter/.claude/settings.json",
    "docs/templates/adapter/.codex/hooks.json",
    "README.md",
    "LICENSE",
  ],
  "version-up-nonbreaking": [
    "src/setup/index.ts",
    "tests/setup.test.ts",
    "docs/process/modes/version-up.md",
    "docs/plans/PLAN-REVERSE-140-forward-convergence-version-up-backfill.md",
    "docs/plans/PLAN-L7-141-web-dashboard-component-derived.md",
    "docs/plans/PLAN-L7-146-serverless-readonly-share.md",
  ],
  "brownfield-onboarding": [
    "src/setup/index.ts",
    "tests/setup.test.ts",
    "docs/templates/adapter/AGENTS.md",
    "docs/templates/adapter/CLAUDE.md",
    "docs/templates/adapter/.claude/settings.json",
  ],
  "cross-project-test-workflow": [
    "tests/distribution-acceptance.test.ts",
    "tests/runtime-portability.test.ts",
    "src/setup/index.ts",
    ".github/workflows/harness-check.yml",
  ],
  "l1-l2-mock-roundtrip": [
    "docs/design/harness/L2-screen/wireframe.md",
    "docs/design/harness/L2-screen/screen-list.md",
    "src/lint/screen-impl-pair-freeze.ts",
    "src/lint/doc-consistency.ts",
    "tests/screen-impl-pair-freeze.test.ts",
    "tests/projection-writer.test.ts",
  ],
  "l10-ux-close": [
    "docs/design/harness/L10-ux/visual-design.md",
    ".ut-tdd/evidence/g10-ux/20260629-ux-minimum.json",
    "src/lint/g10-ux-workflow.ts",
    "tests/g10-ux-workflow.test.ts",
    "tests/screen-impl-pair-freeze.test.ts",
  ],
  "drive-model-bookbinding": [
    "docs/design/harness/L4-basic-design/function.md",
    "docs/process/modes/README.md",
    "src/lint/forward-convergence.ts",
    "tests/forward-convergence.test.ts",
    "src/lint/drive-model-passage.ts",
  ],
  "green-evidence-integrity": [
    "src/lint/green-command-digest.ts",
    "tests/green-command-digest.test.ts",
    "docs/plans/PLAN-L7-132-green-command-digest-integrity.md",
    "docs/plans/PLAN-L7-174-green-command-digest-correction.md",
    ".ut-tdd/audit/A-155-green-command-digest-rebind-2026-07-01.md",
  ],
};

const REQUIRED_BOUNDARY_MARKERS_BY_ITEM: Partial<
  Record<(typeof EXPECTED_ITEMS)[number], { gap: string[]; nextAction: string[] }>
> = {
  "claude-codex-parity": {
    gap: ["hosted/api"],
    nextAction: ["hosted/api", "preflight"],
  },
  "clean-distribution-package": {
    gap: ["signed tarball"],
    nextAction: ["signature"],
  },
  "version-up-nonbreaking": {
    gap: ["multi-version consumer upgrade"],
    nextAction: ["tag-pin", "rollback"],
  },
  "l11-uat-boundary": {
    gap: ["po", "uat"],
    nextAction: ["po uat"],
  },
  "l12-release-acceptance-boundary": {
    gap: ["approved release target", "human signoff"],
    nextAction: ["release acceptance"],
  },
  "l13-post-deploy-boundary": {
    gap: ["public", "consumer deployment"],
    nextAction: ["after publication", "post-deploy"],
  },
  "l14-ops-feedback-boundary": {
    gap: ["real operations data", "released consumer project"],
    nextAction: ["post-release operations", "feedback_events"],
  },
  "l8-l14-right-arm": {
    gap: ["po final signoff", "post-deploy"],
    nextAction: ["po signoff", "post-deploy"],
  },
  "release-publication-boundary": {
    gap: ["signed tarball"],
    nextAction: ["signature"],
  },
};

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

function normalizeStatus(raw: string): L14CloseAuditStatus | null {
  const cleaned = raw.replaceAll("`", "").trim();
  return VALID_STATUSES.has(cleaned as L14CloseAuditStatus)
    ? (cleaned as L14CloseAuditStatus)
    : null;
}

function evidencePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(EVIDENCE_PATH_RE)) {
    const value = match[1]?.trim();
    if (!value) continue;
    if (
      value.startsWith(".ut-tdd/") ||
      value.startsWith(".claude/") ||
      value.startsWith(".codex/") ||
      value.startsWith("docs/") ||
      value.startsWith("src/") ||
      value.startsWith("tests/") ||
      value.startsWith(".github/") ||
      value === "package.json" ||
      value === "LICENSE" ||
      value === "README.md" ||
      value === "AGENTS.md" ||
      value === "CLAUDE.md"
    ) {
      paths.push(value);
    }
  }
  return paths;
}

function pathExists(repoRoot: string, path: string): boolean {
  return existsSync(join(repoRoot, path));
}

function hasAllMarkers(text: string, markers: string[]): boolean {
  const normalized = text.toLowerCase();
  return markers.every((marker) => normalized.includes(marker.toLowerCase()));
}

export function analyzeL14CloseAudit(
  docs: L14CloseAuditDoc[],
  repoRoot: string = process.cwd(),
): L14CloseAuditResult {
  const rows: L14CloseAuditRow[] = [];
  const violations: L14CloseAuditViolation[] = [];

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
      item: header.indexOf("item"),
      question: header.indexOf("audit question"),
      evidence: header.indexOf("current evidence"),
      gap: header.indexOf("gap / boundary"),
      next: header.indexOf("next action"),
      status: header.indexOf("status"),
    };
    if (Object.values(indexes).some((index) => index < 0)) {
      violations.push({ file: doc.file, reason: "malformed_row" });
      continue;
    }

    for (const cells of parsed.slice(1)) {
      const item = cells[indexes.item] ?? "";
      const question = cells[indexes.question] ?? "";
      const evidence = cells[indexes.evidence] ?? "";
      const gap = cells[indexes.gap] ?? "";
      const nextAction = cells[indexes.next] ?? "";
      const status = normalizeStatus(cells[indexes.status] ?? "");
      if (!item || !question || !evidence || !gap || !nextAction) {
        violations.push({ file: doc.file, item: item || undefined, reason: "malformed_row" });
        continue;
      }
      if (!status) {
        violations.push({ file: doc.file, item, reason: "unknown_status" });
        continue;
      }
      const paths = evidencePaths(evidence);
      if (paths.length === 0 || paths.some((path) => !pathExists(repoRoot, path))) {
        violations.push({ file: doc.file, item, reason: "missing_evidence_path" });
      }
      const requiredPaths =
        REQUIRED_EVIDENCE_BY_ITEM[item as (typeof EXPECTED_ITEMS)[number]] ?? [];
      if (requiredPaths.some((path) => !paths.includes(path))) {
        violations.push({ file: doc.file, item, reason: "missing_required_evidence_path" });
      }
      const requiredBoundary =
        REQUIRED_BOUNDARY_MARKERS_BY_ITEM[item as (typeof EXPECTED_ITEMS)[number]];
      if (
        requiredBoundary &&
        (!hasAllMarkers(gap, requiredBoundary.gap) ||
          !hasAllMarkers(nextAction, requiredBoundary.nextAction))
      ) {
        violations.push({ file: doc.file, item, reason: "missing_boundary_marker" });
      }
      if (status === "partial" && /^(none|n\/a|なし)$/i.test(gap.trim())) {
        violations.push({ file: doc.file, item, reason: "partial_without_gap" });
      }
      if (
        (status === "partial" ||
          status === "human_required" ||
          status === "external_required" ||
          status === "parked_future") &&
        /^(none|n\/a|なし)$/i.test(nextAction.trim())
      ) {
        violations.push({ file: doc.file, item, reason: "open_without_next_action" });
      }
      rows.push({
        file: doc.file,
        item,
        question,
        evidence,
        gap,
        nextAction,
        status,
        evidencePaths: paths,
      });
    }

    const seen = new Set(rows.filter((row) => row.file === doc.file).map((row) => row.item));
    for (const item of EXPECTED_ITEMS) {
      if (!seen.has(item))
        violations.push({ file: doc.file, item, reason: "missing_expected_item" });
    }
  }

  return { checked: docs.length, rows, violations, ok: docs.length > 0 && violations.length === 0 };
}

export function loadL14CloseAuditDocs(repoRoot: string = process.cwd()): L14CloseAuditDoc[] {
  const target = join(repoRoot, ".ut-tdd", "audit", "A-143-l14-close-system-foundation-audit.md");
  if (!existsSync(target)) return [];
  return [
    {
      file: join(".ut-tdd", "audit", "A-143-l14-close-system-foundation-audit.md"),
      content: readFileSync(target, "utf8"),
    },
  ];
}

export function l14CloseAuditMessages(result: L14CloseAuditResult): string[] {
  if (result.checked === 0) return ["l14-close-audit - violation: A-143 audit not found"];
  if (result.violations.length > 0) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.file}${v.item ? `:${v.item}` : ""}:${v.reason}`)
      .join(", ");
    return [
      `l14-close-audit - violation ${result.violations.length} (${sample}); L14 close audit rows need real evidence, explicit gaps, and next actions`,
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
    `l14-close-audit - OK (checked=${result.checked}, rows=${result.rows.length}, ${summary})`,
  ];
}
