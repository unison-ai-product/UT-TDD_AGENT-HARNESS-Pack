/**
 * vmodel pair-freeze lint test (IMP-067、PLAN-L7-11)。
 * design doc ⇔ test-design doc の pair_artifact 双方向整合・孤児0 (設計層 pair freeze、G1-G6)。
 * L7-unit-test-design §1.13 U-VPAIR-001〜006 を被覆 + 実 repo 完全性ガード。
 */
import { describe, expect, it } from "vitest";
import {
  analyzePairFreeze,
  analyzeVerificationGroups,
  L0_L7_AUTOMATION_PLAN_IDS,
  loadPairDocs,
  loadVerificationPlanEvidence,
  type PairDoc,
  pairFreezeMessages,
  parsePairDoc,
  stripInlineComment,
  verificationGroupMessages,
} from "../src/vmodel/lint";

const doc = (
  path: string,
  layer: string | null,
  pa: string | null,
  status: string | null = null,
): PairDoc => ({
  path,
  layer,
  pairArtifact: pa,
  status,
});

describe("vmodel pair-freeze lint (U-VPAIR)", () => {
  it("U-VPAIR-001: parsePairDoc / stripInlineComment — frontmatter 抽出 + inline コメント除去", () => {
    expect(stripInlineComment("self  # wireframe mock 自体が③ペア")).toBe("self");
    expect(stripInlineComment("docs/test-design/harness/L9-system-test-design.md")).toBe(
      "docs/test-design/harness/L9-system-test-design.md",
    );
    const d = parsePairDoc(
      "docs/design/harness/L2-screen/wireframe.md",
      "---\nlayer: L2\npair_artifact: self  # mock\n---\n",
    );
    expect(d.layer).toBe("L2");
    expect(d.pairArtifact).toBe("self");
  });

  it("U-VPAIR-002: pair-missing / ref-unresolved を検出", () => {
    const docs = [
      doc("docs/design/harness/L4-basic-design/data.md", "L4", null), // pair 欠落
      doc(
        "docs/design/harness/L4-basic-design/function.md",
        "L4",
        "docs/test-design/harness/NOPE.md",
      ), // 不実在
    ];
    const r = analyzePairFreeze(docs);
    expect(r.ok).toBe(false);
    expect(r.orphans.map((o) => o.reason).sort()).toEqual(["pair-missing", "ref-unresolved"]);
  });

  it("U-VPAIR-003: trace-bidir — test-design の dir 集合参照が design dir を含めば成立、無ければ孤児", () => {
    const ok = analyzePairFreeze([
      doc(
        "docs/design/harness/L4-basic-design/data.md",
        "L4",
        "docs/test-design/harness/L9-system-test-design.md",
      ),
      doc(
        "docs/test-design/harness/L9-system-test-design.md",
        "L4",
        "docs/design/harness/L4-basic-design/",
      ),
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.pairs).toBe(1);

    const orphan = analyzePairFreeze([
      doc(
        "docs/design/harness/L4-basic-design/data.md",
        "L4",
        "docs/test-design/harness/L9-system-test-design.md",
      ),
      doc(
        "docs/test-design/harness/L9-system-test-design.md",
        "L4",
        "docs/design/harness/L5-detailed-design/", // 別 dir を逆参照
      ),
    ]);
    expect(orphan.ok).toBe(false);
    expect(orphan.orphans[0]?.reason).toBe("trace-orphan");
  });

  it("U-VPAIR-004: self-pair / L2 group — wireframe=self は孤児にしない、group hub 経由で成立", () => {
    const r = analyzePairFreeze([
      doc("docs/design/harness/L2-screen/wireframe.md", "L2", "self"),
      doc(
        "docs/design/harness/L2-screen/screen-list.md",
        "L2",
        "docs/design/harness/L2-screen/wireframe.md",
      ),
    ]);
    expect(r.ok).toBe(true);
    expect(r.pairs).toBe(2); // wireframe(self) + screen-list(group)
  });

  it("U-VPAIR-004b: README / roadmap は対象外 (pair 欠落でも孤児にしない)", () => {
    const r = analyzePairFreeze([
      doc("docs/design/harness/L3-functional/README.md", "L3", null),
      doc("docs/design/harness/L3-functional/roadmap.md", "L3", null),
    ]);
    expect(r.ok).toBe(true);
    expect(r.orphans).toEqual([]);
  });

  it("U-VPAIR-005: 実 repo 完全性回帰ガード — 全 V-pair 双方向、孤児0", () => {
    const r = analyzePairFreeze(loadPairDocs());
    if (!r.ok) {
      throw new Error(`pair-freeze 孤児あり:\n${JSON.stringify(r.orphans, null, 2)}`);
    }
    expect(r.ok).toBe(true);
    expect(r.pairs).toBeGreaterThan(0);
  });

  it("U-VPAIR-006: pairFreezeMessages — 孤児なし OK / 孤児あり reason 別文言", () => {
    expect(pairFreezeMessages({ ok: true, orphans: [], pairs: 5 })[0]).toContain("OK");
    const msgs = pairFreezeMessages({
      ok: false,
      pairs: 0,
      orphans: [
        {
          path: "docs/design/harness/L3-functional/README.md",
          reason: "pair-missing",
          detail: "layer L3",
        },
      ],
    });
    expect(msgs.join(" ")).toContain("pair 欠落");
  });
});

describe("verification trigger (U-VTRIG、層群 freeze の機械発火、IMP-068)", () => {
  it("U-VTRIG-001: analyzeVerificationGroups — 層群ごとに confirmed/draft を集計", () => {
    const docs = [
      doc("docs/design/harness/L1-requirements/a.md", "L1", "x", "confirmed"),
      doc("docs/design/harness/L3-functional/b.md", "L3", "x", "confirmed"),
      doc("docs/design/harness/L4-basic-design/c.md", "L4", "x", "draft"),
    ];
    const groups = analyzeVerificationGroups(docs, []);
    const l03 = groups.find((g) => g.id === "L0-L3");
    expect(l03?.confirmed).toBe(2);
    expect(l03?.total).toBe(2);
    expect(l03?.frozen).toBe(true);
    const l46 = groups.find((g) => g.id === "L4-L6");
    expect(l46?.draft).toBe(1);
    expect(l46?.frozen).toBe(false);
  });

  it("U-VTRIG-002: frozen 判定 — draft があれば未完了、placeholder(park) は発火を妨げない", () => {
    const withPark = analyzeVerificationGroups(
      [
        doc("docs/design/harness/L1-requirements/a.md", "L1", "x", "confirmed"),
        doc("docs/design/harness/L2-screen/b.md", "L2", "x", "placeholder"),
      ],
      [],
    ).find((g) => g.id === "L0-L3");
    expect(withPark?.frozen).toBe(true); // placeholder=park、confirmed 1 件で発火可
    expect(withPark?.placeholder).toBe(1);

    const withDraft = analyzeVerificationGroups(
      [
        doc("docs/design/harness/L1-requirements/a.md", "L1", "x", "confirmed"),
        doc("docs/design/harness/L3-functional/b.md", "L3", "x", "draft"),
      ],
      [],
    ).find((g) => g.id === "L0-L3");
    expect(withDraft?.frozen).toBe(false); // draft あり → Forward 進行中
  });

  it("U-VTRIG-003: 層群に pair 孤児があれば freeze 未完了", () => {
    const g = analyzeVerificationGroups(
      [doc("docs/design/harness/L1-requirements/a.md", "L1", "x", "confirmed")],
      [{ path: "docs/design/harness/L1-requirements/a.md", reason: "pair-missing", detail: "" }],
    ).find((g) => g.id === "L0-L3");
    expect(g?.frozen).toBe(false);
    expect(g?.hasOrphan).toBe(true);
  });

  it("U-VTRIG-006: L0-L7 freeze requires confirmed L7 automation PLAN evidence", () => {
    const docs = [
      doc("docs/design/harness/L1-requirements/a.md", "L1", "x", "confirmed"),
      doc("docs/design/harness/L2-screen/b.md", "L2", "x", "confirmed"),
      doc("docs/design/harness/L3-functional/c.md", "L3", "x", "confirmed"),
      doc("docs/design/harness/L4-basic-design/d.md", "L4", "x", "confirmed"),
      doc("docs/design/harness/L5-physical-data/e.md", "L5", "x", "confirmed"),
      doc("docs/design/harness/L6-function-design/f.md", "L6", "x", "confirmed"),
    ];
    const missing = analyzeVerificationGroups(docs, [], new Map()).find((g) => g.id === "L0-L7");
    expect(missing?.frozen).toBe(false);
    expect(missing?.missingPlanIds).toEqual([...L0_L7_AUTOMATION_PLAN_IDS]);

    const statuses = new Map(L0_L7_AUTOMATION_PLAN_IDS.map((id) => [id, "confirmed"]));
    const frozen = analyzeVerificationGroups(docs, [], statuses).find((g) => g.id === "L0-L7");
    expect(frozen?.frozen).toBe(true);
    expect(frozen?.confirmedPlanIds).toHaveLength(L0_L7_AUTOMATION_PLAN_IDS.length);

    const noEvidence = new Map(
      L0_L7_AUTOMATION_PLAN_IDS.map((id) => [
        id,
        { status: "confirmed", hasReviewEvidence: false, hasGenerates: true },
      ]),
    );
    const evidenceMissing = analyzeVerificationGroups(docs, [], noEvidence).find(
      (g) => g.id === "L0-L7",
    );
    expect(evidenceMissing?.frozen).toBe(false);
    expect(evidenceMissing?.evidenceMissingPlanIds).toEqual([...L0_L7_AUTOMATION_PLAN_IDS]);

    const fullEvidence = new Map(
      L0_L7_AUTOMATION_PLAN_IDS.map((id) => [
        id,
        { status: "confirmed", hasReviewEvidence: true, hasGenerates: true },
      ]),
    );
    const evidenceReady = analyzeVerificationGroups(docs, [], fullEvidence).find(
      (g) => g.id === "L0-L7",
    );
    expect(evidenceReady?.frozen).toBe(true);
    expect(evidenceReady?.evidenceReadyPlanIds).toHaveLength(L0_L7_AUTOMATION_PLAN_IDS.length);
  });

  it("U-VTRIG-004: verificationGroupMessages — freeze 完了(park 表示) / Forward 進行中", () => {
    const frozen = verificationGroupMessages([
      {
        id: "L0-L3",
        label: "上流",
        gate: "L3 検証サイクルゲート",
        total: 5,
        confirmed: 4,
        draft: 0,
        placeholder: 1,
        hasOrphan: false,
        requiredPlanIds: [],
        confirmedPlanIds: [],
        missingPlanIds: [],
        evidenceReadyPlanIds: [],
        evidenceMissingPlanIds: [],
        frozen: true,
      },
    ]);
    expect(frozen[0]).toContain("freeze 完了");
    expect(frozen[0]).toContain("検証サイクル発火可");
    expect(frozen[0]).toContain("park");
    // 検証サイクルゲート名が主見出しに surface される (PLAN-REVERSE-36)。
    expect(frozen[0]).toContain("L3 検証サイクルゲート");
    const progress = verificationGroupMessages([
      {
        id: "L4-L6",
        label: "設計",
        gate: "L6 検証サイクルゲート",
        total: 18,
        confirmed: 0,
        draft: 18,
        placeholder: 0,
        hasOrphan: false,
        requiredPlanIds: [],
        confirmedPlanIds: [],
        missingPlanIds: [],
        evidenceReadyPlanIds: [],
        evidenceMissingPlanIds: [],
        frozen: false,
      },
    ]);
    expect(progress[0]).toContain("Forward 進行中");
  });

  it("U-VTRIG-005: 実 repo ガード — L0-L3 と L4-L6 は freeze 完了", () => {
    const docs = loadPairDocs();
    const { orphans } = analyzePairFreeze(docs);
    const groups = analyzeVerificationGroups(docs, orphans, loadVerificationPlanEvidence());
    expect(groups.find((g) => g.id === "L0-L3")?.frozen).toBe(true);
    expect(groups.find((g) => g.id === "L4-L6")?.frozen).toBe(true);
    // 全 3 検証サイクルゲート名が実 repo の surface に出る (PLAN-REVERSE-36、命名の壊れを CI で検知)。
    const surface = verificationGroupMessages(groups).join("\n");
    expect(surface).toContain("L3 検証サイクルゲート");
    expect(surface).toContain("L6 検証サイクルゲート");
    expect(surface).toContain("設計検証サイクルゲート");
    expect(surface).toContain("実装検証サイクルゲート");
    expect(groups.find((g) => g.id === "L0-L7")?.frozen).toBe(true);
  });
});
