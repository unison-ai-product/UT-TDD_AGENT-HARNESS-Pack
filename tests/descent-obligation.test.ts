import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDescentObligations,
  descentObligationMessages,
  filterSubstanceVerifiedAdvisories,
  generateObligations,
  loadDeferLedger,
  loadDescentAdjacency,
  loadFrUnitCoverageOracles,
  loadTraceKeyedArtifacts,
} from "../src/lint/descent-obligation";
import {
  DEFAULT_DESCENT_ADJACENCY,
  type DeferEntry,
  type TraceKeyedArtifact,
} from "../src/lint/descent-obligation-types";

const a = (
  over: Partial<TraceKeyedArtifact> & Pick<TraceKeyedArtifact, "traceKey" | "layer" | "role">,
): TraceKeyedArtifact => ({
  path: `${over.layer}/${over.role}/${over.traceKey}.md`,
  status: "active",
  ...over,
});

const defer = (
  over: Partial<DeferEntry> & Pick<DeferEntry, "traceKey" | "waitingLayer">,
): DeferEntry => ({
  fromLayer: "L6",
  waitingSpec: `${over.waitingLayer} follow-up`,
  dischargeCondition: "documented close condition",
  owner: "tl",
  ...over,
});

describe("descent-obligation ledger (PLAN-L6-35 / FR-L1-03)", () => {
  it("U-DESC-001: generates obligations from upstream adjacency, not downstream self-declarations", () => {
    const artifacts = [
      a({ traceKey: "FR-L1-03", layer: "L3", role: "requirement" }),
      a({ traceKey: "FR-L1-03", layer: "L4", role: "design" }),
      a({ traceKey: "FR-L1-03", layer: "L7", role: "source" }),
    ];

    const obligations = generateObligations(artifacts, DEFAULT_DESCENT_ADJACENCY);

    expect(obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ traceKey: "FR-L1-03", fromLayer: "L3", requiredLayer: "L4" }),
        expect.objectContaining({ traceKey: "FR-L1-03", fromLayer: "L4", requiredLayer: "L5" }),
        expect.objectContaining({ traceKey: "FR-L1-03", requiredLayer: "L7", kind: "impl-guard" }),
      ]),
    );
    expect(obligations.some((row) => row.requiredLayer === "L2")).toBe(false);
  });

  it("U-DESC-002: rejects untraceable artifacts and duplicate trace/layer/role rows", () => {
    const result = analyzeDescentObligations(
      [
        a({ traceKey: "", layer: "L4", role: "design", path: "docs/no-trace.md" }),
        a({ traceKey: "FR-L1-03", layer: "L7", role: "source", path: "src/a.ts" }),
        a({ traceKey: "FR-L1-03", layer: "L7", role: "source", path: "src/b.ts" }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["untraceable", "duplicate-key"]),
    );
  });

  it("U-DESC-003: marks a fully descended active chain as satisfied", () => {
    const artifacts = [
      a({ traceKey: "FR-L1-03", layer: "L1", role: "requirement" }),
      a({ traceKey: "FR-L1-03", layer: "L3", role: "requirement" }),
      a({ traceKey: "FR-L1-03", layer: "L4", role: "design" }),
      a({ traceKey: "FR-L1-03", layer: "L5", role: "design" }),
      a({ traceKey: "FR-L1-03", layer: "L6", role: "design" }),
      a({ traceKey: "FR-L1-03", layer: "L7", role: "test-design" }),
    ];

    const result = analyzeDescentObligations(artifacts, DEFAULT_DESCENT_ADJACENCY, []);

    expect(result.ok).toBe(true);
    expect(result.obligations.every((obligation) => obligation.status === "satisfied")).toBe(true);
    expect(result.chains).toContainEqual(
      expect.objectContaining({ traceKey: "FR-L1-03", complete: true, firstGap: null }),
    );
  });

  it("U-DESC-013: surfaces blanket-range-only L7 coverage as a thin-coverage advisory without failing ok (warn-first, PLAN-L7-52 C-2)", () => {
    // impl 無し (L8/L9/L12 の impl-present 義務を発火させない) で L6→L7 pair が満たされる鎖。
    const base: TraceKeyedArtifact[] = [
      a({ traceKey: "FR-L1-47", layer: "L1", role: "requirement" }),
      a({ traceKey: "FR-L1-47", layer: "L3", role: "requirement" }),
      a({ traceKey: "FR-L1-47", layer: "L4", role: "design" }),
      a({ traceKey: "FR-L1-47", layer: "L5", role: "design" }),
      a({ traceKey: "FR-L1-47", layer: "L6", role: "design" }),
    ];

    // L7 unit-test-design coverage が blanket レンジ展開のみ由来 → advisory、ただし ok は不変
    const rangeOnly = analyzeDescentObligations(
      [
        ...base,
        a({ traceKey: "FR-L1-47", layer: "L7", role: "test-design", traceKeyFromRange: true }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
      [],
    );
    expect(rangeOnly.ok).toBe(true);
    expect(rangeOnly.advisories).toContainEqual(
      expect.objectContaining({ traceKey: "FR-L1-47", requiredLayer: "L7" }),
    );
    expect(descentObligationMessages(rangeOnly).join("\n")).toContain("thin-coverage");

    // focused (非レンジ) な L7 test-design oracle があれば advisory は出ない
    const focused = analyzeDescentObligations(
      [
        ...base,
        a({ traceKey: "FR-L1-47", layer: "L7", role: "test-design", traceKeyFromRange: false }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
      [],
    );
    expect(focused.ok).toBe(true);
    expect(focused.advisories).toEqual([]);

    // range-only と focused が併存する場合は focused が優先され advisory は出ない (every が false)
    const mixed = analyzeDescentObligations(
      [
        ...base,
        a({ traceKey: "FR-L1-47", layer: "L7", role: "test-design", traceKeyFromRange: true }),
        a({
          traceKey: "FR-L1-47",
          layer: "L7",
          role: "test-design",
          path: "docs/test-design/harness/focused.md",
          traceKeyFromRange: false,
        }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
      [],
    );
    expect(mixed.ok).toBe(true);
    expect(mixed.advisories).toEqual([]);

    // fr-unit-coverage.md (l6-fr-coverage SSoT) に U-FR oracle がある FR は substance-verified
    // として後段合成で除外され advisory は出ない (ゲート間整合、PLAN-L7-52 C-2 Phase-1)。
    const verified = filterSubstanceVerifiedAdvisories(rangeOnly, new Set(["FR-L1-47"]));
    expect(verified.ok).toBe(true);
    expect(verified.advisories).toEqual([]);
    // 正本に含まれない FR は除外されず advisory が残る。
    const stillThin = filterSubstanceVerifiedAdvisories(rangeOnly, new Set(["FR-L1-99"]));
    expect(stillThin.advisories).toContainEqual(expect.objectContaining({ traceKey: "FR-L1-47" }));
  });

  it("U-DESC-014: loadFrUnitCoverageOracles reads the l6-fr-coverage SSoT and filters real-repo advisories", () => {
    const root = process.cwd();
    const oracles = loadFrUnitCoverageOracles(root);
    // fr-unit-coverage.md にマトリクス行と U-FR oracle を持つ FR は含まれる (frId 正規化 = 2 桁)。
    expect(oracles.has("FR-L1-47")).toBe(true);
    expect(oracles.has("FR-L1-01")).toBe(true);
    // FR-L1-36 は PLAN-L7-53 で実装・登録済み → oracle 行あり → 含まれる。
    expect(oracles.has("FR-L1-36")).toBe(true);
    // FR-L1-43 は PLAN-L7-53 で実装・登録済み → oracle 行あり → 含まれる。
    expect(oracles.has("FR-L1-43")).toBe(true);
    // FR-L1-38 は PLAN-L7-53 で実装・登録済み → oracle 行あり → 含まれる。
    expect(oracles.has("FR-L1-38")).toBe(true);

    // end-to-end: 実 repo の advisory を filter すると、oracle 正本にある FR は残らない (ゲート整合)。
    const filtered = filterSubstanceVerifiedAdvisories(
      analyzeDescentObligations(
        loadTraceKeyedArtifacts(root),
        loadDescentAdjacency(root),
        loadDeferLedger(root),
      ),
      oracles,
    );
    expect(filtered.ok).toBe(true);
    expect(filtered.advisories.every((advisory) => !oracles.has(advisory.traceKey))).toBe(true);
  });

  it("U-DESC-004: reports missing downstream pairs as unmet even when a placeholder exists", () => {
    const result = analyzeDescentObligations(
      [
        a({ traceKey: "FR-L1-47", layer: "L6", role: "design" }),
        a({
          traceKey: "FR-L1-47",
          layer: "L7",
          role: "test-design",
          status: "placeholder",
        }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.obligations).toContainEqual(
      expect.objectContaining({
        traceKey: "FR-L1-47",
        requiredLayer: "L7",
        status: "unmet",
      }),
    );
    expect(result.chains).toContainEqual(
      expect.objectContaining({ traceKey: "FR-L1-47", complete: false, firstGap: "L7" }),
    );
  });

  it("U-DESC-005: honors valid defers before implementation and rejects hollow defers", () => {
    const artifacts = [a({ traceKey: "FR-L1-03", layer: "L6", role: "design" })];
    const deferred = analyzeDescentObligations(artifacts, DEFAULT_DESCENT_ADJACENCY, [
      defer({ traceKey: "FR-L1-03", waitingLayer: "L7" }),
    ]);
    const invalid = analyzeDescentObligations(artifacts, DEFAULT_DESCENT_ADJACENCY, [
      defer({ traceKey: "FR-L1-03", waitingLayer: "L7", owner: "" }),
    ]);

    expect(deferred.ok).toBe(true);
    expect(deferred.obligations).toContainEqual(
      expect.objectContaining({ requiredLayer: "L7", status: "deferred" }),
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.findings).toContainEqual(expect.objectContaining({ code: "invalid-defer" }));
    expect(invalid.obligations).toContainEqual(
      expect.objectContaining({ requiredLayer: "L7", status: "unmet" }),
    );
  });

  it("U-DESC-006: reports impl-ahead for open design/test-design defers without double-registering unmet", () => {
    const result = analyzeDescentObligations(
      [
        a({ traceKey: "FR-L1-47", layer: "L6", role: "design" }),
        a({ traceKey: "FR-L1-47", layer: "L7", role: "source", path: "src/skills/recommend.ts" }),
        a({ traceKey: "FR-L1-47", layer: "L7", role: "test-design" }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
      [defer({ traceKey: "FR-L1-47", waitingLayer: "L6" })],
    );

    expect(result.ok).toBe(false);
    expect(result.implAhead).toContainEqual(
      expect.objectContaining({ traceKey: "FR-L1-47", waitingLayer: "L6", landedAt: "L7" }),
    );
    expect(
      result.obligations.filter(
        (obligation) =>
          obligation.traceKey === "FR-L1-47" &&
          obligation.requiredLayer === "L6" &&
          obligation.status === "unmet",
      ),
    ).toHaveLength(0);
  });

  it("U-DESC-007: does not generate descent obligations from park or placeholder upstream artifacts", () => {
    const obligations = generateObligations(
      [
        a({ traceKey: "FR-L1-03", layer: "L6", role: "design", status: "park" }),
        a({ traceKey: "FR-L1-04", layer: "L6", role: "design", status: "placeholder" }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
    );

    expect(obligations).toHaveLength(0);
  });

  it("U-DESC-008: formats actionable messages and keeps the real repo loader wired", () => {
    const result = analyzeDescentObligations(
      [
        a({ traceKey: "FR-L1-47", layer: "L6", role: "design" }),
        a({ traceKey: "FR-L1-47", layer: "L7", role: "source", path: "src/skills/recommend.ts" }),
      ],
      DEFAULT_DESCENT_ADJACENCY,
      [],
    );
    const messages = descentObligationMessages(result);

    expect(messages.join("\n")).toContain("FR-L1-47");
    expect(messages.join("\n")).toContain("L7");
    expect(messages.join("\n")).toMatch(/unmet|impl-ahead/);

    const repoResult = analyzeDescentObligations(
      loadTraceKeyedArtifacts(process.cwd()),
      loadDescentAdjacency(process.cwd()),
      [],
    );
    expect(descentObligationMessages(repoResult).length).toBeGreaterThan(0);
  });

  it("U-DESC-009: ignores unit-oracle ids and fixture-only test traces in repo loading", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-descent-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      mkdirSync(join(root, "docs", "design", "harness", "L6-function-design"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "src", "feature.ts"),
        "// @ut-tdd-trace FR-L1-01\nexport const trace = 'FR-L1-99';\n",
        "utf8",
      );
      writeFileSync(
        join(root, "tests", "feature.test.ts"),
        "const fixture = ['FR-L1-99', 'U-FOO-001'];\n// @ut-tdd-trace FR-L1-02\n",
        "utf8",
      );
      writeFileSync(
        join(root, "docs", "design", "harness", "L6-function-design", "function-spec.md"),
        [
          "---",
          "layer: L6",
          "status: confirmed",
          "---",
          "FR-L1-03 / U-FR-L1-04 / U-FOO-001",
          "FR-L1-31〜FR-L1-33 / FR-L1-36/38/43 / U-FR-L1-10..U-FR-L1-11",
        ].join("\n"),
        "utf8",
      );

      const artifacts = loadTraceKeyedArtifacts(root);

      expect(artifacts).toContainEqual(
        expect.objectContaining({ traceKey: "FR-L1-01", role: "source" }),
      );
      expect(artifacts).toContainEqual(
        expect.objectContaining({ traceKey: "FR-L1-03", role: "design" }),
      );
      expect(artifacts).toContainEqual(
        expect.objectContaining({ traceKey: "FR-L1-04", role: "design" }),
      );
      for (const traceKey of [
        "FR-L1-10",
        "FR-L1-11",
        "FR-L1-31",
        "FR-L1-32",
        "FR-L1-33",
        "FR-L1-36",
        "FR-L1-38",
        "FR-L1-43",
      ]) {
        expect(artifacts).toContainEqual(expect.objectContaining({ traceKey, role: "design" }));
      }
      expect(artifacts.some((artifact) => artifact.traceKey === "FR-L1-99")).toBe(false);
      expect(artifacts.some((artifact) => artifact.traceKey === "FR-L1-02")).toBe(false);
      expect(artifacts.some((artifact) => artifact.traceKey.startsWith("U-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DESC-010: only creates defer rows for trace keys on the defer line", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-descent-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writeFileSync(
        join(root, "docs", "plans", "PLAN-L6-test.md"),
        [
          "---",
          "layer: L6",
          "status: confirmed",
          "---",
          "FR-L1-19 appears elsewhere in the file.",
          "- placeholder_deps waiting_layer:L6 owner:tl no trace key here",
          "- FR-L1-46 placeholder_deps waiting_layer:L6 owner:tl explicit trace",
        ].join("\n"),
        "utf8",
      );

      const defers = loadDeferLedger(root);

      expect(defers).toHaveLength(1);
      expect(defers[0]).toEqual(
        expect.objectContaining({ traceKey: "FR-L1-46", waitingLayer: "L6" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DESC-011: does not treat acceptance-case ids as descent-chain trace keys", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-descent-"));
    try {
      mkdirSync(join(root, "docs", "design", "harness", "L5-detailed-design"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "docs", "design", "harness", "L5-detailed-design", "internal.md"),
        "---\nlayer: L5\nstatus: confirmed\n---\nAC-FR-01-02 aligns with fail-close behavior.\n",
        "utf8",
      );

      const artifacts = loadTraceKeyedArtifacts(root);

      expect(artifacts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DESC-012: treats L1 functional requirements as the owner for FR-L1 artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-descent-"));
    try {
      mkdirSync(join(root, "docs", "design", "harness", "L1-requirements"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "docs", "design", "harness", "L1-requirements", "functional-requirements.md"),
        "---\nlayer: L1\nstatus: confirmed\n---\nFR-L1-05\n",
        "utf8",
      );
      writeFileSync(
        join(root, "docs", "design", "harness", "L1-requirements", "business-requirements.md"),
        "---\nlayer: L1\nstatus: confirmed\n---\nFR-L1-05 reference only\n",
        "utf8",
      );

      const artifacts = loadTraceKeyedArtifacts(root).filter(
        (artifact) => artifact.traceKey === "FR-L1-05",
      );

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.path).toBe(
        "docs/design/harness/L1-requirements/functional-requirements.md",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
