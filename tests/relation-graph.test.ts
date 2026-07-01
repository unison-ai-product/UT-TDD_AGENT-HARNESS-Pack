// PLAN-L7-32 (add-impl) Step 1: cross-artifact relation graph の TDD Red oracle scaffold。
//
// L6-31 (module-drift.md addendum) の 4 契約 = collectRelationGraphProjection /
// analyzeRelationImpact / exportRelationDiagram / collectVerificationEvidenceProjection。
// U-RELGRAPH-001..010 を L7 unit oracle として敷く。
//
// 注: これは L7-32 ワークフローの「初手」= oracle 契約の scaffold。実装 (src/lint/relation-graph.ts)
// は Step 2 (pure projection functions) で Red→Green に着地させる。確定基準 (vitest 全 green) を
// 壊さないため未実装オラクルは it.todo で可視化する (起こすと Red、実装で it に昇格)。
// entry 条件 (PLAN-L7-32 §1): src/** relation-graph source を作る前に本 Red 契約が存在すること。
import { describe, expect, it } from "vitest";
import {
  analyzeRelationImpact,
  collectRelationGraphProjection,
  exportRelationDiagram,
  type RelationGraphSourceSet,
  type RelationImpactActionKind,
} from "../src/lint/relation-graph";
import { collectVerificationEvidenceProjection } from "../src/lint/relation-graph-evidence";
import type { RelationGraphProjection as SidecarRelationGraphProjection } from "../src/lint/relation-graph-types";

describe("collectRelationGraphProjection (U-RELGRAPH-001..003)", () => {
  it("U-RELGRAPH-001: requirements/PLAN/design/test-design/source/test fixtures が安定 node ID + typed edge を生成し (kind,id,path) 重複行ゼロ", () => {
    const input: RelationGraphSourceSet = {
      requirements: [{ id: "FR-L1-18", path: "docs/.../fr.md" }],
      plans: [
        {
          id: "PLAN-L7-32",
          path: "docs/plans/PLAN-L7-32.md",
          requirements: ["FR-L1-18"],
          generates: ["src/lint/relation-graph.ts"],
        },
        // 重複 PLAN — dedup されること
        { id: "PLAN-L7-32", path: "docs/plans/PLAN-L7-32.md" },
      ],
      designDocs: [
        { id: "module-drift", path: "docs/design/.../module-drift.md", pairs: "L7-unit" },
      ],
      testDesignDocs: [{ id: "L7-unit", path: "docs/test-design/.../L7-unit.md" }],
      sourceFiles: [
        { path: "src/lint/relation-graph.ts", tests: ["tests/relation-graph.test.ts"] },
      ],
      tests: [{ path: "tests/relation-graph.test.ts" }],
    };

    const projection: SidecarRelationGraphProjection = collectRelationGraphProjection(input);

    // 安定 node ID = `${kind}:${key}`
    const ids = projection.nodes.map((n) => n.id);
    expect(ids).toContain("requirement:FR-L1-18");
    expect(ids).toContain("plan:PLAN-L7-32");
    expect(ids).toContain("design:module-drift");
    expect(ids).toContain("test-design:L7-unit");
    expect(ids).toContain("source:src/lint/relation-graph.ts");
    expect(ids).toContain("test:tests/relation-graph.test.ts");

    // (kind,id,path) 重複行ゼロ
    const rowKeys = projection.nodes.map((n) => `${n.kind}|${n.id}|${n.path ?? ""}`);
    expect(new Set(rowKeys).size).toBe(rowKeys.length);

    // typed edge: derives-from / generates / pairs / covered-by
    const edgeKey = (from: string, to: string, kind: string) => `${from}->${to}:${kind}`;
    const edges = projection.edges.map((e) => edgeKey(e.from, e.to, e.kind));
    expect(edges).toContain(edgeKey("plan:PLAN-L7-32", "requirement:FR-L1-18", "derives-from"));
    expect(edges).toContain(
      edgeKey("plan:PLAN-L7-32", "source:src/lint/relation-graph.ts", "generates"),
    );
    expect(edges).toContain(edgeKey("design:module-drift", "test-design:L7-unit", "pairs"));
    expect(edges).toContain(
      edgeKey(
        "source:src/lint/relation-graph.ts",
        "test:tests/relation-graph.test.ts",
        "covered-by",
      ),
    );

    // 決定的順序 (node id 昇順)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("U-RELGRAPH-002: physical-data DB projection fixtures が table node + upstream requirement/ADR/PLAN edge を生成、orphan table 参照は finding", () => {
    const input: RelationGraphSourceSet = {
      dbTables: [
        { name: "plan", upstream: ["requirement:FR-L1-18", "adr:ADR-001", "plan:PLAN-L7-32"] },
        { name: "orphan_cache", upstream: [] },
      ],
    };

    const projection = collectRelationGraphProjection(input);

    const ids = projection.nodes.map((n) => n.id);
    expect(ids).toContain("db-table:plan");
    expect(ids).toContain("db-table:orphan_cache");

    const upstreamEdges = projection.edges.filter((e) => e.kind === "upstream");
    expect(upstreamEdges.map((e) => e.to)).toEqual(
      expect.arrayContaining(["requirement:FR-L1-18", "adr:ADR-001", "plan:PLAN-L7-32"]),
    );
    expect(upstreamEdges.every((e) => e.from === "db-table:plan")).toBe(true);

    const orphan = projection.findings.find((f) => f.code === "orphan-table");
    expect(orphan).toBeDefined();
    expect(orphan?.nodeId).toBe("db-table:orphan_cache");
  });

  it("U-RELGRAPH-003: projection sanitization — MCP evidence/browser trace/provider transcript/secret/screenshot blob を projection 行へコピーせず classification/count/evidence path/redacted summary のみ残す", () => {
    const SECRET = "sk-live-DEADBEEF-must-not-leak";
    const input: RelationGraphSourceSet = {
      verificationEvidence: [
        {
          id: "VP-001",
          evidencePath: ".ut-tdd/evidence/verification-profiles/vp-001.json",
          classification: "external-tool",
          summary: "playwright smoke passed",
          rawMcpResponse: `{"tool":"mcp","payload":"${SECRET}"}`,
          browserTrace: "trace blob ...",
          providerTranscript: "transcript ...",
          secret: SECRET,
          screenshotBlob: "iVBORw0KGgo... base64 blob",
        },
      ],
    };

    const projection = collectRelationGraphProjection(input);

    // node + projection row は classification/count/evidence path/redacted summary のみ
    const row = projection.verificationProfiles.find(
      (r) => r.nodeId === "verification-profile:VP-001",
    );
    expect(row).toBeDefined();
    expect(row?.classification).toBe("external-tool");
    expect(row?.evidencePath).toBe(".ut-tdd/evidence/verification-profiles/vp-001.json");
    expect(row?.redactedSummary).toBe("playwright smoke passed");
    expect(row?.redactedFieldCount).toBe(5);

    // 全 projection を JSON 化しても raw な機微 payload は一切含まれない
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("trace blob");
    expect(serialized).not.toContain("transcript ...");
    expect(serialized).not.toContain("iVBORw0KGgo");

    const finding = projection.findings.find((f) => f.code === "redacted-evidence");
    expect(finding?.severity).toBe("info");
    expect(finding?.evidencePath).toBe(".ut-tdd/evidence/verification-profiles/vp-001.json");
  });
});

describe("analyzeRelationImpact (U-RELGRAPH-004..006)", () => {
  const actionKinds = (
    result: ReturnType<typeof analyzeRelationImpact>,
  ): Set<RelationImpactActionKind> => new Set(result.actions.map((a) => a.kind));

  it("U-RELGRAPH-004: source 変更 node が sibling test / L6 design contract / L7 unit oracle / PLAN / reverse-backprop guard へ展開", () => {
    const projection = collectRelationGraphProjection({
      plans: [{ id: "PLAN-L7-32", generates: ["src/lint/relation-graph.ts"] }],
      sourceFiles: [
        { path: "src/lint/relation-graph.ts", tests: ["tests/relation-graph.test.ts"] },
      ],
      tests: [{ path: "tests/relation-graph.test.ts" }],
    });

    const result = analyzeRelationImpact({
      changedPaths: ["src/lint/relation-graph.ts"],
      projection,
    });

    expect(result.ok).toBe(true);
    expect(result.changedNodes.map((n) => n.id)).toEqual(["source:src/lint/relation-graph.ts"]);

    const kinds = actionKinds(result);
    expect(kinds.has("require-sibling-test")).toBe(true); // sibling test
    expect(kinds.has("review-design-contract")).toBe(true); // L6 design contract
    expect(kinds.has("review-l7-oracle")).toBe(true); // L7 unit oracle
    expect(kinds.has("update-plan")).toBe(true); // PLAN
    expect(kinds.has("reverse-backprop")).toBe(true); // reverse/backprop guard

    // reverse-backprop action は変更 source node を指す (向き誤り検出)
    expect(result.actions.find((a) => a.kind === "reverse-backprop")?.nodeId).toBe(
      "source:src/lint/relation-graph.ts",
    );

    // edge を辿った波及先に sibling test と owning PLAN が含まれる
    const impactedIds = result.impacted.map((n) => n.id);
    expect(impactedIds).toContain("test:tests/relation-graph.test.ts");
    expect(impactedIds).toContain("plan:PLAN-L7-32");
  });

  it("U-RELGRAPH-005: design/test-design/physical-data 変更が paired artifact / DB table node / PLAN DoD / trace-freeze evidence へ展開 (behavioral contract edge が無ければ source test を要求しない)", () => {
    const projection = collectRelationGraphProjection({
      requirements: [{ id: "FR-1" }],
      designDocs: [
        // docs-only 設計 (behavioral contract なし)
        { id: "module-drift", path: "docs/design/module-drift.md", pairs: "L7-unit" },
        // behavioral contract を持つ設計
        {
          id: "schema-contract",
          path: "docs/design/schema-contract.md",
          pairs: "L7-schema",
          behavioralContract: ["src/schema/team.ts"],
        },
      ],
      testDesignDocs: [
        { id: "L7-unit", path: "docs/test-design/L7-unit.md" },
        { id: "L7-schema", path: "docs/test-design/L7-schema.md" },
      ],
      sourceFiles: [{ path: "src/schema/team.ts" }],
      dbTables: [
        { name: "plan", upstream: ["requirement:FR-1"], path: "docs/design/physical-data/plan.md" },
      ],
    });

    // docs-only 設計変更: paired artifact / PLAN DoD / trace-freeze へ展開、source test は要求しない
    const docsOnly = analyzeRelationImpact({
      changedPaths: ["docs/design/module-drift.md"],
      projection,
    });
    const docsKinds = actionKinds(docsOnly);
    expect(docsKinds.has("update-paired-artifact")).toBe(true);
    expect(docsKinds.has("update-plan-dod")).toBe(true);
    expect(docsKinds.has("record-trace-freeze-evidence")).toBe(true);
    expect(docsKinds.has("require-sibling-test")).toBe(false); // behavioral contract edge なし
    expect(docsOnly.impacted.map((n) => n.id)).toContain("test-design:L7-unit");

    // test-design 変更: 逆引きで paired design へ展開、paired design に behavioral contract が
    // 無ければ source test を要求しない
    const testDesignChange = analyzeRelationImpact({
      changedPaths: ["docs/test-design/L7-unit.md"],
      projection,
    });
    expect(testDesignChange.changedNodes.map((n) => n.id)).toEqual(["test-design:L7-unit"]);
    expect(testDesignChange.actions.find((a) => a.kind === "update-paired-artifact")?.nodeId).toBe(
      "design:module-drift",
    );
    expect(actionKinds(testDesignChange).has("require-sibling-test")).toBe(false);

    // behavioral contract を持つ test-design 変更: paired design の contract を辿り source test を要求
    const behavioralTestDesign = analyzeRelationImpact({
      changedPaths: ["docs/test-design/L7-schema.md"],
      projection,
    });
    expect(actionKinds(behavioralTestDesign).has("require-sibling-test")).toBe(true);
    expect(behavioralTestDesign.impacted.map((n) => n.id)).toContain("source:src/schema/team.ts");

    // behavioral contract を持つ設計変更: source test を要求する
    const behavioral = analyzeRelationImpact({
      changedPaths: ["docs/design/schema-contract.md"],
      projection,
    });
    expect(actionKinds(behavioral).has("require-sibling-test")).toBe(true);
    expect(behavioral.impacted.map((n) => n.id)).toContain("source:src/schema/team.ts");

    // physical-data 変更: DB table node + upstream requirement へ展開
    const physical = analyzeRelationImpact({
      changedPaths: ["docs/design/physical-data/plan.md"],
      projection,
    });
    expect(physical.changedNodes.map((n) => n.id)).toEqual(["db-table:plan"]);
    expect(actionKinds(physical).has("rebuild-db-table")).toBe(true);
    expect(actionKinds(physical).has("review-upstream")).toBe(true);
    expect(physical.impacted.map((n) => n.id)).toContain("requirement:FR-1");
  });

  it("U-RELGRAPH-005B: changed directory paths expand to projected child nodes without silent fallback", () => {
    const projection = collectRelationGraphProjection({
      designDocs: [
        {
          id: ".ut-tdd/evidence/g10-ux/manifest.json",
          path: ".ut-tdd/evidence/g10-ux/manifest.json",
        },
      ],
    });

    const evidenceDir = analyzeRelationImpact({
      changedPaths: [".ut-tdd/evidence/g10-ux"],
      projection,
    });
    expect(evidenceDir.ok).toBe(true);
    expect(evidenceDir.changedNodes.map((n) => n.id)).toEqual([
      "design:.ut-tdd/evidence/g10-ux/manifest.json",
    ]);
    expect(evidenceDir.findings.map((f) => f.code)).not.toContain("missing-projection");

    const unknownDir = analyzeRelationImpact({
      changedPaths: [".ut-tdd/evidence/unknown-gate"],
      projection,
    });
    expect(unknownDir.ok).toBe(false);
    expect(unknownDir.changedNodes).toEqual([]);
    expect(unknownDir.findings.map((f) => f.code)).toContain("missing-projection");
  });

  it("U-RELGRAPH-006: projection coverage 欠落 (graph projection なし / stale edge) は ok=false + finding、analyzeChangeImpact へ無音 fallback しない", () => {
    const projection = collectRelationGraphProjection({
      sourceFiles: [
        { path: "src/lint/relation-graph.ts", tests: ["tests/relation-graph.test.ts"] },
      ],
      tests: [{ path: "tests/relation-graph.test.ts" }],
    });

    // (a) 変更 path が projection node に無い → missing-projection finding + ok=false
    const noNode = analyzeRelationImpact({
      changedPaths: ["src/runtime/unknown-module.ts"],
      projection,
    });
    expect(noNode.ok).toBe(false);
    expect(noNode.findings.some((f) => f.code === "missing-projection")).toBe(true);
    expect(noNode.changedNodes).toHaveLength(0);

    // (b) 端点 node が欠落した stale edge → stale-edge finding + ok=false
    const staleProjection = {
      ...projection,
      edges: [
        ...projection.edges,
        {
          from: "source:src/lint/relation-graph.ts",
          to: "test:tests/ghost.test.ts",
          kind: "covered-by" as const,
        },
      ],
    };
    const stale = analyzeRelationImpact({
      changedPaths: ["src/lint/relation-graph.ts"],
      projection: staleProjection,
    });
    expect(stale.ok).toBe(false);
    expect(stale.findings.some((f) => f.code === "stale-edge")).toBe(true);
  });
});

describe("exportRelationDiagram (U-RELGRAPH-007..008)", () => {
  it("U-RELGRAPH-007: 同一 snapshot が決定的 Mermaid (安定 node 順 / 安定 edge label / raw evidence payload なし) を出力", () => {
    const SECRET = "sk-live-raw-evidence";
    const snapshot = collectRelationGraphProjection({
      requirements: [{ id: "FR-L1-18" }],
      plans: [
        { id: "PLAN-L7-36", requirements: ["FR-L1-18"], generates: ["src/lint/relation-graph.ts"] },
      ],
      sourceFiles: [
        { path: "src/lint/relation-graph.ts", tests: ["tests/relation-graph.test.ts"] },
      ],
      tests: [{ path: "tests/relation-graph.test.ts" }],
      verificationEvidence: [
        {
          id: "VP-raw",
          evidencePath: ".ut-tdd/evidence/verification-profiles/raw.json",
          classification: "mcp-smoke",
          summary: "sanitized summary",
          rawMcpResponse: SECRET,
        },
      ],
    });

    const a = exportRelationDiagram({ snapshot, format: "mermaid" });
    const b = exportRelationDiagram({ snapshot, format: "mermaid" });

    expect(a.ok).toBe(true);
    expect(a.format).toBe("mermaid");
    expect(a.findings).toEqual([]);
    expect(a.content).toBe(b.content);
    expect(a.content.split("\n")).toEqual([
      "flowchart TD",
      '  plan_PLAN_L7_36["plan:PLAN-L7-36"]',
      '  requirement_FR_L1_18["requirement:FR-L1-18"]',
      '  source_src_lint_relation_graph_ts["source:src/lint/relation-graph.ts"]',
      '  test_tests_relation_graph_test_ts["test:tests/relation-graph.test.ts"]',
      '  verification_profile_VP_raw["verification-profile:VP-raw"]',
      "  plan_PLAN_L7_36 -->|derives-from| requirement_FR_L1_18",
      "  plan_PLAN_L7_36 -->|generates| source_src_lint_relation_graph_ts",
      "  source_src_lint_relation_graph_ts -->|covered-by| test_tests_relation_graph_test_ts",
    ]);
    expect(a.content).not.toContain(SECRET);
    expect(a.content).not.toContain("rawMcpResponse");
  });

  it("U-RELGRAPH-008: DOT/D2 を adapter 未インストールで要求すると unavailable-adapter finding、暗黙インストール/実行しない", () => {
    const snapshot = collectRelationGraphProjection({
      plans: [{ id: "PLAN-L7-36" }],
    });
    const dot = exportRelationDiagram({ snapshot, format: "dot", availableAdapters: [] });
    const d2 = exportRelationDiagram({ snapshot, format: "d2", availableAdapters: ["dot"] });

    expect(dot.ok).toBe(false);
    expect(dot.content).toBe("");
    expect(dot.findings).toEqual([
      expect.objectContaining({
        code: "unavailable-adapter",
        severity: "warn",
      }),
    ]);
    expect(dot.invokedAdapters).toEqual([]);

    expect(d2.ok).toBe(false);
    expect(d2.content).toBe("");
    expect(d2.findings[0]?.message).toContain("d2");
    expect(d2.invokedAdapters).toEqual([]);
  });
});

describe("collectVerificationEvidenceProjection (U-RELGRAPH-009..010)", () => {
  it("U-RELGRAPH-009: A-125 verification-evidence-v1 record が verification_profiles / verification_recommendations / mcp_server_runs / external_tool_findings 行へ (evidence path 付き)", () => {
    const projection = collectVerificationEvidenceProjection([
      {
        schema_version: "verification-evidence-v1",
        evidence_path: ".ut-tdd/evidence/verification-profiles/playwright.json",
        profile: {
          id: "playwright-mcp",
          name: "Playwright MCP",
          profile_type: "mcp",
          enabled: true,
        },
        recommendation: {
          id: "rec-1",
          change_set_id: "change-1",
          plan_id: "PLAN-L7-36",
          profile_id: "playwright-mcp",
          profile_kind: "browser",
          reason: "UI artifact changed",
          source_rule: "relation-graph",
          accepted: false,
        },
        mcp_run: {
          id: "run-1",
          profile_id: "playwright-mcp",
          session_id: "session-1",
          plan_id: "PLAN-L7-36",
          command: "mcp-inspector",
          method: "tools/list",
          tool_name: "browser_navigate",
          normalized_status: "passed",
          exit_code: 0,
        },
        findings: [
          {
            id: "finding-1",
            source_run_id: "run-1",
            source_kind: "mcp",
            finding_type: "tools-list",
            severity: "info",
            subject_id: "playwright-mcp",
            path: "docs/test-design/harness/L8-integration-test-design.md",
            status: "open",
            digest: "tools available",
          },
        ],
      },
    ]);

    expect(projection.ok).toBe(true);
    expect(projection.verification_profiles).toEqual([
      expect.objectContaining({
        verification_profile_id: "playwright-mcp",
        name: "Playwright MCP",
        profile_type: "mcp",
        evidence_path: ".ut-tdd/evidence/verification-profiles/playwright.json",
      }),
    ]);
    expect(projection.verification_recommendations).toEqual([
      expect.objectContaining({
        verification_recommendation_id: "rec-1",
        change_set_id: "change-1",
        plan_id: "PLAN-L7-36",
        evidence_path: ".ut-tdd/evidence/verification-profiles/playwright.json",
      }),
    ]);
    expect(projection.mcp_server_runs).toEqual([
      expect.objectContaining({
        mcp_run_id: "run-1",
        mcp_profile_id: "playwright-mcp",
        method: "tools/list",
        evidence_path: ".ut-tdd/evidence/verification-profiles/playwright.json",
      }),
    ]);
    expect(projection.external_tool_findings).toEqual([
      expect.objectContaining({
        external_finding_id: "finding-1",
        source_run_id: "run-1",
        evidence_path: ".ut-tdd/evidence/verification-profiles/playwright.json",
      }),
    ]);
  });

  it("U-RELGRAPH-010: 不正 evidence (malformed / schema 欠落 / allow_external なし external run) は finding、raw external payload を除外", () => {
    const SECRET = "provider-transcript-secret";
    const projection = collectVerificationEvidenceProjection([
      {
        evidence_path: ".ut-tdd/evidence/verification-profiles/missing-schema.json",
        raw_payload: SECRET,
      },
      {
        schema_version: "verification-evidence-v1",
        evidence_path: ".ut-tdd/evidence/verification-profiles/external-denied.json",
        allow_external: false,
        mcp_run: {
          id: "run-denied",
          profile_id: "github-mcp",
          command: "github-mcp",
          method: "tools/list",
          normalized_status: "passed",
        },
        raw_payload: { transcript: SECRET },
      },
    ]);

    expect(projection.ok).toBe(false);
    expect(projection.findings.map((f) => f.code)).toEqual([
      "external-not-allowed",
      "invalid-evidence",
    ]);
    expect(projection.mcp_server_runs).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain(SECRET);
    expect(JSON.stringify(projection)).not.toContain("raw_payload");
  });
});
