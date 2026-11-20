import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRelationGraphSourceSet } from "../src/graph/loader.ts";
import {
  analyzeRelationImpact,
  collectRelationGraphProjection,
  exportRelationDiagram,
} from "../src/lint/relation-graph.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// Exercise source/test and design/test-design relationships through the repository loader.
function buildRepo(root: string): void {
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "docs", "design", "harness"), { recursive: true });
  mkdirSync(join(root, "docs", "governance"), { recursive: true });
  mkdirSync(join(root, "docs", "process", "modes"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "docs", "test-design", "harness"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(join(root, ".ut-tdd", "evidence", "g8-integration"), { recursive: true });
  mkdirSync(join(root, ".ut-tdd", "evidence", "g9-system"), { recursive: true });
  mkdirSync(join(root, ".ut-tdd", "evidence", "g10-ux"), { recursive: true });
  mkdirSync(join(root, ".ut-tdd", "audit"), { recursive: true });
  mkdirSync(join(root, ".ut-tdd", "review"), { recursive: true });
  mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
  mkdirSync(join(root, "src", "widget"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });

  writeFileSync(
    join(root, "docs", "adr", "ADR-001-test-decision.md"),
    ["# ADR-001 Test Decision", "", "Fixture ADR body.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "governance", "README.md"),
    ["# Governance", "", "Fixture governance README body.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "governance", "gate-design.md"),
    ["# Gate Design", "", "Fixture governance gate body.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "governance", "ai-dev-team-concept_v1.1.md"),
    ["# AI Dev Team Concept", "", "Fixture governance concept body.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(join(root, "src", "widget", "core.ts"), "export const core = 1;\n", "utf8");
  writeFileSync(
    join(root, "tests", "core.test.ts"),
    'import { core } from "../src/widget/core";\nexport const t = core;\n',
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "design", "harness", "widget-design.md"),
    [
      "---",
      "layer: L6",
      "status: confirmed",
      "pair_artifact: docs/test-design/harness/widget-test-design.md",
      "---",
      "",
      "design body",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "test-design", "harness", "widget-test-design.md"),
    ["---", "layer: L6", "status: confirmed", "---", "", "test design body", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "process", "modes", "refactor.md"),
    [
      "---",
      "canonical: true",
      "process_doc: mode",
      "mode: Refactor",
      "kind: refactor",
      "layer: L7",
      "status: confirmed",
      "---",
      "",
      "process mode body",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "skills", "SKILL_MAP.md"),
    ["# Skill Map", "", "Fixture skill catalog body.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".claude", "agents", "refactor-scout.md"),
    ["---", "name: refactor-scout", "model: haiku", "---", "", "agent prompt body", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".ut-tdd", "review", "cross-review-l7-157.md"),
    ["# Cross review", "", "Read-only review task body.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".ut-tdd", "audit", "A-143-l14-close-system-foundation-audit.md"),
    ["# A-143", "", "L14 close audit body.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".ut-tdd", "memory", "feedback-fixture.md"),
    ["# Fixture memory", "", "Durable project knowledge.", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".ut-tdd", "evidence", "g8-integration", "test-manifest.json"),
    JSON.stringify(
      {
        schema_version: "g8-integration-evidence-v1",
        gate: "G8",
        profile: "fixture",
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, ".ut-tdd", "evidence", "g9-system", "test-manifest.json"),
    JSON.stringify(
      {
        schema_version: "g9-system-evidence-v1",
        gate: "G9",
        profile: "fixture",
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, ".ut-tdd", "evidence", "g10-ux", "test-manifest.json"),
    JSON.stringify(
      {
        schema_version: "g10-ux-evidence-v1",
        gate: "G10",
        profile: "fixture",
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, ".editorconfig"),
    ["root = true", "", "[*]", "charset = utf-8", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2),
    "utf8",
  );
  writeFileSync(join(root, "README.md"), "# Fixture README\n", "utf8");
}

describe("loadRelationGraphSourceSet", () => {
  it.each([
    "confirmed",
    "completed",
    "accepted",
  ])("U-PAEXRET-002: excludes legacy PLAN targets and keeps stale-edge detection ($0)", (status) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-graph-loader-plan-target-retirement-"));
    try {
      buildRepo(root);
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      const generatedPath = "src/widget/declared-but-absent.ts";
      writeFileSync(
        join(root, "docs", "plans", "PLAN-TEST-01-widget.md"),
        [
          "---",
          "plan_id: PLAN-TEST-01-widget",
          `status: ${status}`,
          "kind: impl",
          "generates:",
          `  - artifact_path: ${generatedPath}`,
          "    artifact_type: source_module",
          "dependencies:",
          "  requires:",
          "    - FR-L1-99",
          "---",
          "",
        ].join("\n"),
        "utf8",
      );
      const missingTestDesign = "docs/test-design/harness/missing-widget-test-design.md";
      writeFileSync(
        join(root, "docs", "design", "harness", "widget-design.md"),
        [
          "---",
          "layer: L6",
          "status: confirmed",
          `pair_artifact: ${missingTestDesign}`,
          "---",
          "",
          "design body",
          "",
        ].join("\n"),
        "utf8",
      );

      const sourceSet = loadRelationGraphSourceSet(root);
      expect(sourceSet.plans ?? []).toEqual([]);
      expect(sourceSet.requirements).toEqual([]);

      const projection = collectRelationGraphProjection(sourceSet);
      expect(projection.nodes.some((node) => node.kind === "plan")).toBe(false);
      expect(projection.nodes.map((node) => node.id)).not.toContain(
        "source:src/widget/declared-but-absent.ts",
      );
      expect(
        projection.edges.some((edge) => edge.kind === "generates" || edge.kind === "derives-from"),
      ).toBe(false);
      const result = analyzeRelationImpact({ changedPaths: [], projection });
      const staleEdges = result.findings.filter((finding) => finding.code === "stale-edge");
      expect(staleEdges).toContainEqual(
        expect.objectContaining({
          nodeId: "design:docs/design/harness/widget-design.md",
          message: expect.stringContaining(
            `design:docs/design/harness/widget-design.md -[pairs]-> test-design:${missingTestDesign}`,
          ),
        }),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("builds source-to-test and design-to-test-design relationships", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-graph-loader-"));
    try {
      // U-GRAPH-001
      buildRepo(root);
      const sourceSet = loadRelationGraphSourceSet(root);

      // source→test covered-by (import 解析)
      const src = sourceSet.sourceFiles?.find((s) => s.path === "src/widget/core.ts");
      expect(src?.tests).toContain("tests/core.test.ts");

      // design→test-design pairs
      const design = sourceSet.designDocs?.find((d) => d.path.endsWith("widget-design.md"));
      expect(design?.pairs).toBe("docs/test-design/harness/widget-test-design.md");

      const processMode = sourceSet.designDocs?.find(
        (d) => d.path === "docs/process/modes/refactor.md",
      );
      expect(processMode).toMatchObject({
        id: "docs/process/modes/refactor.md",
        path: "docs/process/modes/refactor.md",
      });
      const agentDoc = sourceSet.designDocs?.find(
        (d) => d.path === ".claude/agents/refactor-scout.md",
      );
      expect(agentDoc).toMatchObject({
        id: ".claude/agents/refactor-scout.md",
        path: ".claude/agents/refactor-scout.md",
      });
      const skillMapDoc = sourceSet.designDocs?.find((d) => d.path === "skills/SKILL_MAP.md");
      expect(skillMapDoc).toMatchObject({
        id: "skills/SKILL_MAP.md",
        path: "skills/SKILL_MAP.md",
      });
      const adrDoc = sourceSet.designDocs?.find(
        (d) => d.path === "docs/adr/ADR-001-test-decision.md",
      );
      expect(adrDoc).toMatchObject({
        id: "docs/adr/ADR-001-test-decision.md",
        path: "docs/adr/ADR-001-test-decision.md",
      });
      const reviewDoc = sourceSet.designDocs?.find(
        (d) => d.path === ".ut-tdd/review/cross-review-l7-157.md",
      );
      expect(reviewDoc).toMatchObject({
        id: ".ut-tdd/review/cross-review-l7-157.md",
        path: ".ut-tdd/review/cross-review-l7-157.md",
      });
      const auditDoc = sourceSet.designDocs?.find(
        (d) => d.path === ".ut-tdd/audit/A-143-l14-close-system-foundation-audit.md",
      );
      expect(auditDoc).toMatchObject({
        id: ".ut-tdd/audit/A-143-l14-close-system-foundation-audit.md",
        path: ".ut-tdd/audit/A-143-l14-close-system-foundation-audit.md",
      });
      const memoryDoc = sourceSet.designDocs?.find(
        (d) => d.path === ".ut-tdd/memory/feedback-fixture.md",
      );
      expect(memoryDoc).toMatchObject({
        id: ".ut-tdd/memory/feedback-fixture.md",
        path: ".ut-tdd/memory/feedback-fixture.md",
      });
      const g8EvidenceDoc = sourceSet.designDocs?.find(
        (d) => d.path === ".ut-tdd/evidence/g8-integration/test-manifest.json",
      );
      expect(g8EvidenceDoc).toMatchObject({
        id: ".ut-tdd/evidence/g8-integration/test-manifest.json",
        path: ".ut-tdd/evidence/g8-integration/test-manifest.json",
      });
      const g9EvidenceDoc = sourceSet.designDocs?.find(
        (d) => d.path === ".ut-tdd/evidence/g9-system/test-manifest.json",
      );
      expect(g9EvidenceDoc).toMatchObject({
        id: ".ut-tdd/evidence/g9-system/test-manifest.json",
        path: ".ut-tdd/evidence/g9-system/test-manifest.json",
      });
      const g10EvidenceDoc = sourceSet.designDocs?.find(
        (d) => d.path === ".ut-tdd/evidence/g10-ux/test-manifest.json",
      );
      expect(g10EvidenceDoc).toMatchObject({
        id: ".ut-tdd/evidence/g10-ux/test-manifest.json",
        path: ".ut-tdd/evidence/g10-ux/test-manifest.json",
      });
      const referenceDoc = sourceSet.designDocs?.find(
        (d) => d.path === "docs/reference/ai-agent-harness-directory-reference.md",
      );
      expect(referenceDoc).toMatchObject({
        id: "docs/reference/ai-agent-harness-directory-reference.md",
        path: "docs/reference/ai-agent-harness-directory-reference.md",
      });
      const governanceDoc = sourceSet.designDocs?.find(
        (d) => d.path === "docs/governance/repository-structure.md",
      );
      expect(governanceDoc).toMatchObject({
        id: "docs/governance/repository-structure.md",
        path: "docs/governance/repository-structure.md",
      });
      const governanceReadmeDoc = sourceSet.designDocs?.find(
        (d) => d.path === "docs/governance/README.md",
      );
      expect(governanceReadmeDoc).toMatchObject({
        id: "docs/governance/README.md",
        path: "docs/governance/README.md",
      });
      const governanceGateDoc = sourceSet.designDocs?.find(
        (d) => d.path === "docs/governance/gate-design.md",
      );
      expect(governanceGateDoc).toMatchObject({
        id: "docs/governance/gate-design.md",
        path: "docs/governance/gate-design.md",
      });
      const governanceConceptDoc = sourceSet.designDocs?.find(
        (d) => d.path === "docs/governance/ai-dev-team-concept_v1.1.md",
      );
      expect(governanceConceptDoc).toMatchObject({
        id: "docs/governance/ai-dev-team-concept_v1.1.md",
        path: "docs/governance/ai-dev-team-concept_v1.1.md",
      });
      const readmeDoc = sourceSet.designDocs?.find((d) => d.path === "README.md");
      expect(readmeDoc).toMatchObject({
        id: "README.md",
        path: "README.md",
      });

      // Source changes propagate to the covering test.
      const projection = collectRelationGraphProjection(sourceSet);
      const impact = analyzeRelationImpact({
        changedPaths: ["src/widget/core.ts"],
        projection,
      });
      expect(impact.changedNodes.map((n) => n.id)).toContain("source:src/widget/core.ts");
      expect(impact.impacted.map((n) => n.id)).toContain("test:tests/core.test.ts");

      const processImpact = analyzeRelationImpact({
        changedPaths: ["docs/process/modes/refactor.md"],
        projection,
      });
      expect(processImpact.ok).toBe(true);
      expect(processImpact.changedNodes.map((n) => n.id)).toContain(
        "design:docs/process/modes/refactor.md",
      );
      expect(processImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const agentImpact = analyzeRelationImpact({
        changedPaths: [".claude/agents/refactor-scout.md"],
        projection,
      });
      expect(agentImpact.ok).toBe(true);
      expect(agentImpact.changedNodes.map((n) => n.id)).toContain(
        "design:.claude/agents/refactor-scout.md",
      );
      expect(agentImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const adrImpact = analyzeRelationImpact({
        changedPaths: ["docs/adr/ADR-001-test-decision.md"],
        projection,
      });
      expect(adrImpact.ok).toBe(true);
      expect(adrImpact.changedNodes.map((n) => n.id)).toContain(
        "design:docs/adr/ADR-001-test-decision.md",
      );
      expect(adrImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const reviewImpact = analyzeRelationImpact({
        changedPaths: [".ut-tdd/review/cross-review-l7-157.md"],
        projection,
      });
      expect(reviewImpact.ok).toBe(true);
      expect(reviewImpact.changedNodes.map((n) => n.id)).toContain(
        "design:.ut-tdd/review/cross-review-l7-157.md",
      );
      expect(reviewImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const auditImpact = analyzeRelationImpact({
        changedPaths: [".ut-tdd/audit/A-143-l14-close-system-foundation-audit.md"],
        projection,
      });
      expect(auditImpact.ok).toBe(true);
      expect(auditImpact.changedNodes.map((n) => n.id)).toContain(
        "design:.ut-tdd/audit/A-143-l14-close-system-foundation-audit.md",
      );
      expect(auditImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const memoryImpact = analyzeRelationImpact({
        changedPaths: [".ut-tdd/memory/feedback-fixture.md"],
        projection,
      });
      expect(memoryImpact.ok).toBe(true);
      expect(memoryImpact.changedNodes.map((n) => n.id)).toContain(
        "design:.ut-tdd/memory/feedback-fixture.md",
      );
      expect(memoryImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const g8EvidenceImpact = analyzeRelationImpact({
        changedPaths: [".ut-tdd/evidence/g8-integration/test-manifest.json"],
        projection,
      });
      expect(g8EvidenceImpact.ok).toBe(true);
      expect(g8EvidenceImpact.changedNodes.map((n) => n.id)).toContain(
        "design:.ut-tdd/evidence/g8-integration/test-manifest.json",
      );
      expect(g8EvidenceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const g9EvidenceImpact = analyzeRelationImpact({
        changedPaths: [".ut-tdd/evidence/g9-system/test-manifest.json"],
        projection,
      });
      expect(g9EvidenceImpact.ok).toBe(true);
      expect(g9EvidenceImpact.changedNodes.map((n) => n.id)).toContain(
        "design:.ut-tdd/evidence/g9-system/test-manifest.json",
      );
      expect(g9EvidenceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const g10EvidenceDirImpact = analyzeRelationImpact({
        changedPaths: [".ut-tdd/evidence/g10-ux"],
        projection,
      });
      expect(g10EvidenceDirImpact.ok).toBe(true);
      expect(g10EvidenceDirImpact.changedNodes.map((n) => n.id)).toContain(
        "design:.ut-tdd/evidence/g10-ux/test-manifest.json",
      );
      expect(g10EvidenceDirImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const referenceImpact = analyzeRelationImpact({
        changedPaths: ["docs/reference/ai-agent-harness-directory-reference.md"],
        projection,
      });
      expect(referenceImpact.ok).toBe(true);
      expect(referenceImpact.changedNodes.map((n) => n.id)).toContain(
        "design:docs/reference/ai-agent-harness-directory-reference.md",
      );
      expect(referenceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const governanceImpact = analyzeRelationImpact({
        changedPaths: ["docs/governance/repository-structure.md"],
        projection,
      });
      expect(governanceImpact.ok).toBe(true);
      expect(governanceImpact.changedNodes.map((n) => n.id)).toContain(
        "design:docs/governance/repository-structure.md",
      );
      expect(governanceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
      const governanceReadmeImpact = analyzeRelationImpact({
        changedPaths: ["docs/governance/README.md"],
        projection,
      });
      expect(governanceReadmeImpact.ok).toBe(true);
      expect(governanceReadmeImpact.changedNodes.map((n) => n.id)).toContain(
        "design:docs/governance/README.md",
      );
      expect(governanceReadmeImpact.findings.map((f) => f.code)).not.toContain(
        "missing-projection",
      );
      const governanceGateImpact = analyzeRelationImpact({
        changedPaths: ["docs/governance/gate-design.md"],
        projection,
      });
      expect(governanceGateImpact.ok).toBe(true);
      expect(governanceGateImpact.changedNodes.map((n) => n.id)).toContain(
        "design:docs/governance/gate-design.md",
      );
      expect(governanceGateImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const readmeImpact = analyzeRelationImpact({
        changedPaths: ["README.md"],
        projection,
      });
      expect(readmeImpact.ok).toBe(true);
      expect(readmeImpact.changedNodes.map((n) => n.id)).toContain("design:README.md");
      expect(readmeImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const editorconfigImpact = analyzeRelationImpact({
        changedPaths: [".editorconfig"],
        projection,
      });
      expect(editorconfigImpact.ok).toBe(true);
      expect(editorconfigImpact.changedNodes.map((n) => n.id)).toContain("design:.editorconfig");
      expect(editorconfigImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      const codexHooksImpact = analyzeRelationImpact({
        changedPaths: [".codex/hooks.json"],
        projection,
      });
      expect(codexHooksImpact.ok).toBe(true);
      expect(codexHooksImpact.changedNodes.map((n) => n.id)).toContain("design:.codex/hooks.json");
      expect(codexHooksImpact.findings.map((f) => f.code)).not.toContain("missing-projection");

      // export: mermaid is always emittable and contains the changed source node
      const diagram = exportRelationDiagram({ snapshot: projection, format: "mermaid" });
      expect(diagram.ok).toBe(true);
      expect(diagram.content).toContain("flowchart TD");
    } finally {
      removeTestTree(root);
    }
  });

  it("is fail-open on an empty repo root (no throw, empty source set)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-graph-loader-empty-"));
    try {
      const sourceSet = loadRelationGraphSourceSet(root);
      expect(sourceSet.sourceFiles ?? []).toEqual([]);
      expect(sourceSet.requirements ?? []).toEqual([]);
      expect(sourceSet.plans ?? []).toEqual([]);
    } finally {
      removeTestTree(root);
    }
  });

  it("materializes a requirement node from the FR registry", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-graph-loader-req-"));
    try {
      buildRepo(root);
      const l1 = join(root, "docs", "design", "harness", "L1-requirements");
      const l3 = join(root, "docs", "design", "harness", "L3-functional");
      mkdirSync(l1, { recursive: true });
      mkdirSync(l3, { recursive: true });
      writeFileSync(
        join(l1, "functional-requirements.md"),
        ["## §1 機能一覧", "| **FR-L1-99** | Widget |", "### §1.1"].join("\n"),
        "utf8",
      );
      writeFileSync(join(l1, "screen-requirements.md"), "", "utf8");
      writeFileSync(join(l3, "functional-requirements.md"), "", "utf8");

      const sourceSet = loadRelationGraphSourceSet(root);
      expect(sourceSet.requirements).toEqual([
        { id: "FR-L1-99", path: "docs/design/harness/L1-requirements/functional-requirements.md" },
      ]);
      const projection = collectRelationGraphProjection(sourceSet);
      const result = analyzeRelationImpact({ changedPaths: [], projection });
      const staleEdges = result.findings.filter((f) => f.code === "stale-edge");
      expect(staleEdges.map((f) => f.message)).toEqual([]);
    } finally {
      removeTestTree(root);
    }
  });
});

// 実 repo の regression fence: 実 loadRelationGraphSourceSet(process.cwd()) の edge の端点が全て実在し
// stale-edge == 0 であること、PLAN に依らない node / edge が空でないことを保証する (#1430)。
describe("relation graph real-repo loader (PLAN-L7-142 stale-edge fence)", () => {
  it("CANDIDATE-U-PLANRET-024: has zero stale-edge findings through the real loader and materializes requirement nodes", () => {
    const projection = collectRelationGraphProjection(loadRelationGraphSourceSet(process.cwd()));
    const result = analyzeRelationImpact({ changedPaths: [], projection });
    const staleEdges = result.findings.filter((f) => f.code === "stale-edge");
    // failure surfaces the dangling "from -[kind]-> to" edges directly.
    expect(staleEdges.map((f) => f.message)).toEqual([]);
    const requirementNodes = projection.nodes.filter((n) => n.kind === "requirement");
    expect(requirementNodes.length).toBeGreaterThan(0);
    for (const kind of ["pairs", "covered-by"]) {
      expect(projection.edges.filter((e) => e.kind === kind).length).toBeGreaterThan(0);
    }
    const agentImpact = analyzeRelationImpact({
      changedPaths: [".claude/commands/build.md"],
      projection,
    });
    expect(agentImpact.ok).toBe(true);
    expect(agentImpact.changedNodes.map((n) => n.id)).toContain("design:.claude/commands/build.md");
    expect(agentImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    for (const path of [".claude/commands/ut-tdd-status.md", ".claude/commands/ut-tdd-test.md"]) {
      const impact = analyzeRelationImpact({ changedPaths: [path], projection });
      expect(impact.ok).toBe(true);
      expect(impact.changedNodes.map((n) => n.id)).toContain(`design:${path}`);
      expect(impact.findings.map((f) => f.code)).not.toContain("missing-projection");
    }
    const skillMapImpact = analyzeRelationImpact({
      changedPaths: ["skills/SKILL_MAP.md"],
      projection,
    });
    expect(skillMapImpact.ok).toBe(true);
    expect(skillMapImpact.changedNodes.map((n) => n.id)).toContain("design:skills/SKILL_MAP.md");
    expect(skillMapImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const adapterAgentImpact = analyzeRelationImpact({
      changedPaths: ["docs/templates/adapter/.claude/commands/build.md"],
      projection,
    });
    expect(adapterAgentImpact.ok).toBe(true);
    expect(adapterAgentImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/templates/adapter/.claude/commands/build.md",
    );
    expect(adapterAgentImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const adapterCommandImpact = analyzeRelationImpact({
      changedPaths: ["docs/templates/adapter/.claude/commands/ut-tdd-status.md"],
      projection,
    });
    expect(adapterCommandImpact.ok).toBe(true);
    expect(adapterCommandImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/templates/adapter/.claude/commands/ut-tdd-status.md",
    );
    expect(adapterCommandImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const adapterCodexHookImpact = analyzeRelationImpact({
      changedPaths: ["docs/templates/adapter/.codex/hooks.json"],
      projection,
    });
    expect(adapterCodexHookImpact.ok).toBe(true);
    expect(adapterCodexHookImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/templates/adapter/.codex/hooks.json",
    );
    expect(adapterCodexHookImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const adr001Impact = analyzeRelationImpact({
      changedPaths: ["docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md"],
      projection,
    });
    expect(adr001Impact.ok).toBe(true);
    expect(adr001Impact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md",
    );
    expect(adr001Impact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const adr005Impact = analyzeRelationImpact({
      changedPaths: ["docs/adr/ADR-005-distribution-model-and-central-ui.md"],
      projection,
    });
    expect(adr005Impact.ok).toBe(true);
    expect(adr005Impact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/adr/ADR-005-distribution-model-and-central-ui.md",
    );
    expect(adr005Impact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const governanceReadmeImpact = analyzeRelationImpact({
      changedPaths: ["docs/governance/README.md"],
      projection,
    });
    expect(governanceReadmeImpact.ok).toBe(true);
    expect(governanceReadmeImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/governance/README.md",
    );
    expect(governanceReadmeImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const documentSystemMapImpact = analyzeRelationImpact({
      changedPaths: ["docs/governance/document-system-map.md"],
      projection,
    });
    expect(documentSystemMapImpact.ok).toBe(true);
    expect(documentSystemMapImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/governance/document-system-map.md",
    );
    expect(documentSystemMapImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const reviewImpact = analyzeRelationImpact({
      changedPaths: [".ut-tdd/review/cross-review-l7-157.md"],
      projection,
    });
    expect(reviewImpact.ok).toBe(true);
    expect(reviewImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.ut-tdd/review/cross-review-l7-157.md",
    );
    expect(reviewImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const auditImpact = analyzeRelationImpact({
      changedPaths: [".ut-tdd/audit/A-143-l14-close-system-foundation-audit.md"],
      projection,
    });
    expect(auditImpact.ok).toBe(true);
    expect(auditImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.ut-tdd/audit/A-143-l14-close-system-foundation-audit.md",
    );
    expect(auditImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const memoryImpact = analyzeRelationImpact({
      changedPaths: [".ut-tdd/memory/feedback-plan--81abf9753343.md"],
      projection,
    });
    expect(memoryImpact.ok).toBe(true);
    expect(memoryImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.ut-tdd/memory/feedback-plan--81abf9753343.md",
    );
    expect(memoryImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const g8EvidenceImpact = analyzeRelationImpact({
      changedPaths: [".ut-tdd/evidence/g8-integration/20260626-it-module-state-minimum.json"],
      projection,
    });
    expect(g8EvidenceImpact.ok).toBe(true);
    expect(g8EvidenceImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.ut-tdd/evidence/g8-integration/20260626-it-module-state-minimum.json",
    );
    expect(g8EvidenceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const g9EvidenceImpact = analyzeRelationImpact({
      changedPaths: [".ut-tdd/evidence/g9-system/20261117-s7-fresh-system.json"],
      projection,
    });
    expect(g9EvidenceImpact.ok).toBe(true);
    expect(g9EvidenceImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.ut-tdd/evidence/g9-system/20261117-s7-fresh-system.json",
    );
    expect(g9EvidenceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const g10EvidenceDirImpact = analyzeRelationImpact({
      changedPaths: [".ut-tdd/evidence/g10-ux"],
      projection,
    });
    expect(g10EvidenceDirImpact.ok).toBe(true);
    expect(g10EvidenceDirImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.ut-tdd/evidence/g10-ux/20260629-ux-minimum.json",
    );
    expect(g10EvidenceDirImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const referenceImpact = analyzeRelationImpact({
      changedPaths: ["docs/reference/ai-agent-harness-directory-reference.md"],
      projection,
    });
    expect(referenceImpact.ok).toBe(true);
    expect(referenceImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/reference/ai-agent-harness-directory-reference.md",
    );
    expect(referenceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const governanceImpact = analyzeRelationImpact({
      changedPaths: ["docs/governance/repository-structure.md"],
      projection,
    });
    expect(governanceImpact.ok).toBe(true);
    expect(governanceImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/governance/repository-structure.md",
    );
    expect(governanceImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    for (const path of [
      "docs/governance/ai-dev-team-concept_v1.1.md",
      "docs/governance/ai-dev-team-operations_v1.1.md",
      "docs/governance/audit-framework.md",
      "docs/governance/coding-rules.md",
      "docs/governance/conditional-backfill-decision-audit-2026-06-22.md",
      "docs/governance/ddd-tdd-rules.md",
      "docs/governance/forward-convergence-legacy-debt-audit.md",
      "docs/governance/gate-design.md",
      "docs/governance/reverse-fullback-backprop-audit-2026-06-22.md",
      "docs/governance/runtime-parity-l0-l3-design-audit-2026-06-02.md",
      "docs/governance/ut-tdd-agent-harness-concept_v3.1.md",
      "docs/governance/ut-tdd-agent-harness-extraction-plan_v0.1.md",
      "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
    ]) {
      const impact = analyzeRelationImpact({ changedPaths: [path], projection });
      expect(impact.ok).toBe(true);
      expect(impact.changedNodes.map((n) => n.id)).toContain(`design:${path}`);
      expect(impact.findings.map((f) => f.code)).not.toContain("missing-projection");
    }
    const readmeImpact = analyzeRelationImpact({
      changedPaths: ["README.md"],
      projection,
    });
    expect(readmeImpact.ok).toBe(true);
    expect(readmeImpact.changedNodes.map((n) => n.id)).toContain("design:README.md");
    expect(readmeImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    for (const path of ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]) {
      const impact = analyzeRelationImpact({ changedPaths: [path], projection });
      expect(impact.ok).toBe(true);
      expect(impact.changedNodes.map((n) => n.id)).toContain(`design:${path}`);
      expect(impact.findings.map((f) => f.code)).not.toContain("missing-projection");
    }
    const editorconfigImpact = analyzeRelationImpact({
      changedPaths: [".editorconfig"],
      projection,
    });
    expect(editorconfigImpact.ok).toBe(true);
    expect(editorconfigImpact.changedNodes.map((n) => n.id)).toContain("design:.editorconfig");
    expect(editorconfigImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    const codexHooksImpact = analyzeRelationImpact({
      changedPaths: [".codex/hooks.json"],
      projection,
    });
    expect(codexHooksImpact.ok).toBe(true);
    expect(codexHooksImpact.changedNodes.map((n) => n.id)).toContain("design:.codex/hooks.json");
    expect(codexHooksImpact.findings.map((f) => f.code)).not.toContain("missing-projection");
    // PLAN-L7-397: docs/ 直下 ledger (どのサブディレクトリ walk にも入らない) の coverage 回帰止め。
    for (const path of ["docs/feedback-log.md", "docs/improvement-backlog.md"]) {
      const impact = analyzeRelationImpact({ changedPaths: [path], projection });
      expect(impact.ok).toBe(true);
      expect(impact.changedNodes.map((n) => n.id)).toContain(`design:${path}`);
      expect(impact.findings.map((f) => f.code)).not.toContain("missing-projection");
    }
  });
});
