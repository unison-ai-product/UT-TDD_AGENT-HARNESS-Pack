import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CatalogInput,
  DocumentDispositionCatalog,
} from "../src/disposition/domain/document-disposition-catalog.ts";
import {
  normalizeDocumentApplicability,
  validateDocumentDisposition,
} from "../src/document-disposition/domain/document-disposition.ts";
import { documentDeltaDecisionDigest } from "../src/document-disposition/domain/replay-document-deltas.ts";
import { evaluateStaticGate } from "../src/gate/static.ts";
import { parseIssueUrl } from "../src/shared/issue-ref.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const fixtureRoots: string[] = [];

function writeFixture(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function consumerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "planret-s3-g14-"));
  fixtureRoots.push(root);
  writeFixture(
    root,
    "docs/design/L1-consumer/functional-requirements.md",
    "---\ndoc_type_id: DOC-L1-FUNCTIONAL-REQUIREMENTS\n---\n\n**FR-L1-01**\n**BR-01**\n",
  );
  writeFixture(
    root,
    "docs/design/L0-planning/charter.md",
    "---\nlayer: L0\ndoc_type_id: DOC-L0-CHARTER\n---\n\nConsumer charter.\n",
  );
  writeFixture(root, "docs/plans/PLAN-L0-01.md", "---\nplan_id: PLAN-L0-01\n---\n");
  const content = [
    "---",
    "doc_type_id: DOC-L14-OPERATIONAL-TEST",
    "layer: L14",
    "status: confirmed",
    "---",
    "",
    "# DOC-L14-OPERATIONAL-TEST: 運用設計書 / 保守・メンテナンス設計書",
    "#### 第1章 運用方針",
    "#### 第2章 監視設計",
    "##### 2-1 監視指標(SLI)とアラート",
    "#### 第3章 SLO/SLA・エラーバジェット",
    "##### 3-1 SLI/SLO",
    "##### 3-2 エラーバジェット",
    "##### 3-3 エラーバジェットポリシー",
    "##### 3-4 SLA(対顧客)",
    "#### 第4章 バックアップ/リストア",
    "##### 4-1 方式",
    "##### 4-2 リストア運用",
    "#### 第5章 障害対応・ランブック",
    "##### 5-1 重大度とエスカレーション",
    "##### 5-2 ランブック(抜粋)",
    "#### 第6章 リリース/ロールバック",
    "##### 6-1 リリース方式",
    "##### 6-2 ロールバック",
    "#### 第7章 キャパシティ/コスト",
    "#### 第1章 保守方針・区分",
    "#### 第2章 パッチ・脆弱性/依存管理",
    "#### 第3章 定期メンテナンス",
    "#### 第4章 データライフサイクル",
    "#### 第5章 バージョン/EOL・サンセット",
    "#### 第6章 技術的負債管理",
    "#### 第7章 サポート・SLA保守",
    "#### 第8章 運用引継ぎ(ハンドオーバー)",
    "",
    "### harness 追補: G14 検証ケース",
    "",
    "| ケースID | family | 検証内容 | 合否基準 | トレース元 |",
    "|---|---|---|---|---|",
    "| OT-PLANRET-01 | OT | 日常運用の手順 | 失敗 0 | FR-L1-01 |",
    "| OT-PLANRET-02 | VALUE | 導入価値の検証 | KPI 達成 | BR-01 / DOC-L0-CHARTER |",
    "",
  ].join("\n");
  writeFixture(root, "docs/test-design/L14-operational-test-design.md", content);
  writeFixture(root, "tests/fixtures/planret/operational.txt", "passed\n");
  writeFixture(root, "tests/fixtures/planret/value.txt", "passed\n");
  writeFixture(root, "tests/fixtures/planret/command.txt", "passed\n");
  writeFixture(
    root,
    ".ut-tdd/evidence/g14-operational/artifacts/feedback.json",
    json({
      items: [
        { summary: "operator feedback", routed_to: "https://github.com/example/repo/issues/13" },
        { summary: "tool feedback", routed_to: "https://github.com/example/repo/issues/12" },
      ],
    }),
  );
  writeFixture(
    root,
    ".ut-tdd/evidence/g14-operational/ok.json",
    json({
      schema_version: "g14-operational-evidence-v1",
      gate: "G14",
      profile: "consumer-operational-minimum",
      plan_id: "PLAN-CONSUMER-01",
      selected_ot_ids: ["OT-PLANRET-01", "OT-PLANRET-02"],
      mandatory_ot_ids: ["OT-PLANRET-01", "OT-PLANRET-02"],
      deferred_ot_ids: [],
      commands: [
        {
          command_id: "cmd-planret",
          command: "npm test",
          runner: "node",
          scope: "consumer",
          exit_code: 0,
          output_digest: `sha256:${"a".repeat(64)}`,
          evidence_path: "tests/fixtures/planret/command.txt",
          ot_ids: ["OT-PLANRET-01", "OT-PLANRET-02"],
        },
      ],
      coverage: [
        {
          ot_id: "OT-PLANRET-01",
          status: "passed",
          evidence_paths: ["tests/fixtures/planret/operational.txt"],
          command_ids: ["cmd-planret"],
        },
        {
          ot_id: "OT-PLANRET-02",
          status: "passed",
          evidence_paths: ["tests/fixtures/planret/value.txt"],
          command_ids: ["cmd-planret"],
        },
      ],
      defer: [],
      exit_criteria: {
        all_mandatory_passed: true,
        failed_mandatory_count: 0,
        stale_defer_count: 0,
        doctor_check: "g14-operational-workflow",
      },
      artifacts: {
        operational_results: "tests/fixtures/planret/operational.txt",
        value_results: "tests/fixtures/planret/value.txt",
        improvement_feedback: ".ut-tdd/evidence/g14-operational/artifacts/feedback.json",
      },
    }),
  );
  return root;
}

function evaluateG14(root: string) {
  return evaluateStaticGate({ gate: "G14", repoRoot: root });
}

function makeValueCase(root: string, citations: string): void {
  const slot = join(root, "docs/test-design/L14-operational-test-design.md");
  const content = readFileSync(slot, "utf8").replace(
    "| OT-PLANRET-02 | VALUE | 導入価値の検証 | KPI 達成 | BR-01 / DOC-L0-CHARTER |",
    `| OT-PLANRET-02 | VALUE | 導入価値の検証 | KPI 達成 | ${citations} |`,
  );
  writeFileSync(slot, content, "utf8");
}

describe("PLAN mechanism retirement S3 Red", () => {
  it("precondition: consumer G14 fixture passes before candidate mutations", () => {
    const root = consumerFixture();
    const result = evaluateG14(root);

    const planDirectory = join(root, "docs/plans");
    expect(readdirSync(planDirectory)).toEqual(["PLAN-L0-01.md"]);
    expect(readFileSync(join(planDirectory, "PLAN-L0-01.md"), "utf8")).toContain(
      "plan_id: PLAN-L0-01",
    );
    expect(result.passed, result.messages.join("\n")).toBe(true);
  });

  it("CANDIDATE-U-PLANRET-001: accepts only the canonical GitHub Issue URL", () => {
    const cases = [
      {
        input: "https://github.com/o/r/issues/12",
        expected: { owner: "o", repo: "r", number: 12 },
      },
      { input: "https://github.com/o/r/issues/0", expected: null },
      { input: "https://github.com/o/r/issues/012", expected: null },
      { input: "https://github.com/o/r/pull/12", expected: null },
      { input: "https://github.com/o/r/issues/12/", expected: null },
      { input: "https://github.com/o/r/issues/12#x", expected: null },
      { input: " https://github.com/o/r/issues/12", expected: null },
      { input: "http://github.com/o/r/issues/12", expected: null },
      { input: "https://example.com/o/r/issues/12", expected: null },
      { input: "PLAN-L7-1-x", expected: null },
    ] as const;

    const actual = cases.map(({ input }) => parseIssueUrl(input));
    expect(actual).toEqual(cases.map(({ expected }) => expected));
  });

  it("CANDIDATE-U-PLANRET-003: accepts Issue URLs but rejects PLAN routing", () => {
    const root = consumerFixture();
    const feedbackPath = join(root, ".ut-tdd/evidence/g14-operational/artifacts/feedback.json");
    const feedback = JSON.parse(readFileSync(feedbackPath, "utf8")) as {
      items: { routed_to: string }[];
    };
    expect(feedback.items[1]?.routed_to).toBe("https://github.com/example/repo/issues/12");
    feedback.items = feedback.items.map((item, index) =>
      index === 0 ? { ...item, routed_to: "PLAN-L7-1-x" } : item,
    );
    writeFileSync(feedbackPath, json(feedback), "utf8");

    const result = evaluateG14(root);
    const messages = result.messages.join("\n");

    expect(result.passed).toBe(false);
    expect(messages).toContain("PLAN-L7-1-x");
    expect(messages).not.toContain("does not exist");
  });

  it("CANDIDATE-U-PLANRET-004(a): accepts a design-root L0 doc_type_id citation", () => {
    const root = consumerFixture();
    makeValueCase(root, "BR-01 / DOC-L0-CHARTER");

    const result = evaluateG14(root);

    expect(result.passed).toBe(true);
  });

  it("CANDIDATE-U-PLANRET-004(b): a resolvable PLAN-L0 citation is not an L0 citation", () => {
    const root = consumerFixture();
    makeValueCase(root, "BR-01 / PLAN-L0-01");
    const result = evaluateG14(root);

    expect(result.messages.join("\n")).toContain("trace target missing PLAN-L0-01");
    expect(result.messages.join("\n")).toContain("does not cite L0");
  });

  it("CANDIDATE-U-PLANRET-004(c): VALUE error asks for a doc_type_id citation", () => {
    const root = consumerFixture();
    makeValueCase(root, "BR-01");

    const result = evaluateG14(root);

    expect(result.messages.join("\n")).toContain("does not cite L0");
    expect(result.messages.join("\n")).toContain("doc_type_id");
  });

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) removeTestTree(root);
  });
  it("CANDIDATE-U-PLANRET-005(a): normalizes Issue-backed defer", () => {
    const result = normalizeDocumentApplicability({
      kind: "defer",
      reason: "後続対応",
      reevaluationTrigger: "issue が解決したとき",
      issue: "https://github.com/example/repo/issues/12",
    } as unknown as Parameters<typeof normalizeDocumentApplicability>[0]);

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "deferred",
        reason: "後続対応",
        reevaluationTrigger: "issue が解決したとき",
        issue: "https://github.com/example/repo/issues/12",
      },
    });
  });

  it("CANDIDATE-U-PLANRET-005(b): requires issue, not legacy plan_id", () => {
    const result = validateDocumentDisposition({
      baselinePath: "docs/a.md",
      disposition: "retain",
      reason: "確認済み",
      targets: [],
      planIds: [],
      applicationStatus: "verified",
      applicability: {
        kind: "deferred",
        reason: "後続対応",
        reevaluationTrigger: "Issue 解決",
        planId: "PLAN-L7-1-x",
      },
    });

    expect(result).toEqual({ ok: false, missingFields: ["applicability.issue"] });
  });

  it("CANDIDATE-U-PLANRET-005(c): updates require a target or Issue", () => {
    const result = validateDocumentDisposition({
      baselinePath: "docs/a.md",
      disposition: "update",
      reason: "内容を更新する",
      targets: [],
      planIds: [],
      applicationStatus: "pending",
      applicability: { kind: "applicable" },
    });

    expect(result).toEqual({ ok: false, missingFields: ["targets_or_issues"] });
  });

  it("CANDIDATE-U-PLANRET-005(d): recomputes the digest of a recorded plan_ids decision", () => {
    const recordedDigest = documentDeltaDecisionDigest({
      deltaId: "delta:planret-005-d",
      ledgerId: "ledger:planret-005",
      fromSnapshotDigest: "sha256:baseline",
      toSnapshotDigest: "sha256:final",
      operationKind: "add",
      after: {
        path: "docs/legacy.md",
        blobOid: "blob:recorded",
        contentDigest: "sha256:recorded",
      },
      affectedPath: "docs/legacy.md",
      record: {
        baselinePath: "docs/legacy.md",
        disposition: "retain",
        reason: "recorded legacy decision",
        targets: [],
        planIds: ["PLAN-L6-02", "PLAN-L6-01"],
        applicationStatus: "verified",
        applicability: {
          kind: "deferred",
          reason: "legacy plan-backed defer",
          reevaluationTrigger: "legacy record only",
          planId: "PLAN-L6-01",
        },
      },
    });

    expect(recordedDigest).toBe("509a09c2bac0cc1d8cc74a8e359fb4de60b63d86a57b9ece992de6bbb060f91f");
  });

  it("CANDIDATE-U-PLANRET-005(e): rejects plan_alias as an unknown target kind", () => {
    const input: CatalogInput = {
      manifestIdentity: { auditedOn: "2026-11-04", zipSha256: "a".repeat(64) },
      declaredCounts: {
        sources: 0,
        items: 0,
        categories: 0,
        metaSourceMappings: 0,
        sourceItemEdges: 0,
        sourceTargetEdges: 0,
        itemTargetEdges: 1,
      },
      sources: [],
      items: [],
      categories: [],
      metaSourceMappings: [],
      sourceItemEdges: [],
      sourceTargetEdges: [],
      itemTargetEdges: [
        {
          edgeId: "EDGE-1",
          itemId: "ITEM-1",
          targetStatus: "adopt",
          reason: "既存記録",
          sourceDigest: "b".repeat(64),
          targetKind:
            "plan_alias" as unknown as CatalogInput["itemTargetEdges"][number]["targetKind"],
          targetRef: "PLAN-L7-1-x",
        } as CatalogInput["itemTargetEdges"][number],
      ],
    };

    const result = DocumentDispositionCatalog.create(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          ruleId: "catalog-authoring-enum-invalid",
          subjectId: "EDGE-1",
        }),
      );
    }
  });
});
