// PLAN-REVERSE-40 塊A: impl→PLAN トレーサビリティ検査 (IMP-088)。
// src module/CLI/lint/doctor check が PLAN generates に紐づくか。NEW orphan を fail-close。
// 既存 untraced 8 件は baseline (known-debt)、IMP-087 の 4 件は REVERSE-40 へ back-fill 済。
import { describe, expect, it } from "vitest";
import {
  analyzeImplPlanTrace,
  IMPL_PLAN_TRACE_BASELINE,
  loadImplPlanTraceInput,
} from "../src/lint/impl-plan-trace";

describe("analyzeImplPlanTrace (U-IPT-001..003)", () => {
  const base = {
    tracedPaths: new Set(["src/cli.ts"]),
    baseline: new Set(["src/lint/shared.ts"]),
  };

  it("U-IPT-001: traced でも baseline でもない src は orphan (NEW orphan fail-close)", () => {
    const r = analyzeImplPlanTrace({ srcFiles: ["src/new/feature.ts"], ...base });
    expect(r.orphans).toContain("src/new/feature.ts");
    expect(r.ok).toBe(false);
  });

  it("U-IPT-002: PLAN generates に traced な src は orphan でない", () => {
    const r = analyzeImplPlanTrace({ srcFiles: ["src/cli.ts"], ...base });
    expect(r.orphans).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("U-IPT-003: baseline 済 src は orphan でない (known-debt)", () => {
    const r = analyzeImplPlanTrace({ srcFiles: ["src/lint/shared.ts"], ...base });
    expect(r.orphans).toHaveLength(0);
  });
});

describe("loadImplPlanTraceInput real repo (U-IPT-004/005)", () => {
  it("U-IPT-004: 実 repo の orphan は 0 (4 back-fill + 8 baseline 適用後、fail-close 回帰網)", () => {
    const r = analyzeImplPlanTrace(loadImplPlanTraceInput(process.cwd()));
    expect(r.orphans).toEqual([]);
  });

  it("U-IPT-005: baseline は 8 件 (IMP-087 の 4 は back-fill で trace = baseline に含めない)", () => {
    expect(IMPL_PLAN_TRACE_BASELINE.size).toBe(8);
    // IMP-087 orphan は baseline でなく back-fill (trace) で解消
    expect(IMPL_PLAN_TRACE_BASELINE.has("src/lint/rule-drift.ts")).toBe(false);
    expect(IMPL_PLAN_TRACE_BASELINE.has("src/gate/review-tier.ts")).toBe(false);
  });
});
