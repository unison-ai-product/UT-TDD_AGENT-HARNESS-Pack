import { describe, expect, it } from "vitest";
import { classifyDriveTddFits, routeSignalToMode } from "../src/workflow/contracts";
import {
  type BackendCapability,
  composeDesignBottomupDiscovery,
  detectFeDesignGaps,
  elicitFeRequirements,
  type FeDesignSlotState,
  runDesignBottomup,
  type ScreenRef,
  type ScreenTraceRef,
} from "../src/workflow/design-elicitation";

// design-bottomup 駆動モデル (画面後付け駆動) の ① elicitation engine + Discovery 合成。
// backend reality (L4 data entity / screen projection / CLI capability) から FE 要件を洗い出し、
// FE 設計 slot の不在を signal 発火し、Discovery (mock 具体化 → Forward 降下) へ合成する。

const SCREENS: ScreenRef[] = [
  {
    screen_id: "HM-04",
    name: "DB閲覧ビュー",
    category: "HM",
    url: "/harness/db",
    l1_ref: "screen §1.HM.04",
  },
  {
    screen_id: "PM-01",
    name: "俯瞰ダッシュボード",
    category: "PM",
    url: "/projects",
    l1_ref: "screen §1.PM.01",
  },
];

const CAPABILITIES: BackendCapability[] = [
  { kind: "projection", id: "screens", surface: "harness.db screen projection" },
  { kind: "data_entity", id: "plan", surface: "Plan 集約ルート" },
  { kind: "cli_command", id: "ut-tdd status", surface: "status 出力" },
];

const SCREEN_TRACE: ScreenTraceRef[] = [
  { screen_id: "HM-04", requirement_id: "FR-L1-12", requirement_kind: "FR" },
  { screen_id: "PM-01", requirement_id: "BR-03", requirement_kind: "BR" },
];

describe("elicitFeRequirements (backend → FE要件 洗い出し)", () => {
  it("各画面について FE 設計鎖 3 slot の候補を backend capability から derive する", () => {
    const r = elicitFeRequirements({
      screens: SCREENS,
      capabilities: CAPABILITIES,
      screen_trace: SCREEN_TRACE,
    });
    expect(r.ok).toBe(true);
    // 2 画面 × 3 slot (L3/L5/L6) = 6 候補
    expect(r.candidates.length).toBe(6);
    const slots = new Set(r.candidates.map((c) => c.design_slot));
    expect(slots).toEqual(new Set(["L3:screen-functional", "L5:ui-detail", "L6:screen-spec"]));
    // 各候補は backend capability に grounding されている (prose でなく derived_from で実体化)
    for (const c of r.candidates) {
      expect(c.derived_from.length).toBeGreaterThan(0);
      expect(c.screen_id.length).toBeGreaterThan(0);
    }
  });

  it("backend capability も trace も無い画面は grounding 不能を warn で可視化する (absence-blindness 対策)", () => {
    const r = elicitFeRequirements({
      screens: [
        { screen_id: "GD-01", name: "ガイド", category: "GD", url: "/guide/x", l1_ref: "" },
      ],
      capabilities: [],
      screen_trace: [],
    });
    expect(r.findings.some((f) => f.code === "fe-requirement-ungrounded")).toBe(true);
    // warn 止まりで ok=true (severity=error のみ ok=false にする不変条件)
    expect(r.ok).toBe(true);
  });

  it("trace を持つ画面は screen-specific に grounding される (generic cap へ潰れない)", () => {
    const r = elicitFeRequirements({
      screens: SCREENS,
      capabilities: CAPABILITIES,
      screen_trace: SCREEN_TRACE,
    });
    const hm = r.candidates.find((c) => c.screen_id === "HM-04");
    const pm = r.candidates.find((c) => c.screen_id === "PM-01");
    // 各画面が自分の trace (FR-L1-12 / BR-03) に grounding され、同一文字列に潰れない
    expect(hm?.derived_from).toContain("FR-L1-12");
    expect(pm?.derived_from).toContain("BR-03");
    expect(hm?.derived_from).not.toBe(pm?.derived_from);
  });
});

describe("detectFeDesignGaps (候補あり・slot body 不在 → signal 発火)", () => {
  it("body 不在の slot を gap として screen_requirement_gap 系 signal で発火する", () => {
    const elicited = elicitFeRequirements({
      screens: SCREENS,
      capabilities: CAPABILITIES,
      screen_trace: SCREEN_TRACE,
    });
    const slots: FeDesignSlotState[] = [
      {
        slot: "L3:screen-functional",
        has_body: false,
        doc_path: "docs/design/harness/L3-functional/screen-functional.md",
      },
      {
        slot: "L5:ui-detail",
        has_body: false,
        doc_path: "docs/design/harness/L5-detailed-design/ui-detail.md",
      },
      {
        slot: "L6:screen-spec",
        has_body: false,
        doc_path: "docs/design/harness/L6-function-design/screen-spec.md",
      },
    ];
    const r = detectFeDesignGaps({ candidates: elicited.candidates, slots });
    expect(r.gaps.length).toBe(3);
    const l3 = r.gaps.find((g) => g.slot === "L3:screen-functional");
    expect(l3?.signal_type).toBe("screen_requirement_gap");
    expect(l3?.screen_ids.sort()).toEqual(["HM-04", "PM-01"]);
  });

  it("body が存在する slot は gap にしない (coverage≠substance: body 実在のみ green)", () => {
    const elicited = elicitFeRequirements({
      screens: SCREENS,
      capabilities: CAPABILITIES,
      screen_trace: SCREEN_TRACE,
    });
    const slots: FeDesignSlotState[] = [
      { slot: "L3:screen-functional", has_body: true, doc_path: "x" },
      { slot: "L5:ui-detail", has_body: true, doc_path: "x" },
      { slot: "L6:screen-spec", has_body: true, doc_path: "x" },
    ];
    const r = detectFeDesignGaps({ candidates: elicited.candidates, slots });
    expect(r.gaps.length).toBe(0);
  });

  it("slot が slots 配列に未定義 (state=undefined) でも候補がある slot は gap として検出する", () => {
    const elicited = elicitFeRequirements({
      screens: SCREENS,
      capabilities: CAPABILITIES,
      screen_trace: SCREEN_TRACE,
    });
    const r = detectFeDesignGaps({ candidates: elicited.candidates, slots: [] });
    expect(r.gaps.length).toBe(3);
  });
});

describe("composeDesignBottomupDiscovery (gaps → Discovery 合成)", () => {
  it("gap を Discovery エントリ (design_uncertain) へ合成し mock→Forward の stage を返す", () => {
    const elicited = elicitFeRequirements({
      screens: SCREENS,
      capabilities: CAPABILITIES,
      screen_trace: SCREEN_TRACE,
    });
    const { gaps } = detectFeDesignGaps({
      candidates: elicited.candidates,
      slots: [
        { slot: "L3:screen-functional", has_body: false, doc_path: "x" },
        { slot: "L5:ui-detail", has_body: false, doc_path: "x" },
        { slot: "L6:screen-spec", has_body: false, doc_path: "x" },
      ],
    });
    const r = composeDesignBottomupDiscovery({ gaps });
    expect(r.discovery).not.toBeNull();
    expect(r.discovery?.entry_signal).toBe("design_uncertain");
    // 合成: entry_signal は既存 Discovery routing へ確実に乗る (mode 再発明しない)
    expect(routeSignalToMode({ signal: r.discovery?.entry_signal ?? "" }).candidates).toContain(
      "discovery",
    );
    expect(r.discovery?.forward_merge).toBe("L3-L6");
    // mock 具体化 → Forward 降下 が stage に含まれる
    const stageText = (r.discovery?.stages ?? []).join(" ");
    expect(stageText).toContain("mock");
    expect(stageText.toLowerCase()).toContain("forward");
  });

  it("gap が無ければ Discovery を起こさない (駆動の no-op)", () => {
    const r = composeDesignBottomupDiscovery({ gaps: [] });
    expect(r.discovery).toBeNull();
    expect(r.ok).toBe(true);
  });
});

describe("runDesignBottomup (end-to-end 駆動) + mode taxonomy", () => {
  it("elicit→detect→compose を連鎖し candidates/gaps/discovery を返す", () => {
    const r = runDesignBottomup({
      screens: SCREENS,
      capabilities: CAPABILITIES,
      screen_trace: SCREEN_TRACE,
      slots: [
        { slot: "L3:screen-functional", has_body: false, doc_path: "x" },
        { slot: "L5:ui-detail", has_body: false, doc_path: "x" },
        { slot: "L6:screen-spec", has_body: false, doc_path: "x" },
      ],
    });
    expect(r.candidates.length).toBe(6);
    expect(r.gaps.length).toBe(3);
    expect(r.discovery?.mode).toBe("design-bottomup");
    // 全画面 grounded → warn 0 → ok=true
    expect(r.ok).toBe(true);
  });

  it("design-bottomup が DriveTddFit (mode taxonomy) に登録されている", () => {
    const r = classifyDriveTddFits({ modes: ["design-bottomup"] });
    expect(r.fits.length).toBe(1);
    expect(r.fits[0]?.compatibility).toBe("strong");
    expect(r.fits[0]?.red_triggers).toContain("screen_requirement_gap");
  });
});
