import { createHash } from "node:crypto";
import { normalizePath } from "../lint/shared";

export type CanonicalDocumentFamily =
  | "concept"
  | "requirements"
  | "design"
  | "plan"
  | "adr"
  | "test-design";

export type DocumentExportFormat = "csv" | "markdown" | "xlsx" | "pptx";

export type DocumentExportFindingCode =
  | "unsupported-family"
  | "missing-source-path"
  | "redacted-sensitive-field"
  | "large-document-split"
  | "renderer-unavailable"
  | "stale-source-snapshot";

export interface DocumentExportFinding {
  code: DocumentExportFindingCode;
  severity: "error" | "warn" | "info";
  message: string;
  sourcePath?: string;
}

export interface CanonicalDocumentInput {
  family: string;
  sourcePath: string;
  content: string;
}

export interface CanonicalDocumentSection {
  id: string;
  heading: string;
  anchor: string;
  level: number;
  text: string;
}

export interface CanonicalDocumentProjection {
  family: CanonicalDocumentFamily | "unknown";
  sourcePath: string;
  sections: CanonicalDocumentSection[];
  traceIds: string[];
  evidenceLinks: string[];
  findings: DocumentExportFinding[];
  sourceHash: string;
  ok: boolean;
}

export interface DocumentExportDatasetInput {
  projections: CanonicalDocumentProjection[];
  format: DocumentExportFormat;
  maxRowsPerChunk?: number;
}

export interface DocumentExportDatasetRow {
  family: string;
  source_path: string;
  section_id: string;
  anchor: string;
  heading: string;
  trace_ids: string[];
  evidence_links: string[];
  text: string;
}

export interface DocumentExportDataset {
  datasetId: string;
  format: DocumentExportFormat;
  rows: DocumentExportDatasetRow[];
  chunks: DocumentExportDatasetRow[][];
  findings: DocumentExportFinding[];
  ok: boolean;
}

export interface DocumentExportRenderInput {
  dataset: DocumentExportDataset;
  format: DocumentExportFormat;
  rendererReady?: boolean;
}

export interface DocumentExportRenderResult {
  format: DocumentExportFormat;
  content: string;
  findings: DocumentExportFinding[];
  ok: boolean;
}

export interface DocumentExportArtifactInput {
  runId: string;
  datasetId: string;
  artifactPath: string;
  format: DocumentExportFormat;
  sourceSnapshotHash: string;
  previousSourceSnapshotHash?: string;
  evidencePath: string;
}

export interface DocumentExportProjectionRows {
  document_export_runs: Array<{
    document_export_run_id: string;
    source_snapshot_hash: string;
    evidence_path: string;
  }>;
  document_export_datasets: Array<{
    document_export_dataset_id: string;
    document_export_run_id: string;
    format: DocumentExportFormat;
  }>;
  document_export_artifacts: Array<{
    document_export_run_id: string;
    document_export_dataset_id: string;
    artifact_path: string;
    format: DocumentExportFormat;
    source_snapshot_hash: string;
    stale: boolean;
    derived: boolean;
  }>;
  findings: DocumentExportFinding[];
  actionsTaken: string[];
  ok: boolean;
}

const SUPPORTED_FAMILIES = new Set<CanonicalDocumentFamily>([
  "concept",
  "requirements",
  "design",
  "plan",
  "adr",
  "test-design",
]);

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function finding(input: {
  code: DocumentExportFindingCode;
  message: string;
  severity?: "error" | "warn" | "info";
  sourcePath?: string;
}): DocumentExportFinding {
  return {
    code: input.code,
    severity: input.severity ?? "warn",
    message: input.message,
    sourcePath: input.sourcePath,
  };
}

function anchorFor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function traceIds(content: string): string[] {
  const matches =
    content.match(/\b(?:FR|AC|AT)-L\d+-\d+\b|\bPLAN-[A-Z0-9]+(?:-[A-Z0-9]+)*\b|\bADR-\d+\b/g) ?? [];
  return [...new Set(matches)].sort();
}

function evidenceLinks(content: string): string[] {
  const matches = content.match(/(?:docs|\.ut-tdd)\/[A-Za-z0-9._/-]+/g) ?? [];
  return [...new Set(matches)].sort();
}

function splitSections(content: string): CanonicalDocumentSection[] {
  const lines = content.split(/\r?\n/);
  const sections: CanonicalDocumentSection[] = [];
  let current: CanonicalDocumentSection | null = null;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (current) sections.push(current);
      const title = heading[2].trim();
      current = {
        id: `section:${anchorFor(title)}`,
        heading: title,
        anchor: anchorFor(title),
        level: heading[1].length,
        text: "",
      };
    } else if (current) {
      current.text = `${current.text}${current.text ? "\n" : ""}${line}`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function parseCanonicalDocumentStructure(
  input: CanonicalDocumentInput,
): CanonicalDocumentProjection {
  const sourcePath = normalizePath(input.sourcePath);
  const findings: DocumentExportFinding[] = [];
  const family = SUPPORTED_FAMILIES.has(input.family as CanonicalDocumentFamily)
    ? (input.family as CanonicalDocumentFamily)
    : "unknown";
  if (family === "unknown") {
    findings.push(
      finding({
        code: "unsupported-family",
        message: `unsupported document family: ${input.family}`,
        severity: "error",
        sourcePath,
      }),
    );
  }
  if (!sourcePath) {
    findings.push(
      finding({
        code: "missing-source-path",
        message: "sourcePath is required",
        severity: "error",
      }),
    );
  }
  const sections = findings.some((item) => item.severity === "error")
    ? []
    : splitSections(input.content);
  return {
    family,
    sourcePath,
    sections,
    traceIds: traceIds(input.content),
    evidenceLinks: evidenceLinks(input.content),
    findings,
    sourceHash: hash(input.content),
    ok: !findings.some((item) => item.severity === "error"),
  };
}

function redactText(text: string): { text: string; redacted: boolean } {
  // `\b` word boundary so the `sk-` API-key pattern only matches a token that
  // STARTS with `sk-` (a real key is a standalone token: `sk-...` / `sk-ant-...`).
  // Without it the bare `sk-[...]+` matched the `sk-` substring inside innocent
  // hyphenated words (`task-classify` -> `sk-classify`, `risk-policy` ->
  // `sk-policy`, `desk-review` -> `sk-review`), over-redacting 16 canonical docs
  // (same false-positive class as PLAN-L7-74's whole-word risk match, PLAN-L7-143).
  const redacted = text
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/rawMcpResponse\s*:\s*\S+/gi, "<redacted>");
  return { text: redacted, redacted: redacted !== text };
}

function chunkRows(rows: DocumentExportDatasetRow[], size: number): DocumentExportDatasetRow[][] {
  const chunks: DocumentExportDatasetRow[][] = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

export function buildDocumentExportDataset(
  input: DocumentExportDatasetInput,
): DocumentExportDataset {
  const findings: DocumentExportFinding[] = [];
  const rows: DocumentExportDatasetRow[] = [];
  for (const projection of [...input.projections].sort((a, b) =>
    a.sourcePath.localeCompare(b.sourcePath),
  )) {
    for (const section of projection.sections) {
      const redacted = redactText(section.text);
      if (redacted.redacted) {
        findings.push(
          finding({
            code: "redacted-sensitive-field",
            message: "sensitive or raw provider/tool payload text was redacted",
            sourcePath: projection.sourcePath,
          }),
        );
      }
      rows.push({
        family: projection.family,
        source_path: projection.sourcePath,
        section_id: section.id,
        anchor: section.anchor,
        heading: section.heading,
        trace_ids: projection.traceIds,
        evidence_links: projection.evidenceLinks,
        text: redacted.text,
      });
    }
  }
  rows.sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      a.source_path.localeCompare(b.source_path) ||
      a.anchor.localeCompare(b.anchor),
  );
  // `?? ` は 0 を捕捉しない (0 は null/undefined でない)。maxRowsPerChunk=0 だと
  // chunkRows の i+=0 が無限ループになるため、下限 1 を強制する。
  const maxRowsPerChunk = Math.max(1, input.maxRowsPerChunk ?? (rows.length || 1));
  const chunks = chunkRows(rows, maxRowsPerChunk);
  if (chunks.length > 1) {
    findings.push(
      finding({
        code: "large-document-split",
        message: `document export split into ${chunks.length} chunks`,
        severity: "info",
      }),
    );
  }
  return {
    datasetId: hash(JSON.stringify(rows)),
    format: input.format,
    rows,
    chunks,
    findings,
    ok: !findings.some((item) => item.severity === "error"),
  };
}

function csvEscape(value: string): string {
  // CSV formula injection 防御: =,+,-,@ 始まりは Excel/Sheets で式評価されるため `'` を前置 (OWASP)。
  // xlsx/pptx は Office 消費前提なので built-in CSV でも同等にエスケープする。
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function renderCsv(dataset: DocumentExportDataset): string {
  const header = ["family", "source_path", "section_id", "anchor", "heading", "trace_ids"];
  const rows = dataset.rows.map((row) =>
    [row.family, row.source_path, row.section_id, row.anchor, row.heading, row.trace_ids.join(";")]
      .map(csvEscape)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

function renderMarkdown(dataset: DocumentExportDataset): string {
  const lines = ["| family | source_path | section | trace_ids |", "|---|---|---|---|"];
  for (const row of dataset.rows) {
    lines.push(
      `| ${row.family} | ${row.source_path} | ${row.heading} | ${row.trace_ids.join(", ")} |`,
    );
  }
  return lines.join("\n");
}

export function renderDocumentExport(input: DocumentExportRenderInput): DocumentExportRenderResult {
  // pure core は CSV/Markdown のみを render する (PLAN-L7-35: built-in render = CSV/Markdown,
  // Office renderer は readiness evidence が出るまで disabled、renderer invocation を導入しない)。
  // xlsx/pptx は rendererReady の真偽に関わらず markdown へ fall-through させない —
  // させると markdown bytes を format:"xlsx" として mislabel し、ok:true で overclaim になる。
  // rendererReady は finding メッセージ (readiness probe 結果) を変えるだけで content は常に空。
  if (input.format === "xlsx" || input.format === "pptx") {
    return {
      format: input.format,
      content: "",
      findings: [
        finding({
          code: "renderer-unavailable",
          message: input.rendererReady
            ? `${input.format} renderer marked ready but Office rendering is not part of the pure core; no implicit invocation`
            : `${input.format} renderer is unavailable; no implicit install or invocation`,
        }),
      ],
      ok: false,
    };
  }
  return {
    format: input.format,
    content: input.format === "csv" ? renderCsv(input.dataset) : renderMarkdown(input.dataset),
    findings: [],
    ok: true,
  };
}

export function recordDocumentExportArtifact(
  input: DocumentExportArtifactInput,
): DocumentExportProjectionRows {
  const artifactPath = normalizePath(input.artifactPath);
  const evidencePath = normalizePath(input.evidencePath);
  const stale =
    Boolean(input.previousSourceSnapshotHash) &&
    input.previousSourceSnapshotHash !== input.sourceSnapshotHash;
  const findings = stale
    ? [
        finding({
          code: "stale-source-snapshot",
          message: "existing generated artifact source snapshot is stale",
        }),
      ]
    : [];
  return {
    document_export_runs: [
      {
        document_export_run_id: input.runId,
        source_snapshot_hash: input.sourceSnapshotHash,
        evidence_path: evidencePath,
      },
    ],
    document_export_datasets: [
      {
        document_export_dataset_id: input.datasetId,
        document_export_run_id: input.runId,
        format: input.format,
      },
    ],
    document_export_artifacts: [
      {
        document_export_run_id: input.runId,
        document_export_dataset_id: input.datasetId,
        artifact_path: artifactPath,
        format: input.format,
        source_snapshot_hash: input.sourceSnapshotHash,
        stale,
        derived: true,
      },
    ],
    findings,
    actionsTaken: [],
    ok: !stale,
  };
}
