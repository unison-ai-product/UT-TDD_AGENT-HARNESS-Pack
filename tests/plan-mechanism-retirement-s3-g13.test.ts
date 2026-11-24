import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateStaticGate } from "../src/gate/static.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const roots: string[] = [];

function write(root: string, path: string, value: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, value, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "planret-s3-g13-"));
  roots.push(root);
  write(
    root,
    "docs/test-design/harness/L12-acceptance-test-design.md",
    "---\ndoc_type_id: DOC-L12-ACCEPTANCE\nlayer: L12\nstatus: confirmed\n---\n\n| AT-ID | 対応 AC | 受入条件 | 機械検証 |\n| --- | --- | --- | --- |\n| **AT-FR-01-01** | AC-FR-01-01 | fixture acceptance case | static gate fixture |\n",
  );
  const design = [
    "---",
    "doc_type_id: DOC-L13-PRODUCTION-OBSERVATION",
    "layer: L13",
    "status: confirmed",
    "---",
    "",
    "# DOC-L13-PRODUCTION-OBSERVATION: 運用設計書 (監視・後検証節) / ログ・トレース設計書",
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
    "#### 第1章 ログ方針",
    "#### 第2章 ログ種別一覧",
    "#### 第3章 共通ログ項目",
    "#### 第4章 ログレベル方針",
    "#### 第5章 構造化フォーマット",
    "#### 第6章 分散トレース設計",
    "#### 第7章 保管・マスキング",
    "#### 第8章 監視連携",
    "",
    "### harness 追補: G13 検証ケース",
    "",
    "| ケースID | 観測内容 | 合否基準 | トレース元 |",
    "| --- | --- | --- | --- |",
    "| SMOKE-PLANRET-01 | deploy smoke | exit 0 | AT-FR-01-01 |",
    "",
  ].join("\n");
  write(root, "docs/process/evidence/g13-post-deploy-verification-design.md", design);
  write(root, "tests/fixtures/planret-g13/smoke.txt", "passed\n");
  write(root, "tests/fixtures/planret-g13/command.txt", "passed\n");
  write(
    root,
    ".ut-tdd/evidence/g13-post-deploy/artifacts/sli-slo.json",
    json({
      window_start: "2026-11-04T00:00:00Z",
      window_end: "2026-11-04T01:00:00Z",
      slos: [{ slo_id: "SLO-AVAIL", target: "99.9%", observed: 99.95 }],
    }),
  );
  write(
    root,
    ".ut-tdd/evidence/g13-post-deploy/artifacts/rollback.json",
    json({ decision: "keep" }),
  );
  write(
    root,
    ".ut-tdd/evidence/g13-post-deploy/ok.json",
    json({
      schema_version: "g13-post-deploy-evidence-v1",
      gate: "G13",
      profile: "consumer-post-deploy-minimum",
      plan_id: "PLAN-CONSUMER-01",
      selected_smoke_ids: ["SMOKE-PLANRET-01"],
      mandatory_smoke_ids: [],
      deferred_smoke_ids: ["SMOKE-PLANRET-01"],
      commands: [
        {
          command_id: "cmd-planret-g13",
          command: "node smoke-check.mjs",
          runner: "node",
          scope: "fixture",
          exit_code: 0,
          evidence_path: "tests/fixtures/planret-g13/command.txt",
          output_digest: `sha256:${"a".repeat(64)}`,
          smoke_ids: ["SMOKE-PLANRET-01"],
        },
      ],
      coverage: [],
      defer: [
        {
          smoke_id: "SMOKE-PLANRET-01",
          reason: "verification is deferred",
          issue: "https://github.com/example/repo/issues/12",
        },
      ],
      exit_criteria: {
        all_mandatory_passed: true,
        failed_mandatory_count: 0,
        stale_defer_count: 0,
        doctor_check: "g13-post-deploy-workflow",
      },
      artifacts: {
        production_smoke: "tests/fixtures/planret-g13/smoke.txt",
        sli_slo_observation: ".ut-tdd/evidence/g13-post-deploy/artifacts/sli-slo.json",
        rollback_decision: ".ut-tdd/evidence/g13-post-deploy/artifacts/rollback.json",
      },
    }),
  );
  return root;
}

function updateDefer(root: string, defer: Record<string, string>): void {
  const path = join(root, ".ut-tdd/evidence/g13-post-deploy/ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { defer: Record<string, string>[] };
  manifest.defer = [defer];
  writeFileSync(path, json(manifest), "utf8");
}

function makeSmokeMandatory(root: string): void {
  const path = join(root, ".ut-tdd/evidence/g13-post-deploy/ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    mandatory_smoke_ids: string[];
    deferred_smoke_ids: string[];
    coverage: {
      smoke_id: string;
      status: string;
      evidence_paths: string[];
      command_ids: string[];
    }[];
    defer: Record<string, string>[];
  };
  manifest.mandatory_smoke_ids = ["SMOKE-PLANRET-01"];
  manifest.deferred_smoke_ids = [];
  manifest.coverage = [
    {
      smoke_id: "SMOKE-PLANRET-01",
      status: "passed",
      evidence_paths: ["tests/fixtures/planret-g13/smoke.txt"],
      command_ids: ["cmd-planret-g13"],
    },
  ];
  manifest.defer = [];
  writeFileSync(path, json(manifest), "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestTree(root);
});

describe("CANDIDATE-U-PLANRET-002 right-arm G13 evidence", () => {
  it("precondition: G13 fixture passes with a completed mandatory smoke case", () => {
    const root = fixture();
    makeSmokeMandatory(root);
    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });

    expect(result.passed, result.messages.join("\n")).toBe(true);
  });

  it("accepts a defer reason paired with an Issue URL", () => {
    const root = fixture();
    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });

    expect(result.passed).toBe(true);
  });

  it("rejects legacy plan_id when docs/plans lacks PLAN-L9-1-x", () => {
    const root = fixture();
    updateDefer(root, {
      smoke_id: "SMOKE-PLANRET-01",
      reason: "verification is deferred",
      plan_id: "PLAN-L9-1-x",
    });
    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });

    expect(result.messages.join("\n")).toContain("stale defer SMOKE-PLANRET-01");
  });

  it("rejects a malformed Issue URL as a stale defer", () => {
    const root = fixture();
    updateDefer(root, {
      smoke_id: "SMOKE-PLANRET-01",
      reason: "verification is deferred",
      issue: "#12",
    });
    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });

    expect(result.messages.join("\n")).toContain("stale defer SMOKE-PLANRET-01");
  });
});
