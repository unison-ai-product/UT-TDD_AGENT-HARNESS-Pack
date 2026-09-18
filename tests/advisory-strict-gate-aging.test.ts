import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADVISORY_GATE_AGING_THRESHOLD_DAYS,
  ADVISORY_STRICT_GATES,
  type AdvisoryStrictGate,
  advisoryGateAgingMessages,
  analyzeAdvisoryGateAging,
  checkAdvisoryGateAging,
  HARNESS_CHECK_WORKFLOW_RELATIVE_PATH,
  promotedGateWorkflowDriftMessages,
  readHarnessCheckWorkflowContent,
  verifyPromotedGatesAgainstWorkflow,
} from "../src/lint/advisory-strict-gate-aging.ts";

// PLAN-L7-420 Step 3: doctor 自身が「strict 化待ちのまま放置されている advisory gate」を検出する
// meta check。green-command-digest (PLAN-L7-132) が opt-in strict のまま CI に投入されず、
// fake/stale digest が 30->44->49 件と再蓄積した (G-1) の再発防止。coding != substance の機械代替
// として、fixture gate を使った real-repo regression 相当のテストで検出動作を実証する。

function gate(overrides: Partial<AdvisoryStrictGate> = {}): AdvisoryStrictGate {
  return {
    id: "fixture-gate",
    introducedOn: "2026-01-01",
    strictFlag: "--strict-fixture-gate",
    promotedInCi: false,
    planRef: "PLAN-FIXTURE",
    description: "fixture advisory gate",
    ...overrides,
  };
}

describe("analyzeAdvisoryGateAging (PLAN-L7-420 Step 3) — advisory gate 放置検出", () => {
  it("導入から閾値日数以内なら検出しない", () => {
    const now = new Date("2026-07-21T00:00:00Z");
    const findings = analyzeAdvisoryGateAging([gate({ introducedOn: "2026-06-29" })], { now });
    expect(findings).toHaveLength(0);
  });

  it("導入から閾値日数を超えると warn 対象として検出する (coding != substance の実測代替)", () => {
    const now = new Date("2026-07-21T00:00:00Z");
    // introducedOn を十分に古く設定し、閾値超過を機械的に発火させる。
    const findings = analyzeAdvisoryGateAging(
      [gate({ id: "old-gate", introducedOn: "2026-01-01", planRef: "PLAN-OLD" })],
      { now, thresholdDays: 60 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("old-gate");
    expect(findings[0]?.ageDays).toBeGreaterThan(60);
    expect(findings[0]?.planRef).toBe("PLAN-OLD");
  });

  it("CI へ strict 投入済み (promotedInCi=true) の gate は放置日数に関わらず対象外", () => {
    const now = new Date("2026-07-21T00:00:00Z");
    const findings = analyzeAdvisoryGateAging(
      [gate({ id: "promoted-gate", introducedOn: "2020-01-01", promotedInCi: true })],
      { now, thresholdDays: 60 },
    );
    expect(findings).toHaveLength(0);
  });

  it("閾値ちょうどでは超過扱いにしない (境界値、> であって >= でない)", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const findings = analyzeAdvisoryGateAging([gate({ introducedOn: "2025-11-02" })], {
      now,
      thresholdDays: 60,
    });
    // 2025-11-02 -> 2026-01-01 は 60 日ちょうど。
    expect(findings).toHaveLength(0);
  });

  it("実データ (ADVISORY_STRICT_GATES): green-command-digest は PLAN-L7-420 Step 2 で CI 昇格済み、対象外", () => {
    const gcd = ADVISORY_STRICT_GATES.find((g) => g.id === "green-command-digest");
    expect(gcd?.promotedInCi).toBe(true);
    const findings = analyzeAdvisoryGateAging(ADVISORY_STRICT_GATES, {
      now: new Date("2030-01-01T00:00:00Z"),
    });
    expect(findings.map((f) => f.id)).not.toContain("green-command-digest");
  });
});

describe("advisoryGateAgingMessages — doctor note レンダリング", () => {
  it("放置ゼロなら OK 行", () => {
    expect(advisoryGateAgingMessages([])).toEqual([
      "advisory-strict-gate-aging — OK (CI 未昇格の advisory gate はいずれも閾値内)",
    ]);
  });

  it("放置ありなら warn 行に id / 経過日数 / strictFlag / planRef を含める", () => {
    const messages = advisoryGateAgingMessages([
      {
        id: "old-gate",
        ageDays: 90,
        thresholdDays: 60,
        strictFlag: "--strict-old",
        planRef: "PLAN-OLD",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("advisory-strict-gate-aging — warn");
    expect(messages[0]).toContain("old-gate");
    expect(messages[0]).toContain("90d");
    expect(messages[0]).toContain("--strict-old");
    expect(messages[0]).toContain("PLAN-OLD");
  });
});

describe("checkAdvisoryGateAging — doctor wrapper (non-blocking)", () => {
  it("放置が閾値を超えても ok=true を維持する (可視化のみ、doctor を落とさない)", () => {
    const result = checkAdvisoryGateAging({
      now: new Date("2030-01-01T00:00:00Z"),
      thresholdDays: ADVISORY_GATE_AGING_THRESHOLD_DAYS,
      gates: [gate({ id: "stale-gate", introducedOn: "2020-01-01" })],
    });
    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("stale-gate");
  });

  it("既定 (引数なし) は実 ADVISORY_STRICT_GATES レジストリを使い、常に ok=true", () => {
    const result = checkAdvisoryGateAging();
    expect(result.ok).toBe(true);
    expect(result.messages).toHaveLength(1);
  });
});

// blind review (gpt-5.6-sol) Finding 4 是正 (2026-07-21): promotedInCi は手動 boolean のままだと、
// workflow から strict flag が消えても検出できない (registry と実 CI 設定の乖離が不可視)。
// verifyPromotedGatesAgainstWorkflow / checkAdvisoryGateAging の workflow 突き合わせを固定する。
describe("verifyPromotedGatesAgainstWorkflow — promotedInCi の workflow 実在検証 (Finding 4)", () => {
  it("promotedInCi=true だが workflow に strictFlag が無ければ CI 未昇格へ降格し drift を報告する", () => {
    const promoted = gate({
      id: "vanished-gate",
      strictFlag: "--strict-vanished",
      promotedInCi: true,
    });
    const { adjustedGates, driftFindings } = verifyPromotedGatesAgainstWorkflow(
      [promoted],
      "jobs:\n  doctor:\n    run: bun src/cli.ts doctor --scope toolchain\n",
    );
    expect(adjustedGates).toHaveLength(1);
    expect(adjustedGates[0]?.promotedInCi).toBe(false);
    expect(driftFindings).toHaveLength(1);
    expect(driftFindings[0]?.id).toBe("vanished-gate");
    expect(driftFindings[0]?.strictFlag).toBe("--strict-vanished");
  });

  it("promotedInCi=true かつ workflow に strictFlag が実在すれば降格せず drift も出さない", () => {
    const promoted = gate({
      id: "present-gate",
      strictFlag: "--strict-present",
      promotedInCi: true,
    });
    const { adjustedGates, driftFindings } = verifyPromotedGatesAgainstWorkflow(
      [promoted],
      "run: bun src/cli.ts doctor --strict-present\n",
    );
    expect(adjustedGates).toHaveLength(1);
    expect(adjustedGates[0]?.promotedInCi).toBe(true);
    expect(driftFindings).toHaveLength(0);
  });

  it("promotedInCi=false の gate は workflow の内容にかかわらず検証対象外", () => {
    const notPromoted = gate({ id: "advisory-gate", promotedInCi: false });
    const { adjustedGates, driftFindings } = verifyPromotedGatesAgainstWorkflow(
      [notPromoted],
      "run: bun src/cli.ts doctor\n",
    );
    expect(adjustedGates[0]?.promotedInCi).toBe(false);
    expect(driftFindings).toHaveLength(0);
  });

  it("workflowContent が null (読めない) なら fail-open でレジストリ値をそのまま信頼する", () => {
    const promoted = gate({ id: "unverifiable-gate", promotedInCi: true });
    const { adjustedGates, driftFindings } = verifyPromotedGatesAgainstWorkflow([promoted], null);
    expect(adjustedGates[0]?.promotedInCi).toBe(true);
    expect(driftFindings).toHaveLength(0);
  });

  it("コメント内にのみ flag 名が残る workflow は昇格扱いにしない (blind review 反例の負例固定)", () => {
    const promoted = gate({
      id: "comment-only-gate",
      strictFlag: "--strict-comment-only",
      promotedInCi: true,
    });
    const { adjustedGates, driftFindings } = verifyPromotedGatesAgainstWorkflow(
      [promoted],
      "# promoted with --strict-comment-only\nrun: bun src/cli.ts doctor\n",
    );
    expect(adjustedGates[0]?.promotedInCi).toBe(false);
    expect(driftFindings).toHaveLength(1);
    expect(driftFindings[0]?.strictFlag).toBe("--strict-comment-only");
  });

  it("run 行に flag が実在すれば同一 workflow にコメント言及があっても昇格のまま", () => {
    const promoted = gate({
      id: "run-and-comment-gate",
      strictFlag: "--strict-real",
      promotedInCi: true,
    });
    const { adjustedGates, driftFindings } = verifyPromotedGatesAgainstWorkflow(
      [promoted],
      "# uses --strict-real below\nrun: bun src/cli.ts doctor --strict-real\n",
    );
    expect(adjustedGates[0]?.promotedInCi).toBe(true);
    expect(driftFindings).toHaveLength(0);
  });
});

describe("promotedGateWorkflowDriftMessages — drift 専用 warn 行", () => {
  it("registry says promoted but flag missing from workflow の文言と id/flag/planRef を含む", () => {
    const messages = promotedGateWorkflowDriftMessages([
      { id: "vanished-gate", strictFlag: "--strict-vanished", planRef: "PLAN-FIXTURE" },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("registry says promoted but flag missing from workflow");
    expect(messages[0]).toContain("vanished-gate");
    expect(messages[0]).toContain("--strict-vanished");
    expect(messages[0]).toContain("PLAN-FIXTURE");
  });
});

describe("checkAdvisoryGateAging — workflow 突き合わせ配線 (repoRoot / workflowContent 注入)", () => {
  it("strict flag が workflow から消えた promoted gate は降格され、閾値超過なら aging 警告に現れる", () => {
    const result = checkAdvisoryGateAging({
      now: new Date("2030-01-01T00:00:00Z"),
      thresholdDays: ADVISORY_GATE_AGING_THRESHOLD_DAYS,
      gates: [
        gate({
          id: "regressed-gate",
          introducedOn: "2020-01-01",
          strictFlag: "--strict-regressed",
          promotedInCi: true,
        }),
      ],
      workflowContent: "run: bun src/cli.ts doctor --scope toolchain\n",
    });
    expect(result.ok).toBe(true);
    const joined = result.messages.join(" | ");
    expect(joined).toContain("regressed-gate");
    expect(joined).toContain("registry says promoted but flag missing from workflow");
  });

  it("strict flag が workflow に実在する promoted gate は降格されず対象外のまま", () => {
    const result = checkAdvisoryGateAging({
      now: new Date("2030-01-01T00:00:00Z"),
      thresholdDays: ADVISORY_GATE_AGING_THRESHOLD_DAYS,
      gates: [
        gate({
          id: "still-promoted-gate",
          introducedOn: "2020-01-01",
          strictFlag: "--strict-still-promoted",
          promotedInCi: true,
        }),
      ],
      workflowContent: "run: bun src/cli.ts doctor --strict-still-promoted\n",
    });
    const joined = result.messages.join(" | ");
    expect(joined).not.toContain("still-promoted-gate");
    expect(result.ok).toBe(true);
  });

  it("repoRoot が読めない場合は fail-open note を出し、registry 値をそのまま信頼する", () => {
    const result = checkAdvisoryGateAging({
      now: new Date("2030-01-01T00:00:00Z"),
      gates: [gate({ id: "trusted-gate", promotedInCi: true })],
      repoRoot: join(process.cwd(), "does-not-exist-fixture-dir"),
    });
    expect(result.ok).toBe(true);
    const joined = result.messages.join(" | ");
    expect(joined).toContain("workflow content could not be read");
    expect(joined).not.toContain("trusted-gate");
  });

  it("repoRoot / workflowContent 未指定なら従来どおり無検証 (fs アクセスも drift note も無い)", () => {
    const result = checkAdvisoryGateAging({
      now: new Date("2030-01-01T00:00:00Z"),
      gates: [gate({ id: "unverified-gate", promotedInCi: true, introducedOn: "2020-01-01" })],
    });
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([
      "advisory-strict-gate-aging — OK (CI 未昇格の advisory gate はいずれも閾値内)",
    ]);
  });

  it("real fixture: 実 repo の harness-check.yml で green-command-digest の strict flag が実在する", () => {
    const workflowContent = readHarnessCheckWorkflowContent(process.cwd());
    expect(workflowContent).not.toBeNull();
    expect(workflowContent).toContain("--strict-green-command-digest");

    const result = checkAdvisoryGateAging({
      now: new Date("2030-01-01T00:00:00Z"),
      workflowContent,
    });
    const joined = result.messages.join(" | ");
    expect(joined).not.toContain("green-command-digest registry says promoted but flag missing");
  });

  it("real fixture: readHarnessCheckWorkflowContent は実際の workflow パスから読める", () => {
    const viaHelper = readHarnessCheckWorkflowContent(process.cwd());
    const viaDirectRead = readFileSync(
      join(process.cwd(), HARNESS_CHECK_WORKFLOW_RELATIVE_PATH),
      "utf8",
    );
    expect(viaHelper).toBe(viaDirectRead);
  });
});
