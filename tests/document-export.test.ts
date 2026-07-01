import { describe, expect, it } from "vitest";
import {
  buildDocumentExportDataset,
  parseCanonicalDocumentStructure,
  recordDocumentExportArtifact,
  renderDocumentExport,
} from "../src/export/document-export";

const requirementsDoc = `# Requirements

## FR-L1-01 Feature

- AC-L1-01: must work.
- AT-L1-01: accepted by test.

Evidence: docs/plans/PLAN-L7-35-canonical-document-export.md
`;

describe("canonical document export (U-DOCEXPORT-001..012)", () => {
  it("U-DOCEXPORT-001: parser accepts supported canonical families with repo-relative paths", () => {
    const families = ["concept", "requirements", "design", "plan", "adr", "test-design"] as const;

    expect(
      families.map(
        (family) =>
          parseCanonicalDocumentStructure({
            family,
            sourcePath: `docs/${family}/sample.md`,
            content: "# Title\n\n## Section\n",
          }).family,
      ),
    ).toEqual([...families]);
  });

  it("U-DOCEXPORT-002: source anchors and trace IDs are preserved", () => {
    const projection = parseCanonicalDocumentStructure({
      family: "requirements",
      sourcePath: "docs/governance/requirements.md",
      content: requirementsDoc,
    });

    expect(projection.sections.map((section) => section.anchor)).toContain("fr-l1-01-feature");
    expect(projection.traceIds).toEqual(["AC-L1-01", "AT-L1-01", "FR-L1-01", "PLAN-L7-35"]);
    expect(projection.evidenceLinks).toEqual([
      "docs/plans/PLAN-L7-35-canonical-document-export.md",
    ]);
  });

  it("U-DOCEXPORT-003: malformed or unsupported docs return findings without fabricated rows", () => {
    const projection = parseCanonicalDocumentStructure({
      family: "unknown",
      sourcePath: "",
      content: "no heading",
    });

    expect(projection.ok).toBe(false);
    expect(projection.sections).toEqual([]);
    expect(projection.findings.map((finding) => finding.code)).toEqual([
      "unsupported-family",
      "missing-source-path",
    ]);
  });

  it("U-DOCEXPORT-004: dataset rows are deterministic", () => {
    const projection = parseCanonicalDocumentStructure({
      family: "requirements",
      sourcePath: "docs/governance/requirements.md",
      content: requirementsDoc,
    });

    const a = buildDocumentExportDataset({ projections: [projection], format: "csv" });
    const b = buildDocumentExportDataset({ projections: [projection], format: "csv" });

    expect(a.rows).toEqual(b.rows);
    expect(a.rows[0]).toMatchObject({
      family: "requirements",
      source_path: "docs/governance/requirements.md",
    });
  });

  it("U-DOCEXPORT-005: secret-like and raw payload fields are redacted before render", () => {
    const dataset = buildDocumentExportDataset({
      projections: [
        parseCanonicalDocumentStructure({
          family: "plan",
          sourcePath: "docs/plans/PLAN-X.md",
          content: "# PLAN-X\n\nsecret sk-live-token\nrawMcpResponse: payload",
        }),
      ],
      format: "markdown",
    });

    expect(JSON.stringify(dataset)).not.toContain("sk-live-token");
    expect(JSON.stringify(dataset)).not.toContain("rawMcpResponse");
    expect(dataset.findings.map((finding) => finding.code)).toContain("redacted-sensitive-field");
  });

  it("U-DOCEXPORT-005b: innocent hyphenated words (task-/risk-/desk-) are NOT over-redacted (PLAN-L7-143)", () => {
    const dataset = buildDocumentExportDataset({
      projections: [
        parseCanonicalDocumentStructure({
          family: "plan",
          sourcePath: "docs/plans/PLAN-Y.md",
          // `sk-` appears only as a substring of task-/risk-/desk-; the `\b`-anchored
          // pattern must leave these intact and emit NO redacted-sensitive-field finding.
          content: "# PLAN-Y\n\ntask-classify and risk-policy via desk-review of task-complexity",
        }),
      ],
      format: "markdown",
    });

    const serialized = JSON.stringify(dataset);
    expect(serialized).toContain("task-classify");
    expect(serialized).toContain("risk-policy");
    expect(serialized).toContain("desk-review");
    expect(serialized).not.toContain("<redacted>");
    expect(dataset.findings.map((finding) => finding.code)).not.toContain(
      "redacted-sensitive-field",
    );
  });

  it("U-DOCEXPORT-006: large documents split by section instead of truncating", () => {
    const content = ["# Big", ...Array.from({ length: 6 }, (_, i) => `## S${i}\nbody`)].join("\n");
    const dataset = buildDocumentExportDataset({
      projections: [
        parseCanonicalDocumentStructure({
          family: "design",
          sourcePath: "docs/design/big.md",
          content,
        }),
      ],
      format: "markdown",
      maxRowsPerChunk: 2,
    });

    expect(dataset.chunks.length).toBeGreaterThan(1);
    expect(dataset.findings.map((finding) => finding.code)).toContain("large-document-split");
  });

  it("U-DOCEXPORT-007: CSV and Markdown render without external readiness", () => {
    const dataset = buildDocumentExportDataset({
      projections: [
        parseCanonicalDocumentStructure({
          family: "requirements",
          sourcePath: "docs/requirements.md",
          content: requirementsDoc,
        }),
      ],
      format: "csv",
    });

    expect(renderDocumentExport({ dataset, format: "csv" }).ok).toBe(true);
    expect(renderDocumentExport({ dataset, format: "markdown" }).content).toContain("| family |");
  });

  it("U-DOCEXPORT-008: XLSX request without readiness returns renderer-unavailable", () => {
    const result = renderDocumentExport({
      dataset: buildDocumentExportDataset({ projections: [], format: "xlsx" }),
      format: "xlsx",
      rendererReady: false,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "renderer-unavailable", severity: "warn" }),
    ]);
  });

  it("U-DOCEXPORT-009: PPTX request without readiness returns renderer-unavailable", () => {
    const result = renderDocumentExport({
      dataset: buildDocumentExportDataset({ projections: [], format: "pptx" }),
      format: "pptx",
      rendererReady: false,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "renderer-unavailable", severity: "warn" }),
    ]);
  });

  it("U-DOCEXPORT-013: XLSX with rendererReady=true still refuses to emit mislabeled markdown", () => {
    const dataset = buildDocumentExportDataset({
      projections: [
        parseCanonicalDocumentStructure({
          family: "design",
          sourcePath: "docs/design/x.md",
          content: "# H\nbody",
        }),
      ],
      format: "xlsx",
    });
    const result = renderDocumentExport({ dataset, format: "xlsx", rendererReady: true });

    // pure core has no Office renderer: never fall through to markdown mislabeled as xlsx.
    expect(result.ok).toBe(false);
    expect(result.content).toBe("");
    expect(result.findings.map((f) => f.code)).toEqual(["renderer-unavailable"]);
  });

  it("U-DOCEXPORT-014: maxRowsPerChunk=0 does not hang (lower bound 1 enforced)", () => {
    const content = ["# Big", ...Array.from({ length: 4 }, (_, i) => `## S${i}\nbody`)].join("\n");
    const dataset = buildDocumentExportDataset({
      projections: [
        parseCanonicalDocumentStructure({
          family: "design",
          sourcePath: "docs/design/big.md",
          content,
        }),
      ],
      format: "csv",
      maxRowsPerChunk: 0,
    });

    expect(dataset.rows.length).toBeGreaterThan(0);
    expect(dataset.chunks.length).toBe(dataset.rows.length);
    expect(dataset.chunks.every((chunk) => chunk.length === 1)).toBe(true);
  });

  it("U-DOCEXPORT-015: CSV render neutralizes formula-injection prefixes", () => {
    const dataset = buildDocumentExportDataset({
      projections: [
        parseCanonicalDocumentStructure({
          family: "design",
          sourcePath: "docs/design/inj.md",
          content: "# =cmd|' /c calc\nbody",
        }),
      ],
      format: "csv",
    });
    const csv = renderDocumentExport({ dataset, format: "csv" }).content;

    // heading cell starts with '=' → must be prefixed with ' so Excel does not evaluate it.
    expect(csv).toContain(`"'=cmd`);
    expect(csv).not.toMatch(/,"=cmd/);
  });

  it("U-DOCEXPORT-010: artifact recording creates normalized projection rows", () => {
    const rows = recordDocumentExportArtifact({
      runId: "run-1",
      datasetId: "dataset-1",
      artifactPath: ".ut-tdd/exports/docs.csv",
      format: "csv",
      sourceSnapshotHash: "sha256:abc",
      evidencePath: ".ut-tdd/evidence/document-export/run-1.json",
    });

    expect(rows.document_export_runs).toEqual([
      expect.objectContaining({
        document_export_run_id: "run-1",
        source_snapshot_hash: "sha256:abc",
      }),
    ]);
    expect(rows.document_export_datasets).toEqual([
      expect.objectContaining({ document_export_dataset_id: "dataset-1" }),
    ]);
    expect(rows.document_export_artifacts).toEqual([
      expect.objectContaining({ artifact_path: ".ut-tdd/exports/docs.csv" }),
    ]);
  });

  it("U-DOCEXPORT-011: generated artifacts are derived and do not mutate canonical docs", () => {
    const rows = recordDocumentExportArtifact({
      runId: "run-1",
      datasetId: "dataset-1",
      artifactPath: ".ut-tdd/exports/docs.md",
      format: "markdown",
      sourceSnapshotHash: "sha256:abc",
      evidencePath: ".ut-tdd/evidence/document-export/run-1.json",
    });

    expect(rows.document_export_artifacts[0].derived).toBe(true);
    expect(rows.actionsTaken).toEqual([]);
  });

  it("U-DOCEXPORT-012: stale source snapshot marks existing artifact stale", () => {
    const rows = recordDocumentExportArtifact({
      runId: "run-2",
      datasetId: "dataset-2",
      artifactPath: ".ut-tdd/exports/docs.md",
      format: "markdown",
      sourceSnapshotHash: "sha256:new",
      previousSourceSnapshotHash: "sha256:old",
      evidencePath: ".ut-tdd/evidence/document-export/run-2.json",
    });

    expect(rows.document_export_artifacts[0].stale).toBe(true);
    expect(rows.findings).toEqual([
      expect.objectContaining({ code: "stale-source-snapshot", severity: "warn" }),
    ]);
  });
});
