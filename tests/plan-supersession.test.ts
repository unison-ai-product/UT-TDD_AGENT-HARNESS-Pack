import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlanSupersession } from "../src/doctor/index.ts";
import {
  analyzePlanSupersession,
  loadSupersedePlans,
  type ParsedSupersedePlan,
  PLAN_SUPERSESSION_SELF_BASELINE,
  parseSupersedes,
  planCoreId,
  planSupersessionMessages,
} from "../src/lint/plan-supersession.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

// PLAN-L7-89: 誤記対策 — confirmed PLAN の誤った主張を後継が直したとき、errata リンクが
// 双方向 (supersedes 宣言 + 原 PLAN の訂正 back-reference) であることを fail-close 強制する。

describe("planCoreId / parseSupersedes", () => {
  it("planCoreId は slug 付き plan_id を core 形へ畳む", () => {
    expect(planCoreId("PLAN-L7-87-merged-plan-status-kind-independent")).toBe("PLAN-L7-87");
    expect(planCoreId("PLAN-DISCOVERY-05-roadmap-registration")).toBe("PLAN-DISCOVERY-05");
    expect(planCoreId("PLAN-M-00")).toBe("PLAN-M-00");
  });

  it("parseSupersedes は YAML list を抽出し path/.md を正規化、[] は無視", () => {
    const fm = [
      "---",
      "supersedes:",
      "  - docs/plans/PLAN-L7-86-x.md",
      "  - PLAN-L4-13",
      "---",
    ].join("\n");
    expect(parseSupersedes(fm)).toEqual(["PLAN-L7-86-x", "PLAN-L4-13"]);
    expect(parseSupersedes("---\nsupersedes: []\n---")).toEqual([]);
    expect(parseSupersedes("---\nkind: impl\n---")).toEqual([]);
  });
});

describe("analyzePlanSupersession", () => {
  function plan(over: Partial<ParsedSupersedePlan>): ParsedSupersedePlan {
    return { plan_id: "PLAN-X", supersedes: [], content: "", ...over };
  }

  it("supersede 先が実在 + back-reference 有 → ok", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-87-kind", supersedes: ["PLAN-L7-86-scope"] }),
      // 原 PLAN が後継の core-id (PLAN-L7-87) を訂正注記として含む。
      plan({ plan_id: "PLAN-L7-86-scope", content: "訂正: PLAN-L7-87 が supersede した。" }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("自己 supersede は violation になる", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-1-x", supersedes: ["PLAN-L7-1-x"] }),
    ]);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({
      selfSupersedes: [{ plan_id: "PLAN-L7-1-x", target: "PLAN-L7-1-x" }],
    });
    expect(r.missingTargets).toEqual([]);
    expect(r.missingBackrefs).toEqual([]);
  });

  it("slug 違いの自己参照も core-id で violation になる", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-1-x", supersedes: ["PLAN-L7-1-y"] }),
    ]);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({
      selfSupersedes: [{ plan_id: "PLAN-L7-1-x", target: "PLAN-L7-1-y" }],
    });
    expect(r.missingTargets).toEqual([]);
    expect(r.missingBackrefs).toEqual([]);
  });

  it("正当な supersede は従来どおり green", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-1-x", supersedes: ["PLAN-L7-2-y"] }),
      plan({ plan_id: "PLAN-L7-2-y", content: "訂正: PLAN-L7-1 が supersede した。" }),
    ]);
    expect(r.selfSupersedes).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("自己 supersede の理由を日本語メッセージで説明する", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-1-x", supersedes: ["PLAN-L7-1-x"] }),
    ]);
    expect(planSupersessionMessages(r).join("\n")).toContain(
      "自己 supersede は errata ゲートを自明通過する",
    );
  });

  it("supersede 先が実在しない → missingTargets violation", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-87-kind", supersedes: ["PLAN-NOPE-99"] }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.missingTargets[0]).toEqual({ plan_id: "PLAN-L7-87-kind", target: "PLAN-NOPE-99" });
  });

  it("supersede 先に back-reference が無い → missingBackrefs violation (片肺 errata)", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-87-kind", supersedes: ["PLAN-L7-86-scope"] }),
      plan({ plan_id: "PLAN-L7-86-scope", content: "誤記のまま、後継への言及なし。" }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.missingBackrefs[0]).toEqual({
      plan_id: "PLAN-L7-87-kind",
      target: "PLAN-L7-86-scope",
    });
  });

  it("supersedes 非宣言の PLAN は対象外 (prose 真偽は機械化しない)", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-A", content: "blast radius 0 と断定しているが supersede 宣言なし" }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("core-id の word-boundary: PLAN-L7-87 は PLAN-L7-870 を誤マッチしない", () => {
    const r = analyzePlanSupersession([
      plan({ plan_id: "PLAN-L7-87-kind", supersedes: ["PLAN-L7-86-scope"] }),
      plan({ plan_id: "PLAN-L7-86-scope", content: "言及は PLAN-L7-870 だけ (別 PLAN)。" }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.missingBackrefs).toHaveLength(1);
  });

  it("baseline 宣言済みの自己 supersede は ok を落とさず可視化だけする", () => {
    const r = analyzePlanSupersession(
      [plan({ plan_id: "PLAN-L7-1-x", supersedes: ["PLAN-L7-1-x"] })],
      new Set(["PLAN-L7-1-x"]),
    );
    expect(r.selfSupersedes).toEqual([]);
    expect(r.baselinedSelfSupersedes).toEqual([{ plan_id: "PLAN-L7-1-x", target: "PLAN-L7-1-x" }]);
    expect(r.staleSelfBaseline).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("baseline 外の新規自己 supersede は baseline が在っても fail-close (baseline は増やせない)", () => {
    const r = analyzePlanSupersession(
      [
        plan({ plan_id: "PLAN-L7-1-x", supersedes: ["PLAN-L7-1-x"] }),
        plan({ plan_id: "PLAN-L7-2-y", supersedes: ["PLAN-L7-2-y"] }),
      ],
      new Set(["PLAN-L7-1-x"]),
    );
    expect(r.selfSupersedes).toEqual([{ plan_id: "PLAN-L7-2-y", target: "PLAN-L7-2-y" }]);
    expect(r.ok).toBe(false);
  });

  // baseline は縮小のみ可。この負 oracle が無いと staleSelfBaseline の算出を空配列固定にしても
  // 全テストが green のままになる (実 repo は現に stale 0 件なので拘束しない)。
  it("baseline に載っているのに自己 supersede が消えたら staleSelfBaseline violation", () => {
    const r = analyzePlanSupersession(
      [plan({ plan_id: "PLAN-L7-1-x", supersedes: [] })],
      new Set(["PLAN-L7-1-x"]),
    );
    expect(r.staleSelfBaseline).toEqual(["PLAN-L7-1-x"]);
    expect(r.baselinedSelfSupersedes).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("staleSelfBaseline は複数件を昇順で列挙する", () => {
    const r = analyzePlanSupersession(
      [
        plan({ plan_id: "PLAN-L7-2-b", supersedes: [] }),
        plan({ plan_id: "PLAN-L7-1-a", supersedes: [] }),
      ],
      new Set(["PLAN-L7-2-b", "PLAN-L7-1-a"]),
    );
    expect(r.staleSelfBaseline).toEqual(["PLAN-L7-1-a", "PLAN-L7-2-b"]);
  });

  it("staleSelfBaseline の縮小要求を日本語メッセージで説明する", () => {
    const r = analyzePlanSupersession(
      [plan({ plan_id: "PLAN-L7-1-x", supersedes: [] })],
      new Set(["PLAN-L7-1-x"]),
    );
    expect(planSupersessionMessages(r).join("\n")).toContain("baseline は縮小のみ可");
  });

  // 意図的な仕様: plans に無い baseline エントリは stale 扱いしない。単体テストは既定 baseline
  // (実 repo の 7 件) を注入せず小さな plans 配列を渡すため、実在性を要求すると全件が stale に
  // なってしまう。baseline に架空 ID を混ぜられないことは、下の実 repo oracle
  // (baselinedSelfSupersedes == baseline 全体) が拘束する。
  it("plans に存在しない baseline エントリは stale 扱いしない", () => {
    const r = analyzePlanSupersession(
      [plan({ plan_id: "PLAN-L7-9-z", supersedes: [] })],
      new Set(["PLAN-GONE-01"]),
    );
    expect(r.staleSelfBaseline).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("実 repo の supersede 検査は green になる", () => {
    const root = workspaceRead({
      id: "U-PSUP-SELF",
      mode: "head_snapshot",
      reason: "自己 supersede の実 repo 検査は live tree ではなく HEAD の docs/plans を突合する",
    });
    const r = analyzePlanSupersession(loadSupersedePlans(root));
    // 既知債務 7 件は baseline 宣言済みなので ok。baseline 外の新規自己参照が 0 であることを固定する。
    expect(r.selfSupersedes).toEqual([]);
    expect(r.staleSelfBaseline).toEqual([]);
    expect(r.baselinedSelfSupersedes.map((v) => v.plan_id).sort()).toEqual(
      [...PLAN_SUPERSESSION_SELF_BASELINE].sort(),
    );
    expect(r.ok).toBe(true);
  });
});

/**
 * issue #183 時点で実測した自己 supersede 債務の**凍結集合**。
 *
 * `PLAN_SUPERSESSION_SELF_BASELINE` (src 側) から独立に、テスト側でリテラルとして固定する。
 * 上の実 repo oracle は左右とも src 側 baseline 由来なので、**実在 PLAN ID を baseline と実データへ
 * 同時に追加**すると両辺が揃って増えて一致してしまい、「縮小のみ可」を保証できない
 * (Codex/Tera closing review が `17c5a728` で指摘した攻撃)。凍結集合との subset 判定はこの経路を殺す。
 *
 * **このリストは減らす方向にしか編集してはならない。** 追加が必要になったなら、それは新しい
 * 自己 supersede 債務を作っているということであり、baseline 拡大ではなく債務の解消 (issue #209) で
 * 対処すべきである。
 */
const SELF_BASELINE_FROZEN_AT_ISSUE_183: ReadonlySet<string> = new Set([
  "PLAN-L4-02-architecture",
  "PLAN-L4-32-resource-governed-execution-kernel",
  "PLAN-L5-03-internal-processing",
  "PLAN-L5-25-resource-kernel-physical-protocol",
  "PLAN-L6-01-function-spec",
  "PLAN-L6-92-resource-kernel-function-contracts",
  "PLAN-L7-466-resource-kernel-native-companion",
]);

describe("PLAN_SUPERSESSION_SELF_BASELINE は縮小のみ可", () => {
  it("baseline は凍結集合の部分集合でなければならない (拡大・入れ替えを禁止)", () => {
    const added = [...PLAN_SUPERSESSION_SELF_BASELINE]
      .filter((planId) => !SELF_BASELINE_FROZEN_AT_ISSUE_183.has(planId))
      .sort();
    expect(added).toEqual([]);
  });

  it("baseline は凍結集合より大きくならない", () => {
    expect(PLAN_SUPERSESSION_SELF_BASELINE.size).toBeLessThanOrEqual(
      SELF_BASELINE_FROZEN_AT_ISSUE_183.size,
    );
    expect(SELF_BASELINE_FROZEN_AT_ISSUE_183.size).toBe(7);
  });
});

describe("loadSupersedePlans + checkPlanSupersession", () => {
  function writePlan(root: string, name: string, body: string, supersedes?: string[]): void {
    const fm = ["---", `plan_id: ${name.replace(/\.md$/, "")}`, "kind: troubleshoot"];
    if (supersedes) {
      fm.push("supersedes:");
      for (const s of supersedes) fm.push(`  - ${s}`);
    }
    fm.push("---", "", body, "");
    writeFileSync(join(root, "docs", "plans", name), fm.join("\n"), "utf8");
  }

  it("双方向 errata は green / 片肺は violation", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-supersede-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      // 双方向 OK: 後継が supersedes 宣言、原が訂正 back-ref。
      writePlan(root, "PLAN-L7-87-kind.md", "kind 非依存化", ["PLAN-L7-86-scope"]);
      writePlan(root, "PLAN-L7-86-scope.md", "訂正: PLAN-L7-87 が supersede。");
      expect(checkPlanSupersession(root).ok).toBe(true);

      // 片肺: 原が後継へ言及しない → violation。
      writePlan(root, "PLAN-L7-86-scope.md", "誤記のまま。");
      const r = checkPlanSupersession(root);
      expect(r.ok).toBe(false);
      expect(r.messages.join("\n")).toContain("back-reference");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repo root が読めないと fail-close", () => {
    expect(checkPlanSupersession(join(tmpdir(), "ut-tdd-supersede-nope-zzz")).ok).toBe(false);
  });
});
