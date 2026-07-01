import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FrRoadmapCoverageStatus = "closed" | "scheduled" | "parked" | "PO decision";

export interface FrRoadmapCoverageDoc {
  file: string;
  content: string;
}

export interface FrRoadmapCoverageRow {
  file: string;
  bucket: string;
  upstreamSource: string;
  currentRoute: string;
  vmodelState: string;
  requiredNextArtifact: string;
  status: FrRoadmapCoverageStatus;
}

export interface FrRoadmapClosureEvidenceRow {
  file: string;
  bucket: string;
  planTarget: string;
  sourceTarget: string;
  testTarget: string;
  coverageGate: string;
  status: FrRoadmapCoverageStatus;
}

export interface FrRoadmapCoverageViolation {
  file: string;
  bucket?: string;
  reason:
    | "missing_section"
    | "missing_table"
    | "malformed_row"
    | "missing_expected_bucket"
    | "missing_upstream_source"
    | "missing_current_route"
    | "missing_vmodel_state"
    | "missing_next_artifact"
    | "unknown_status"
    | "ambiguous_resolution"
    | "missing_closure_section"
    | "missing_closure_table"
    | "malformed_closure_row"
    | "missing_closure_evidence"
    | "missing_plan_target"
    | "missing_source_target"
    | "missing_test_target"
    | "missing_coverage_gate"
    | "missing_evidence_file"
    | "closure_status_mismatch";
}

export interface FrRoadmapCoverageResult {
  checked: number;
  rows: FrRoadmapCoverageRow[];
  closureRows: FrRoadmapClosureEvidenceRow[];
  openRows: FrRoadmapCoverageRow[];
  violations: FrRoadmapCoverageViolation[];
  ok: boolean;
}

const SECTION_RE = /^##\s+Residual Feature Buckets\s*$/m;
const CLOSURE_SECTION_RE = /^##\s+Residual Feature Closure Evidence\s*$/m;
const NEXT_SECTION_RE = /^##\s+/m;
const EXPECTED_BUCKETS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"] as const;
const VALID_STATUSES = new Set<FrRoadmapCoverageStatus>([
  "closed",
  "scheduled",
  "parked",
  "PO decision",
]);
const RESOLUTION_PATTERN = /\b(plans?|wbs|park|po decision|owner|scheduled)\b/i;

function section(content: string): string {
  return sectionBy(content, SECTION_RE);
}

function closureSection(content: string): string {
  return sectionBy(content, CLOSURE_SECTION_RE);
}

function sectionBy(content: string, re: RegExp): string {
  const match = content.match(re);
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

function normalizeStatus(raw: string): FrRoadmapCoverageStatus | null {
  const cleaned = raw.replaceAll("`", "").trim();
  return VALID_STATUSES.has(cleaned as FrRoadmapCoverageStatus)
    ? (cleaned as FrRoadmapCoverageStatus)
    : null;
}

function bucketId(raw: string): string {
  return raw.match(/\bR\d+\b/)?.[0] ?? raw.trim();
}

function stripMarkdown(raw: string): string {
  return raw
    .replaceAll("`", "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$2")
    .trim();
}

function pathFromTarget(raw: string): string | null {
  const cleaned = stripMarkdown(raw).split("#")[0].trim();
  if (!cleaned || /^N\/A$/i.test(cleaned)) return null;
  const first = cleaned.split(/\s*(?:,|;|<br\s*\/?>)\s*/i)[0]?.trim();
  return first || null;
}

function targetExists(repoRoot: string, raw: string): boolean {
  const p = pathFromTarget(raw);
  if (!p) return false;
  return existsSync(join(repoRoot, p));
}

function parseClosureRows(
  doc: FrRoadmapCoverageDoc,
  violations: FrRoadmapCoverageViolation[],
): FrRoadmapClosureEvidenceRow[] {
  const body = closureSection(doc.content);
  if (!body) {
    violations.push({ file: doc.file, reason: "missing_closure_section" });
    return [];
  }
  const parsed = tableRows(body);
  if (parsed.length < 2) {
    violations.push({ file: doc.file, reason: "missing_closure_table" });
    return [];
  }
  const header = parsed[0].map((cell) => cell.toLowerCase());
  const indexes = {
    bucket: header.indexOf("bucket"),
    plan: header.indexOf("plan / wbs"),
    source: header.indexOf("l7 source"),
    test: header.indexOf("test file / oracle citation"),
    gate: header.indexOf("coverage gate"),
    status: header.indexOf("status"),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    violations.push({ file: doc.file, reason: "malformed_closure_row" });
    return [];
  }

  const out: FrRoadmapClosureEvidenceRow[] = [];
  for (const cells of parsed.slice(1)) {
    const bucket = bucketId(cells[indexes.bucket] ?? "");
    const planTarget = cells[indexes.plan] ?? "";
    const sourceTarget = cells[indexes.source] ?? "";
    const testTarget = cells[indexes.test] ?? "";
    const coverageGate = cells[indexes.gate] ?? "";
    const status = normalizeStatus(cells[indexes.status] ?? "");
    if (!bucket || !planTarget || !sourceTarget || !testTarget || !coverageGate || !status) {
      violations.push({
        file: doc.file,
        bucket: bucket || undefined,
        reason: "malformed_closure_row",
      });
      continue;
    }
    out.push({
      file: doc.file,
      bucket,
      planTarget,
      sourceTarget,
      testTarget,
      coverageGate,
      status,
    });
  }
  return out;
}

export function analyzeFrRoadmapCoverage(docs: FrRoadmapCoverageDoc[]): FrRoadmapCoverageResult {
  return analyzeFrRoadmapCoverageWithRoot(docs, process.cwd());
}

export function analyzeFrRoadmapCoverageWithRoot(
  docs: FrRoadmapCoverageDoc[],
  repoRoot: string,
): FrRoadmapCoverageResult {
  const rows: FrRoadmapCoverageRow[] = [];
  const closureRows: FrRoadmapClosureEvidenceRow[] = [];
  const violations: FrRoadmapCoverageViolation[] = [];

  for (const doc of docs) {
    const docRows: FrRoadmapCoverageRow[] = [];
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
      bucket: header.indexOf("bucket"),
      upstream: header.indexOf("upstream source"),
      route: header.indexOf("current route"),
      state: header.indexOf("v-model state"),
      next: header.indexOf("required next artifact"),
      status: header.indexOf("status"),
    };
    if (Object.values(indexes).some((index) => index < 0)) {
      violations.push({ file: doc.file, reason: "malformed_row" });
      continue;
    }

    for (const cells of parsed.slice(1)) {
      const bucket = bucketId(cells[indexes.bucket] ?? "");
      const upstreamSource = cells[indexes.upstream] ?? "";
      const currentRoute = cells[indexes.route] ?? "";
      const vmodelState = cells[indexes.state] ?? "";
      const requiredNextArtifact = cells[indexes.next] ?? "";
      const status = normalizeStatus(cells[indexes.status] ?? "");
      if (!bucket || !upstreamSource || !currentRoute || !vmodelState || !requiredNextArtifact) {
        violations.push({ file: doc.file, bucket: bucket || undefined, reason: "malformed_row" });
        continue;
      }
      if (!upstreamSource.trim())
        violations.push({ file: doc.file, bucket, reason: "missing_upstream_source" });
      if (!currentRoute.trim())
        violations.push({ file: doc.file, bucket, reason: "missing_current_route" });
      if (!vmodelState.trim())
        violations.push({ file: doc.file, bucket, reason: "missing_vmodel_state" });
      if (!requiredNextArtifact.trim())
        violations.push({ file: doc.file, bucket, reason: "missing_next_artifact" });
      if (!status) {
        violations.push({ file: doc.file, bucket, reason: "unknown_status" });
        continue;
      }
      if (status !== "closed" && !RESOLUTION_PATTERN.test(requiredNextArtifact)) {
        violations.push({ file: doc.file, bucket, reason: "ambiguous_resolution" });
      }
      const row = {
        file: doc.file,
        bucket,
        upstreamSource,
        currentRoute,
        vmodelState,
        requiredNextArtifact,
        status,
      };
      rows.push(row);
      docRows.push(row);
    }

    if (docRows.some((row) => row.status === "closed")) {
      closureRows.push(...parseClosureRows(doc, violations));
    }

    const seen = new Set(rows.filter((row) => row.file === doc.file).map((row) => row.bucket));
    for (const bucket of EXPECTED_BUCKETS) {
      if (!seen.has(bucket)) {
        violations.push({ file: doc.file, bucket, reason: "missing_expected_bucket" });
      }
    }
  }

  const closureByDocBucket = new Map(closureRows.map((row) => [`${row.file}:${row.bucket}`, row]));
  for (const row of rows) {
    if (row.status !== "closed") continue;
    const evidence = closureByDocBucket.get(`${row.file}:${row.bucket}`);
    if (!evidence) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_closure_evidence" });
      continue;
    }
    if (evidence.status !== "closed") {
      violations.push({ file: row.file, bucket: row.bucket, reason: "closure_status_mismatch" });
    }
    if (!pathFromTarget(evidence.planTarget)) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_plan_target" });
    } else if (!targetExists(repoRoot, evidence.planTarget)) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_evidence_file" });
    }
    if (!pathFromTarget(evidence.sourceTarget)) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_source_target" });
    } else if (!targetExists(repoRoot, evidence.sourceTarget)) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_evidence_file" });
    }
    if (!pathFromTarget(evidence.testTarget)) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_test_target" });
    } else if (!targetExists(repoRoot, evidence.testTarget)) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_evidence_file" });
    }
    if (!stripMarkdown(evidence.coverageGate)) {
      violations.push({ file: row.file, bucket: row.bucket, reason: "missing_coverage_gate" });
    }
  }

  const openRows = rows.filter((row) => row.status !== "closed");
  return {
    checked: docs.length,
    rows,
    closureRows,
    openRows,
    violations,
    ok: violations.length === 0 && openRows.length === 0,
  };
}

export function loadFrRoadmapCoverageDocs(
  repoRoot: string = process.cwd(),
): FrRoadmapCoverageDoc[] {
  const target = join(repoRoot, ".ut-tdd", "audit", "A-133-upstream-vmodel-coverage-audit.md");
  if (!existsSync(target)) return [];
  return [
    {
      file: join(".ut-tdd", "audit", "A-133-upstream-vmodel-coverage-audit.md"),
      content: readFileSync(target, "utf8"),
    },
  ];
}

export function frRoadmapCoverageMessages(result: FrRoadmapCoverageResult): string[] {
  if (result.checked === 0) {
    return ["fr-roadmap-coverage - violation: residual bucket table not found"];
  }
  if (result.violations.length > 0) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.file}${v.bucket ? `:${v.bucket}` : ""}:${v.reason}`)
      .join(", ");
    return [
      `fr-roadmap-coverage - violation ${result.violations.length} (${sample}); residual buckets must resolve to child PLAN/WBS, park, or PO decision`,
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
      `fr-roadmap-coverage - non-closed ${result.openRows.length} (${summary}); buckets=${result.openRows.map((row) => row.bucket).join(",")}`,
    ];
  }
  return [
    `fr-roadmap-coverage - OK (checked=${result.checked}, buckets=${result.rows.length}, closure=${result.closureRows.length})`,
  ];
}
