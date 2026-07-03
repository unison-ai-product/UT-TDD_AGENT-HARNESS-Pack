import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRelationGraphSourceSet } from "../src/graph/loader";
import {
  analyzeRelationImpact,
  collectRelationGraphProjection,
  exportRelationDiagram,
} from "../src/lint/relation-graph";

// PLAN-L7-32 §9 discharge: repo→RelationGraphSourceSet loader の結合テスト。
// tmp repo に PLAN(generates)+src+test(import)+design(pair_artifact)+test-design を置き、
// loader が plan→source(generates) / source→test(covered-by) / design→test-design(pairs)
// の edge を生む source set を返すこと、純関数と結合して impact/export が動くことを検証する。
function buildRepo(root: string): void {
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
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
  writeFileSync(
    join(root, "docs", "plans", "PLAN-TEST-01-widget.md"),
    [
      "---",
      "plan_id: PLAN-TEST-01-widget",
      "status: confirmed",
      "kind: impl",
      "generates:",
      "  - artifact_path: src/widget/core.ts",
      "    artifact_type: source_module",
      "dependencies:",
      "  requires:",
      "    - FR-L1-99",
      "---",
      "",
      "## body references FR-L1-99",
      "",
    ].join("\n"),
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
  it("builds a source set with plan→source, source→test, design→test-design edges", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-graph-loader-"));
    try {
      // U-GRAPH-001
      buildRepo(root);
      const sourceSet = loadRelationGraphSourceSet(root);

      // plan generates src + FR requirement ref
      const plan = sourceSet.plans?.find((p) => p.id === "PLAN-TEST-01-widget");
      expect(plan?.generates).toContain("src/widget/core.ts");
      expect(plan?.requirements).toContain("FR-L1-99");

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

      // projection + impact: changing the source surfaces its owning plan + sibling test
      const projection = collectRelationGraphProjection(sourceSet);
      const impact = analyzeRelationImpact({
        changedPaths: ["src/widget/core.ts"],
        projection,
      });
      expect(impact.changedNodes.map((n) => n.id)).toContain("source:src/widget/core.ts");
      expect(impact.impacted.map((n) => n.id)).toContain("plan:PLAN-TEST-01-widget");
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is fail-open on an empty repo root (no throw, empty source set)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-graph-loader-empty-"));
    try {
      const sourceSet = loadRelationGraphSourceSet(root);
      expect(sourceSet.sourceFiles ?? []).toEqual([]);
      expect(sourceSet.plans ?? []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes a requirement node for every FR a plan derives from (no dangling derives-from)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-graph-loader-req-"));
    try {
      buildRepo(root); // PLAN-TEST-01 derives-from FR-L1-99 (no FR registry doc in this tmp repo)
      const sourceSet = loadRelationGraphSourceSet(root);
      // requirement node must exist for the referenced FR even without a registry doc (union of refs)
      expect(sourceSet.requirements?.map((r) => r.id)).toContain("FR-L1-99");
      const projection = collectRelationGraphProjection(sourceSet);
      const result = analyzeRelationImpact({ changedPaths: [], projection });
      const staleEdges = result.findings.filter((f) => f.code === "stale-edge");
      expect(staleEdges.map((f) => f.message)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// PLAN-L7-142: real-repo regression fence for the relation-graph loader coverage gap.
// 合成 fixture ではなく実 loadRelationGraphSourceSet(process.cwd()) を通し、derives-from
// (plan→requirement) / pairs (design→test-design) / generates (plan→source) の端点 node が
// すべて実在し stale-edge == 0 であることを機械保証する (coverage≠substance、PLAN-L7-32 の
// loader が requirement node を一切 materialize しなかった回帰の再発防止)。
describe("relation graph real-repo loader (PLAN-L7-142 stale-edge fence)", () => {
  it("has zero stale-edge findings through the real loader and materializes requirement nodes", () => {
    const projection = collectRelationGraphProjection(loadRelationGraphSourceSet(process.cwd()));
    const result = analyzeRelationImpact({ changedPaths: [], projection });
    const staleEdges = result.findings.filter((f) => f.code === "stale-edge");
    // failure surfaces the dangling "from -[kind]-> to" edges directly.
    expect(staleEdges.map((f) => f.message)).toEqual([]);
    const requirementNodes = projection.nodes.filter((n) => n.kind === "requirement");
    expect(requirementNodes.length).toBeGreaterThan(0);
    const agentImpact = analyzeRelationImpact({
      changedPaths: [".claude/agents/refactor-scout.md"],
      projection,
    });
    expect(agentImpact.ok).toBe(true);
    expect(agentImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.claude/agents/refactor-scout.md",
    );
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
      changedPaths: ["docs/templates/adapter/.claude/agents/ut-tdd-tl.md"],
      projection,
    });
    expect(adapterAgentImpact.ok).toBe(true);
    expect(adapterAgentImpact.changedNodes.map((n) => n.id)).toContain(
      "design:docs/templates/adapter/.claude/agents/ut-tdd-tl.md",
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
      changedPaths: [".ut-tdd/evidence/g9-system/20260629-st-system-minimum.json"],
      projection,
    });
    expect(g9EvidenceImpact.ok).toBe(true);
    expect(g9EvidenceImpact.changedNodes.map((n) => n.id)).toContain(
      "design:.ut-tdd/evidence/g9-system/20260629-st-system-minimum.json",
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
  });
});
