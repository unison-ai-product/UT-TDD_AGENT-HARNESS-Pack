import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateStaticGate } from "../src/gate/static.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const roots: string[] = [];

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function consumerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-g14-l0-"));
  roots.push(root);
  write(
    root,
    "docs/design/L1-consumer/functional-requirements.md",
    "---\ndoc_type_id: DOC-L1-FUNCTIONAL-REQUIREMENTS\n---\n\n**FR-L1-01**\n**BR-01**\n",
  );
  write(
    root,
    "docs/design/L0-planning/consumer-charter.md",
    "---\nlayer: L0\ndoc_type_id: DOC-L0-CHARTER\n---\n",
  );
  write(root, "docs/plans/PLAN-CONSUMER-01.md", "---\nplan_id: PLAN-CONSUMER-01\n---\n");
  const content = `---
doc_type_id: DOC-L14-OPERATIONAL-TEST
layer: L14
status: confirmed
plan: docs/plans/PLAN-CONSUMER-01.md
---

# DOC-L14-OPERATIONAL-TEST: 運用設計書 / 保守・メンテナンス設計書
#### 第1章 運用方針
#### 第2章 監視設計
##### 2-1 監視指標(SLI)とアラート
#### 第3章 SLO/SLA・エラーバジェット
##### 3-1 SLI/SLO
##### 3-2 エラーバジェット
##### 3-3 エラーバジェットポリシー
##### 3-4 SLA(対顧客)
#### 第4章 バックアップ/リストア
##### 4-1 方式
##### 4-2 リストア運用
#### 第5章 障害対応・ランブック
##### 5-1 重大度とエスカレーション
##### 5-2 ランブック(抜粋)
#### 第6章 リリース/ロールバック
##### 6-1 リリース方式
##### 6-2 ロールバック
#### 第7章 キャパシティ/コスト
#### 第1章 保守方針・区分
#### 第2章 パッチ・脆弱性/依存管理
#### 第3章 定期メンテナンス
#### 第4章 データライフサイクル
#### 第5章 バージョン/EOL・サンセット
#### 第6章 技術的負債管理
#### 第7章 サポート・SLA保守
#### 第8章 運用引継ぎ(ハンドオーバー)

### harness 追補: G14 検証ケース
| ケースID | family | 検証内容 | 合否基準 | トレース元 |
|---|---|---|---|---|
| OT-CONSUMER-01 | OT | 日常運用の手順 | 失敗 0 | FR-L1-01 |
| OT-CONSUMER-02 | VALUE | 導入価値の検証 | KPI 達成 | BR-01 / DOC-L0-CHARTER |
`;
  write(root, "docs/test-design/L14-operational-test-design.md", content);
  write(root, "tests/fixtures/g14-consumer/operational-results.txt", "passed\n");
  write(root, "tests/fixtures/g14-consumer/value-results.txt", "passed\n");
  write(root, "tests/fixtures/g14-consumer/command-output.txt", "passed\n");
  write(
    root,
    ".ut-tdd/evidence/g14-operational/artifacts/feedback.json",
    json({
      items: [
        {
          summary: "onboarding 手順の短縮",
          routed_to: "https://github.com/example/consumer/issues/13",
        },
        {
          summary: "doctor 出力の整理",
          routed_to: "https://github.com/example/consumer/issues/12",
        },
      ],
    }),
  );
  write(
    root,
    ".ut-tdd/evidence/g14-operational/ok.json",
    json({
      schema_version: "g14-operational-evidence-v1",
      gate: "G14",
      profile: "consumer-operational-minimum",
      plan_id: "PLAN-CONSUMER-01",
      selected_ot_ids: ["OT-CONSUMER-01", "OT-CONSUMER-02"],
      mandatory_ot_ids: ["OT-CONSUMER-01", "OT-CONSUMER-02"],
      deferred_ot_ids: [],
      commands: [
        {
          command_id: "cmd-consumer-operational",
          command: "npm test",
          runner: "node",
          scope: "consumer",
          exit_code: 0,
          output_digest: `sha256:${"a".repeat(64)}`,
          evidence_path: "tests/fixtures/g14-consumer/command-output.txt",
          ot_ids: ["OT-CONSUMER-01", "OT-CONSUMER-02"],
        },
      ],
      coverage: [
        {
          ot_id: "OT-CONSUMER-01",
          status: "passed",
          evidence_paths: ["tests/fixtures/g14-consumer/operational-results.txt"],
          command_ids: ["cmd-consumer-operational"],
        },
        {
          ot_id: "OT-CONSUMER-02",
          status: "passed",
          evidence_paths: ["tests/fixtures/g14-consumer/value-results.txt"],
          command_ids: ["cmd-consumer-operational"],
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
        operational_results: "tests/fixtures/g14-consumer/operational-results.txt",
        value_results: "tests/fixtures/g14-consumer/value-results.txt",
        improvement_feedback: ".ut-tdd/evidence/g14-operational/artifacts/feedback.json",
      },
    }),
  );
  return root;
}

function evaluate(root: string) {
  return evaluateStaticGate({ gate: "G14", repoRoot: root });
}

function expectL0CharterDocTypeIdCitationViolation(messages: readonly string[]): void {
  const valueViolation = messages.find((message) => message.includes("value case OT-CONSUMER-02"));
  expect(valueViolation).toBeDefined();
  expect(valueViolation).toContain("does not cite L0");
  expect(valueViolation).toContain("doc_type_id");
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestTree(root);
});

describe("consumer G14 L0 charter doc_type_id (U-RCDEV-035)", () => {
  it("accepts a cited L0 charter doc_type_id without a PLAN-L0 document", () => {
    const result = evaluate(consumerFixture());
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages).toContain("right-arm-static - OK (G14, cases=2, manifests=1)");
    expect(result.messages.join("\n")).toContain("未判定 (review): PO");
  });

  it("fixture precondition: L0 citation is resolvable and unrelated PLAN references remain valid", () => {
    const root = consumerFixture();
    const charter = readFileSync(join(root, "docs/design/L0-planning/consumer-charter.md"), "utf8");
    const slot = readFileSync(
      join(root, "docs/test-design/L14-operational-test-design.md"),
      "utf8",
    );
    const feedback = JSON.parse(
      readFileSync(join(root, ".ut-tdd/evidence/g14-operational/artifacts/feedback.json"), "utf8"),
    ) as { items: Array<{ routed_to: string }> };
    const manifest = JSON.parse(
      readFileSync(join(root, ".ut-tdd/evidence/g14-operational/ok.json"), "utf8"),
    ) as { plan_id: string };
    expect(charter).toContain("layer: L0");
    expect(charter).toContain("doc_type_id: DOC-L0-CHARTER");
    expect(slot).toContain("BR-01 / DOC-L0-CHARTER");
    expect(existsSync(join(root, "docs/plans/PLAN-L0-01-consumer-charter.md"))).toBe(false);
    expect(manifest.plan_id).toBe("PLAN-CONSUMER-01");
    expect(existsSync(join(root, "docs/plans/PLAN-CONSUMER-01.md"))).toBe(true);
    expect(slot).toContain("plan: docs/plans/PLAN-CONSUMER-01.md");
    expect(feedback.items[0]?.routed_to).toBe("https://github.com/example/consumer/issues/13");
    expect(feedback.items[1]?.routed_to).toBe("https://github.com/example/consumer/issues/12");
  });

  it("rejects a VALUE row without an L0 charter doc_type_id citation", () => {
    const root = consumerFixture();
    const slot = join(root, "docs/test-design/L14-operational-test-design.md");
    writeFileSync(
      slot,
      readFileSync(slot, "utf8").replace("BR-01 / DOC-L0-CHARTER", "BR-01"),
      "utf8",
    );
    expectL0CharterDocTypeIdCitationViolation(evaluate(root).messages);
  });

  it("reports a missing L0 charter source separately from citation policy", () => {
    const root = consumerFixture();
    rmSync(join(root, "docs/design/L0-planning/consumer-charter.md"));
    const messages = evaluate(root).messages;
    expect(messages.join("\n")).toContain("trace target missing DOC-L0-CHARTER");
    expectL0CharterDocTypeIdCitationViolation(messages);
  });

  it("rejects a resolvable non-L0 doc_type_id as a charter citation", () => {
    const root = consumerFixture();
    write(
      root,
      "docs/design/L0-planning/non-l0-charter.md",
      "---\nlayer: L1\ndoc_type_id: DOC-L1-CHARTER\n---\n",
    );
    const slot = join(root, "docs/test-design/L14-operational-test-design.md");
    writeFileSync(
      slot,
      readFileSync(slot, "utf8").replace("DOC-L0-CHARTER", "DOC-L1-CHARTER"),
      "utf8",
    );
    const messages = evaluate(root).messages;
    expect(messages.join("\n")).not.toContain("trace target missing DOC-L1-CHARTER");
    expectL0CharterDocTypeIdCitationViolation(messages);
  });
});
