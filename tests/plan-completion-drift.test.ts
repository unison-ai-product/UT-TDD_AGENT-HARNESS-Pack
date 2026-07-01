import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlanCompletionDrift } from "../src/doctor/index";
import {
  analyzePlanCompletionDrift,
  dodChecklistState,
  loadPlanCompletionDriftInput,
} from "../src/lint/plan-completion-drift";

// PLAN-L7-93: 「DoD 全消化なのに status 非終端」= 完了 bookkeeping drift を機械検出する gate の回帰。
// 動機 = PLAN-RECOVERY-02 が freeze-ready (全 phase 完了 + gated downstream 全 confirmed) なのに
// status=draft 放置で毎 session 再報告された運用ミス (PO 2026-06-22)。

describe("dodChecklistState", () => {
  it("全チェック済 → checked のみ", () => {
    const md = "## §7 DoD\n\n- [x] S1\n- [x] S2\n";
    expect(dodChecklistState(md)).toEqual({ checked: 2, unchecked: 0 });
  });

  it("部分チェック → checked + unchecked", () => {
    const md = "## §7 DoD\n\n- [x] S1\n- [ ] S2\n- [ ] S3\n";
    expect(dodChecklistState(md)).toEqual({ checked: 1, unchecked: 2 });
  });

  it("DoD 節が無い → 0/0", () => {
    expect(dodChecklistState("## §1 設計\n\n本文だけ。\n")).toEqual({ checked: 0, unchecked: 0 });
  });

  it("日本語『完了条件』見出しも認識する", () => {
    expect(dodChecklistState("## 完了条件\n\n- [x] 済\n")).toEqual({ checked: 1, unchecked: 0 });
  });

  it("次の ## 見出しで節を打ち切る (節外のチェックは数えない)", () => {
    const md = "## §7 DoD\n\n- [x] done\n\n## §8 carry\n\n- [ ] 別節の項目\n";
    expect(dodChecklistState(md)).toEqual({ checked: 1, unchecked: 0 });
  });

  it("CRLF でも数える", () => {
    const md = ["## §7 DoD", "", "- [x] a", "- [ ] b"].join("\r\n");
    expect(dodChecklistState(md)).toEqual({ checked: 1, unchecked: 1 });
  });
});

describe("analyzePlanCompletionDrift", () => {
  it("DoD 全消化 + 非終端 → violation", () => {
    const r = analyzePlanCompletionDrift([
      { planId: "PLAN-RECOVERY-02", status: "draft", checkedItems: 5, uncheckedItems: 0 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.planId)).toEqual(["PLAN-RECOVERY-02"]);
  });

  it("DoD 全消化 + 終端 (completed) → ok (整合)", () => {
    const r = analyzePlanCompletionDrift([
      { planId: "PLAN-A", status: "completed", checkedItems: 5, uncheckedItems: 0 },
    ]);
    expect(r.ok).toBe(true);
  });

  it("DoD 部分チェック + draft → ok (真に作業中の WIP は素通り)", () => {
    const r = analyzePlanCompletionDrift([
      { planId: "PLAN-DISCOVERY-03", status: "draft", checkedItems: 1, uncheckedItems: 3 },
    ]);
    expect(r.ok).toBe(true);
  });

  it("DoD チェックリスト項目ゼロ + draft → ok (シグナル無し、過剰検出しない)", () => {
    const r = analyzePlanCompletionDrift([
      { planId: "PLAN-NODOD", status: "draft", checkedItems: 0, uncheckedItems: 0 },
    ]);
    expect(r.ok).toBe(true);
  });

  it("confirmed/accepted も終端として通す", () => {
    const r = analyzePlanCompletionDrift([
      { planId: "PLAN-C", status: "confirmed", checkedItems: 2, uncheckedItems: 0 },
      { planId: "PLAN-D", status: "accepted", checkedItems: 2, uncheckedItems: 0 },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("loadPlanCompletionDriftInput + checkPlanCompletionDrift", () => {
  function writePlan(root: string, name: string, status: string, kind: string, body: string): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/\.md$/, "")}`,
        `status: ${status}`,
        `kind: ${kind}`,
        "---",
        "",
        `# ${name.replace(/\.md$/, "")}`,
        "",
        body,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("RECOVERY-02 型 (recovery / draft / DoD 全消化) を flag し、completed 版は通す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-completion-drift-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      // freeze-ready なのに draft 放置 (= 検出対象の運用ミス)
      writePlan(
        root,
        "PLAN-TEST-93-stuck.md",
        "draft",
        "recovery",
        "## §7 DoD\n\n- [x] Phase 1\n- [x] Phase 2\n- [x] freeze 完了",
      );
      // 同形で status だけ前進済 (= 整合、検出しない)
      writePlan(
        root,
        "PLAN-TEST-93-clean.md",
        "completed",
        "recovery",
        "## §7 DoD\n\n- [x] Phase 1\n- [x] Phase 2",
      );
      // 真に作業中 (= 素通り、false positive を出さない)
      writePlan(
        root,
        "PLAN-TEST-93-wip.md",
        "draft",
        "poc",
        "## §7 DoD\n\n- [x] S1\n- [ ] S2\n- [ ] S3",
      );

      const result = checkPlanCompletionDrift(root);
      expect(result.ok).toBe(false);
      const joined = result.messages.join("\n");
      expect(joined).toContain("PLAN-TEST-93-stuck");
      expect(joined).not.toContain("PLAN-TEST-93-clean");
      expect(joined).not.toContain("PLAN-TEST-93-wip");

      const rows = loadPlanCompletionDriftInput(root);
      const stuck = rows.find((r) => r.planId === "PLAN-TEST-93-stuck");
      expect(stuck).toMatchObject({ checkedItems: 3, uncheckedItems: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archived は対象外 (完了後の整理)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-completion-drift-arch-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writePlan(root, "PLAN-TEST-93-arch.md", "archived", "recovery", "## §7 DoD\n\n- [x] done");
      expect(checkPlanCompletionDrift(root).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when repo root cannot be read", () => {
    expect(checkPlanCompletionDrift(join(tmpdir(), "ut-tdd-completion-drift-nope-zzz")).ok).toBe(
      false,
    );
  });
});
