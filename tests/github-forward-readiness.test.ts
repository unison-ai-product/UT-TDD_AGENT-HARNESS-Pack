import { describe, expect, it } from "vitest";
import {
  deriveForwardReadiness,
  type ForwardScheduleEntry,
} from "../src/kernel/forward-readiness.ts";

const entry = (
  planId: string,
  status: string,
  predecessorPlanIds: string[] = [],
): ForwardScheduleEntry => ({
  planId,
  revision: `${planId}@1`,
  layer: "L7",
  status,
  currentLocation: "implement",
  rag: "yellow",
  blockedReason: "",
  predecessorPlanIds,
});

const closed = (planId: string) => ({
  planId,
  ci: "成功" as const,
  review: "承認" as const,
  sync: "同期済" as const,
  mergeVerified: true,
});

describe("Forward work graph readiness", () => {
  it("U-GHPROJ-001: blocks unresolved predecessors and unlocks only after all complete", () => {
    const blocked = deriveForwardReadiness(
      [
        entry("PLAN-L7-1-a", "confirmed"),
        entry("PLAN-L7-2-b", "draft"),
        entry("PLAN-L7-3-c", "draft", ["PLAN-L7-1-a", "PLAN-L7-2-b"]),
      ],
      [closed("PLAN-L7-1-a")],
    );
    expect(blocked[2]).toMatchObject({
      readiness: "阻害中",
      blockedReason: "先行PLAN未完了: PLAN-L7-2-b",
    });
    const released = deriveForwardReadiness(
      [
        entry("PLAN-L7-1-a", "confirmed"),
        entry("PLAN-L7-2-b", "confirmed"),
        entry("PLAN-L7-3-c", "draft", ["PLAN-L7-1-a", "PLAN-L7-2-b"]),
      ],
      [closed("PLAN-L7-1-a"), closed("PLAN-L7-2-b")],
    );
    expect(released[2]?.readiness).toBe("着手可能");
    expect(released[1]?.unlockedPlanIds).toEqual(["PLAN-L7-3-c"]);
  });

  it("U-GHPROJ-002: fails closed for missing plans, sync drift, CI, and review failures", () => {
    const rows = deriveForwardReadiness(
      [entry("PLAN-L7-4-d", "draft", ["PLAN-L7-404-missing"]), entry("PLAN-L7-5-e", "active")],
      [
        { planId: "PLAN-L7-4-d", sync: "不整合" },
        { planId: "PLAN-L7-5-e", ci: "失敗", review: "要修正" },
      ],
    );
    expect(rows[0]?.readiness).toBe("阻害中");
    expect(rows[0]?.blockedReason).toContain("先行PLAN欠損");
    expect(rows[0]?.blockedReason).toContain("同期不整合");
    expect(rows[1]?.blockedReason).toBe("CI失敗; レビュー要修正");
  });

  it("U-GHPROJ-003: rejects duplicate plan identities", () => {
    expect(() =>
      deriveForwardReadiness([entry("PLAN-L7-1-a", "draft"), entry("PLAN-L7-1-a", "draft")]),
    ).toThrow(/duplicate plan_id/);
  });

  it("U-GHPROJ-004: accepted schedule remains blocked under negative closure evidence", () => {
    const [row] = deriveForwardReadiness(
      [entry("PLAN-L7-6-f", "confirmed")],
      [
        {
          planId: "PLAN-L7-6-f",
          ci: "失敗",
          review: "要修正",
          sync: "不整合",
        },
      ],
    );
    expect(row?.readiness).toBe("阻害中");
    expect(row?.blockedReason).toContain("CI失敗");
    expect(row?.blockedReason).toContain("review承認未確認");
  });

  it("U-GHPROJ-005: accepted schedule without closure evidence cannot complete or unlock", () => {
    const rows = deriveForwardReadiness([
      entry("PLAN-L7-7-g", "confirmed"),
      entry("PLAN-L7-8-h", "draft", ["PLAN-L7-7-g"]),
    ]);
    expect(rows[0]?.readiness).toBe("阻害中");
    expect(rows[0]?.currentGate).toBe("merge-closure");
    expect(rows[0]?.blockedReason).toContain("merge/main CI未確認");
    expect(rows[0]?.unlockedPlanIds).toEqual([]);
    expect(rows[1]?.readiness).toBe("阻害中");
  });
});
