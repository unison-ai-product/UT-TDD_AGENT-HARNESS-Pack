import { describe, expect, it } from "vitest";
import {
  normalizeDocumentApplicability,
  validateDocumentDisposition,
} from "../../src/document-disposition/domain/document-disposition.ts";

const base = {
  baselinePath: "docs/a.md",
  disposition: "retain" as const,
  reason: "現行設計と一致",
  targets: [] as const,
  planIds: [] as const,
  applicationStatus: "verified" as const,
  applicability: { kind: "applicable" as const },
};

describe("document disposition U-DOCLEDGER-004", () => {
  it("authoring語skip/deferをcanonical applicabilityへ正規化する", () => {
    expect(
      normalizeDocumentApplicability({
        kind: "skip",
        reason: "対象機能なし",
        decider: "PO",
      }),
    ).toEqual({
      ok: true,
      value: { kind: "not_applicable", reason: "対象機能なし", decider: "PO" },
    });
    expect(
      normalizeDocumentApplicability({
        kind: "defer",
        reason: "後続対応",
        reevaluationTrigger: "PLAN完了",
        planId: "PLAN-L7-999",
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "deferred",
        reason: "後続対応",
        reevaluationTrigger: "PLAN完了",
        planId: "PLAN-L7-999",
      },
    });
  });

  it.each([
    [
      "conditional",
      { kind: "conditional", reason: "", observedCondition: "on", reevaluationTrigger: "x" },
    ],
    [
      "conditional",
      { kind: "conditional", reason: "r", observedCondition: "", reevaluationTrigger: "x" },
    ],
    [
      "conditional",
      { kind: "conditional", reason: "r", observedCondition: "on", reevaluationTrigger: "" },
    ],
    ["deferred", { kind: "deferred", reason: "", reevaluationTrigger: "x", planId: "PLAN-L7-1" }],
    ["deferred", { kind: "deferred", reason: "r", reevaluationTrigger: "", planId: "PLAN-L7-1" }],
    ["deferred", { kind: "deferred", reason: "r", reevaluationTrigger: "x", planId: "" }],
    ["not_applicable", { kind: "not_applicable", reason: "", decider: "PO" }],
    ["not_applicable", { kind: "not_applicable", reason: "r", decider: "" }],
  ] as const)("%sの必須field欠落を列挙する", (_name, applicability) => {
    const result = validateDocumentDisposition({ ...base, applicability });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFields.length).toBeGreaterThan(0);
  });

  it.each([
    "update",
    "merge",
    "supersede",
    "archive",
  ] as const)("%sはtarget又はPLANを必須とする", (disposition) => {
    expect(validateDocumentDisposition({ ...base, disposition })).toEqual({
      ok: false,
      missingFields: ["targets_or_plan_ids"],
    });
  });

  it("unknown application statusと空reasonをfail-closeする", () => {
    expect(
      validateDocumentDisposition({
        ...base,
        reason: "",
        applicationStatus: "done",
        applicability: { kind: "applicable" },
      }),
    ).toEqual({
      ok: false,
      missingFields: ["application_status", "reason"],
    });
  });

  it("unknown dispositionをfail-closeする", () => {
    expect(validateDocumentDisposition({ ...base, disposition: "reference" })).toEqual({
      ok: false,
      missingFields: ["disposition"],
    });
  });

  it("canonicalな全applicabilityを受理する", () => {
    const variants = [
      { kind: "applicable" },
      {
        kind: "conditional",
        reason: "flag有効時",
        observedCondition: "flag=on",
        reevaluationTrigger: "flag変更",
      },
      {
        kind: "deferred",
        reason: "後続対応",
        reevaluationTrigger: "PLAN完了",
        planId: "PLAN-L7-999",
      },
      { kind: "not_applicable", reason: "対象機能なし", decider: "PO" },
    ] as const;

    for (const applicability of variants) {
      expect(validateDocumentDisposition({ ...base, applicability })).toEqual({ ok: true });
    }
  });
});
