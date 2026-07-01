import { describe, expect, it } from "vitest";
import {
  analyzeG1Trace,
  extractG1BusinessIds,
  extractG1P0FrIds,
  extractG1ScreenIds,
  loadG1TraceDocs,
} from "../src/lint/g1-trace";

describe("G1-trace coverage (business/screen/functional)", () => {
  const docs = loadG1TraceDocs();
  const result = analyzeG1Trace(docs);

  it("extracts the fixed G1 business and screen sets", () => {
    const business = extractG1BusinessIds(docs.business);
    const screens = extractG1ScreenIds(docs.screen);
    expect(business.size).toBe(13);
    expect(business.has("BR-21")).toBe(true);
    expect(business.has("BR-22")).toBe(true);
    expect(screens.size).toBe(15);
    expect(screens.has("PM-01")).toBe(true);
    expect(screens.has("PM-06")).toBe(true); // 設計書ビューア (2026-06-22 PO 指示で追加)
    expect(screens.has("HM-08")).toBe(true);
    expect(screens.has("GD-01")).toBe(true);
  });

  it("extracts only P0 functional requirements for blocking FR screen trace", () => {
    const p0Fr = extractG1P0FrIds(docs.functional);
    expect(p0Fr.size).toBe(19);
    expect(p0Fr.has("FR-L1-01")).toBe(true);
    expect(p0Fr.has("FR-L1-45")).toBe(true);
    expect(p0Fr.has("FR-L1-46")).toBe(false);
  });

  it("passes the current repo with no G1 trace or L3 requires orphan", () => {
    expect(result.orphanBusiness).toEqual([]);
    expect(result.orphanScreen).toEqual([]);
    expect(result.orphanP0Fr).toEqual([]);
    expect(result.missingL3Requires).toEqual([]);
  });

  it("fails a missing business to screen trace", () => {
    const broken = {
      ...docs,
      screen: docs.screen.replace("| **BR-22** |", "| **BR-XX** |"),
    };
    const r = analyzeG1Trace(broken);
    expect(r.orphanBusiness).toContain("BR-22");
  });

  it("fails L3 plans that omit a required L1 axis", () => {
    const broken = {
      ...docs,
      plans: [
        {
          file: "docs/plans/PLAN-L3-X.md",
          content: [
            "related_l1_screen: docs/design/harness/L1-requirements/screen-requirements.md",
            "PLAN-L1-02-functional-requirements",
            "PLAN-L1-03-screen-requirements",
          ].join("\n"),
        },
      ],
    };
    const r = analyzeG1Trace(broken);
    expect(r.missingL3Requires).toEqual([
      {
        file: "docs/plans/PLAN-L3-X.md",
        missing: ["PLAN-L1-01-business-requirements"],
      },
    ]);
  });
});
