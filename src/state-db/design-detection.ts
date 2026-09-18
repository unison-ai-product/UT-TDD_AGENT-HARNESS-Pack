import type { HarnessDb } from "./index.ts";

export const DESIGN_QUALITY_CHECK_IDS = [
  "doc-consistency",
  "entity-coverage",
  "fr-registry-audit",
  "sub-doc-catalog-drift",
  "sub-doc-section-structure",
  "l6-fr-coverage",
  "fr-roadmap-coverage",
  "module-drift",
] as const;

export type DesignQualityCheckId = (typeof DESIGN_QUALITY_CHECK_IDS)[number];

export interface DesignQualityCoverageRow {
  subject_id: string;
  metric: string;
  value: number;
  threshold: number;
  status: string;
}

export interface DesignPairOrphanFinding {
  finding_id: string;
  kind: string;
  severity: string;
  subject_id: string;
  source: string;
  status: string;
  evidence_path: string;
}

export interface DesignDetectionStats {
  coverageRows: DesignQualityCoverageRow[];
  missingCoverage: string[];
  blockedCoverage: DesignQualityCoverageRow[];
  pairOrphanFindings: DesignPairOrphanFinding[];
}

export interface DesignDetectionResult extends DesignDetectionStats {
  ok: boolean;
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function collectDesignDetectionStats(db: HarnessDb): DesignDetectionStats {
  const coverageRows = db
    .prepare(
      `SELECT subject_id, metric, value, threshold, status
         FROM coverage
        WHERE scope = 'design-quality' AND metric = 'violation_count'
        ORDER BY subject_id`,
    )
    .all()
    .map((row) => ({
      subject_id: String(row.subject_id ?? ""),
      metric: String(row.metric ?? ""),
      value: numeric(row.value),
      threshold: numeric(row.threshold),
      status: String(row.status ?? ""),
    }));
  const present = new Set(coverageRows.map((row) => row.subject_id));
  const missingCoverage = DESIGN_QUALITY_CHECK_IDS.filter((id) => !present.has(id));
  const blockedCoverage = coverageRows.filter(
    (row) => row.status !== "passed" || row.value > row.threshold,
  );
  const pairOrphanFindings = db
    .prepare(
      `SELECT finding_id, kind, severity, subject_id, source, status, evidence_path
         FROM findings
        WHERE kind LIKE 'design-pair-orphan:%' AND status = 'open'
        ORDER BY kind, subject_id`,
    )
    .all()
    .map((row) => ({
      finding_id: String(row.finding_id ?? ""),
      kind: String(row.kind ?? ""),
      severity: String(row.severity ?? ""),
      subject_id: String(row.subject_id ?? ""),
      source: String(row.source ?? ""),
      status: String(row.status ?? ""),
      evidence_path: String(row.evidence_path ?? ""),
    }));
  return { coverageRows, missingCoverage, blockedCoverage, pairOrphanFindings };
}

export function analyzeDesignDetectionStats(stats: DesignDetectionStats): DesignDetectionResult {
  return {
    ...stats,
    ok:
      stats.missingCoverage.length === 0 &&
      stats.blockedCoverage.length === 0 &&
      stats.pairOrphanFindings.length === 0,
  };
}

export function designDetectionMessages(result: DesignDetectionResult): string[] {
  if (result.ok) {
    return [`design-detection - OK (coverage=${result.coverageRows.length}, pair_orphans=0)`];
  }
  const messages = [
    `design-detection - violation: missing_coverage=${result.missingCoverage.length}, blocked_coverage=${result.blockedCoverage.length}, pair_orphans=${result.pairOrphanFindings.length}`,
  ];
  if (result.missingCoverage.length > 0) {
    messages.push(`design-detection - missing coverage: ${result.missingCoverage.join(", ")}`);
  }
  if (result.blockedCoverage.length > 0) {
    const sample = result.blockedCoverage
      .slice(0, 8)
      .map((row) => `${row.subject_id}=${row.value}/${row.threshold}:${row.status}`)
      .join(", ");
    messages.push(`design-detection - blocked coverage: ${sample}`);
  }
  if (result.pairOrphanFindings.length > 0) {
    const sample = result.pairOrphanFindings
      .slice(0, 8)
      .map((row) => `${row.kind}:${row.subject_id}`)
      .join(", ");
    messages.push(`design-detection - pair orphan findings: ${sample}`);
  }
  return messages;
}
