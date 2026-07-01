import { describe, expect, it } from "vitest";
import {
  analyzeForwardConvergence,
  analyzeLegacyAuditDrift,
  type ConvergencePlan,
  FORWARD_CONVERGENCE_LEGACY_DEBT,
  forwardConvergenceMessages,
  hasLocalImplOnlyDisposition,
  isLanded,
  isSpineConnected,
  isValidVersionUp,
  parseConvergencePlan,
  parseLegacyAuditPlanIds,
  partitionConvergenceDebt,
} from "../src/lint/forward-convergence";

function plan(overrides: Partial<ConvergencePlan> = {}): ConvergencePlan {
  return {
    plan_id: "PLAN-L7-900-x",
    kind: "impl",
    status: "confirmed",
    parentDesign: null,
    requires: [],
    backpropDecision: "",
    backpropDecisionReason: "",
    versionTarget: null,
    ...overrides,
  };
}

// IMP-146 で実 allowlist は空 (baseline 2 件解消済) ゆえ、grandfather/drift 機構は合成 allowlist を
// 注入してテストする (機構テストを「実 baseline に件数があるか」から分離 = 解消後も機構を被覆)。
const SYNTH_LEGACY = "PLAN-L7-SYNTH-legacy-debt";
const SYNTH_ALLOWLIST = new Set([SYNTH_LEGACY]);

describe("forward-convergence: spine 接続判定", () => {
  it("roadmap span 登録は spine-internal", () => {
    const p = plan({ plan_id: "PLAN-L7-44-a" });
    expect(isSpineConnected(p, new Set(["PLAN-L7-44-a"]))).toBe(true);
  });

  it("parent_design が docs/design 配下なら spine-internal", () => {
    const p = plan({ parentDesign: "docs/design/harness/L6-function/function-spec.md" });
    expect(isSpineConnected(p, new Set())).toBe(true);
  });

  it("requires が上流設計 PLAN (L1-L6) を指せば spine-internal", () => {
    const p = plan({ requires: ["PLAN-L6-10-vmodel-lint"] });
    expect(isSpineConnected(p, new Set())).toBe(true);
  });

  it("どの接続も無ければ spine-外", () => {
    const p = plan({ requires: ["PLAN-L7-03-setup-solo-team"] });
    expect(isSpineConnected(p, new Set())).toBe(false);
  });

  it("parent_design が docs/process / docs/adr は spine-外 (Codex Important: 境界回帰防止)", () => {
    // 規範/プロセス/ADR 由来は L6 設計 / L1-L6 Forward PLAN への降下ではない = spine-外。
    expect(
      isSpineConnected(plan({ parentDesign: "docs/process/modes/refactor.md" }), new Set()),
    ).toBe(false);
    expect(
      isSpineConnected(
        plan({ parentDesign: "docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md" }),
        new Set(),
      ),
    ).toBe(false);
  });
});

describe("forward-convergence: landed / disposition", () => {
  it("confirmed/completed は landed、draft は非 landed", () => {
    expect(isLanded(plan({ status: "confirmed" }))).toBe(true);
    expect(isLanded(plan({ status: "completed" }))).toBe(true);
    expect(isLanded(plan({ status: "draft" }))).toBe(false);
  });

  it("not_required は理由必須 (空 prose は免除にしない)", () => {
    expect(
      hasLocalImplOnlyDisposition(
        plan({ backpropDecision: "not_required", backpropDecisionReason: "" }),
      ),
    ).toBe(false);
    expect(
      hasLocalImplOnlyDisposition(
        plan({
          backpropDecision: "not_required",
          backpropDecisionReason: "upstream 不変のためローカル完結",
        }),
      ),
    ).toBe(true);
    expect(hasLocalImplOnlyDisposition(plan({ backpropDecision: "local_impl_only" }))).toBe(true);
  });
});

describe("forward-convergence: 分類", () => {
  it("landed × spine-外 × 未集約 = unconverged-landed (違反候補)", () => {
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-999-orphan" })],
      new Set(),
      new Set(),
    );
    expect(r.unconvergedLanded).toEqual(["PLAN-L7-999-orphan"]);
    expect(r.ok).toBe(false);
  });

  it("draft/deferred は違反にしない (将来作業 = draft-deferred)", () => {
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-157-distribution-clean-pull", status: "draft" })],
      new Set(),
      new Set(),
    );
    expect(r.unconvergedLanded).toEqual([]);
    expect(r.draftDeferred).toEqual(["PLAN-L7-157-distribution-clean-pull"]);
    expect(r.ok).toBe(true);
  });

  it("spine 接続済 landed impl は flag しない (false-positive 非発火)", () => {
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-44-a" })],
      new Set(["PLAN-L7-44-a"]),
      new Set(),
    );
    expect(r.unconvergedLanded).toEqual([]);
    expect(r.spineInternal).toEqual(["PLAN-L7-44-a"]);
  });

  it("Reverse 参照済 landed は converged", () => {
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-500-merged" })],
      new Set(),
      new Set(["PLAN-L7-500-merged"]),
    );
    expect(r.converged).toEqual(["PLAN-L7-500-merged"]);
    expect(r.ok).toBe(true);
  });

  it("local_impl_only disposition は local-impl-only", () => {
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-501-local", backpropDecision: "local_impl_only" })],
      new Set(),
      new Set(),
    );
    expect(r.localImplOnly).toEqual(["PLAN-L7-501-local"]);
    expect(r.ok).toBe(true);
  });

  it("scope 外 kind (poc 等) は対象外 = scrum-reverse の SSoT に委ねる", () => {
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-DISCOVERY-08-x", kind: "poc", status: "confirmed" })],
      new Set(),
      new Set(),
    );
    expect(r.classifications).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("forward-convergence: parse + messages", () => {
  it("parseConvergencePlan が frontmatter を抽出", () => {
    const content = [
      "---",
      "plan_id: PLAN-L7-700-y",
      "kind: impl",
      "status: confirmed",
      "parent_design: docs/design/harness/L6-function/function-spec.md",
      "backprop_decision: local_impl_only",
      "dependencies:",
      "  requires:",
      "    - PLAN-L6-10-vmodel-lint",
      "---",
      "# body",
    ].join("\n");
    const p = parseConvergencePlan("PLAN-L7-700-y.md", content);
    expect(p.plan_id).toBe("PLAN-L7-700-y");
    expect(p.kind).toBe("impl");
    expect(p.parentDesign).toBe("docs/design/harness/L6-function/function-spec.md");
    expect(p.requires).toContain("PLAN-L6-10-vmodel-lint");
    expect(p.backpropDecision).toBe("local_impl_only");
  });

  it("messages: ok は OK 文言、violation は NEW 件数 + ids", () => {
    const okMsg = forwardConvergenceMessages(analyzeForwardConvergence([], new Set(), new Set()));
    expect(okMsg[0]).toContain("forward-convergence — OK");

    const badMsg = forwardConvergenceMessages(
      analyzeForwardConvergence([plan({ plan_id: "PLAN-L7-999-orphan" })], new Set(), new Set()),
    );
    expect(badMsg[0]).toContain("violation");
    expect(badMsg[0]).toContain("NEW 未集約 landed impl 1 件");
    expect(badMsg[0]).toContain("PLAN-L7-999-orphan");
  });
});

describe("forward-convergence: fail-close (legacy grandfather + NEW gate)", () => {
  it("partitionConvergenceDebt: legacy は grandfather、NEW は fail-close 対象へ分割 (機構、synth allowlist)", () => {
    const split = partitionConvergenceDebt([SYNTH_LEGACY, "PLAN-L7-999-orphan"], SYNTH_ALLOWLIST);
    expect(split.legacyDebt).toEqual([SYNTH_LEGACY]);
    expect(split.newViolations).toEqual(["PLAN-L7-999-orphan"]);
  });

  it("legacy のみ (synth allowlist) なら NEW 違反 0 = ok を落とさない grandfather", () => {
    const split = partitionConvergenceDebt([SYNTH_LEGACY], SYNTH_ALLOWLIST);
    expect(split.legacyDebt).toEqual([SYNTH_LEGACY]);
    expect(split.newViolations).toEqual([]);
  });

  it("NEW 違反は analyzeForwardConvergence で fail-close (ok=false)", () => {
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-999-orphan" })],
      new Set(),
      new Set(),
    );
    expect(r.newViolations).toEqual(["PLAN-L7-999-orphan"]);
    expect(r.ok).toBe(false);
  });

  it("IMP-146 解消済: 実 allowlist は空 (= grandfather 残債務 0、synth id も NEW 違反化)", () => {
    // baseline 2 件 (L7-62 trace correction / L7-147 Reverse converged) を解消し allowlist 空化。
    expect(FORWARD_CONVERGENCE_LEGACY_DEBT.size).toBe(0);
    // 実 allowlist (default 引数) では合成 legacy id も grandfather されず NEW 違反 = fail-close。
    const split = partitionConvergenceDebt([SYNTH_LEGACY]);
    expect(split.legacyDebt).toEqual([]);
    expect(split.newViolations).toEqual([SYNTH_LEGACY]);
    const r = analyzeForwardConvergence([plan({ plan_id: SYNTH_LEGACY })], new Set(), new Set());
    expect(r.legacyDebt).toEqual([]);
    expect(r.newViolations).toEqual([SYNTH_LEGACY]);
    expect(r.ok).toBe(false);
  });
});

describe("forward-convergence: version-up parked (Codex Critical guards)", () => {
  it("draft + ledger label = version-up parked (draft-deferred でない)", () => {
    expect(isValidVersionUp(plan({ status: "draft", versionTarget: "future" }))).toBe(true);
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-141-x", status: "draft", versionTarget: "future" })],
      new Set(),
      new Set(),
    );
    expect(r.versionUpParked).toEqual(["PLAN-L7-141-x"]);
    expect(r.draftDeferred).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("landed + version_target は version-up と認めない (landing-time 除外禁止)", () => {
    expect(isValidVersionUp(plan({ status: "confirmed", versionTarget: "future" }))).toBe(false);
    const r = analyzeForwardConvergence(
      [plan({ plan_id: "PLAN-L7-998-x", status: "confirmed", versionTarget: "future" })],
      new Set(),
      new Set(),
    );
    expect(r.versionUpParked).toEqual([]);
    expect(r.unconvergedLanded).toEqual(["PLAN-L7-998-x"]);
  });

  it("ledger 外 label は version-up parked にしない", () => {
    expect(isValidVersionUp(plan({ status: "draft", versionTarget: "whenever" }))).toBe(false);
  });
});

describe("forward-convergence: legacy audit drift (allowlist ↔ audit doc)", () => {
  it("allowlist と audit doc が一致なら ok (合成 allowlist)", () => {
    expect(analyzeLegacyAuditDrift(new Set([SYNTH_LEGACY]), SYNTH_ALLOWLIST).ok).toBe(true);
  });

  it("実 allowlist (IMP-146 後=空) は audit doc 表行も空で一致 = ok", () => {
    // 実 allowlist 空 × audit 表行空 → 双方向一致 (loadLegacyAuditDrift と同経路)。
    expect(analyzeLegacyAuditDrift(new Set()).ok).toBe(true);
  });

  it("audit doc 未記載 / allowlist 未登録 を双方向検出 (合成 allowlist)", () => {
    const r1 = analyzeLegacyAuditDrift(new Set(), SYNTH_ALLOWLIST);
    expect(r1.missingInAudit).toEqual([SYNTH_LEGACY]);
    expect(r1.ok).toBe(false);
    const r2 = analyzeLegacyAuditDrift(
      new Set([...SYNTH_ALLOWLIST, "PLAN-L7-000-extra"]),
      SYNTH_ALLOWLIST,
    );
    expect(r2.missingInAllowlist).toEqual(["PLAN-L7-000-extra"]);
    expect(r2.ok).toBe(false);
  });

  it("parseLegacyAuditPlanIds が table 行頭の PLAN id を抽出", () => {
    const md = "| plan_id | x |\n|---|---|\n| PLAN-L7-147-refactor-candidate-detector | impl |\n";
    expect(parseLegacyAuditPlanIds(md).has("PLAN-L7-147-refactor-candidate-detector")).toBe(true);
  });
});
