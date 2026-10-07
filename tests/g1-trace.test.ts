import { describe, expect, it } from "vitest";
import {
  analyzeG1Trace,
  extractG1BusinessIds,
  extractG1BusinessTrace,
  extractG1P0FrIds,
  extractG1ScreenIds,
  g1TraceOk,
  loadG1TraceDocs,
} from "../src/lint/g1-trace.ts";

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

  it("accepts plain and bold first-cell IDs without over-extracting references", () => {
    const business = extractG1BusinessIds(
      [
        "| BR-01 | plain business requirement |",
        "| **BR-02** | bold business requirement |",
        "| UX-03 | plain UX requirement |",
        "| **UX-04** | bold UX requirement |",
        "| **ID** | BR-21 |",
        "prose refers to BR-05",
        "| related requirement | BR-06 |",
        "| description | **UX-07** |",
        "| related requirement | **ID** | BR-08 |",
        "| BR-1 | invalid short ID |",
        "| BR-001 | invalid long ID |",
        "| XBR-09 | invalid prefix |",
        "| **BR-10 | unbalanced emphasis |",
        "|",
        "**BR-11** | ID on the next line |",
        "|",
        "**ID** | BR-12 | legacy marker on the next line |",
      ].join("\n"),
    );

    expect([...business]).toEqual(["BR-01", "BR-02", "UX-03", "UX-04", "BR-21"]);
  });

  it("traces plain and bold business IDs in the leading table cell", () => {
    const screen = [
      "## §1 Screen overview",
      "| PM-01 | Main screen |",
      "## §2 Details",
      "### §5.1 BR/UX to screen trace",
      "| BR-01 | PM-01 |",
      "| **UX-02** | PM-01 |",
      "| related requirement | BR-03 |",
      "| description | **BR-04** |",
      "| **BR-05 | PM-01 |",
      "| BR-006 | PM-01 |",
      "### §5.3 Functional trace",
      "### §5.5 Screen trace",
      "| **PM-01** | BR-01 |",
      "### §5.6 Details",
    ].join("\n");
    const trace = extractG1BusinessTrace(screen);

    expect([...trace.keys()]).toEqual(["BR-01", "UX-02"]);
    expect([...(trace.get("BR-01") ?? [])]).toEqual(["PM-01"]);
    expect([...(trace.get("UX-02") ?? [])]).toEqual(["PM-01"]);
  });

  it("analyzes a plain-authored BR trace with the existing screen-table format", () => {
    const plainDocs = {
      business: ["| BR-01 | Plain requirement |"].join("\n"),
      functional: "",
      screen: [
        "## §1 Screen overview",
        "| PM-01 | Main screen |",
        "## §2 Details",
        "### §5.1 BR/UX to screen trace",
        "| BR-01 | PM-01 |",
        "### §5.3 Functional trace",
        "### §5.5 Screen trace",
        "| **PM-01** | BR-01 |",
        "### §5.6 Details",
      ].join("\n"),
      plans: [],
    };

    const result = analyzeG1Trace(plainDocs);
    expect(result.totals.screen).toBe(1);
    expect(result.orphanBusiness).toEqual([]);
    expect(g1TraceOk(result)).toBe(true);
  });

  it("preserves Unicode horizontal whitespace around a leading business ID", () => {
    const trace = extractG1BusinessTrace(
      [
        "## §1 Screen overview",
        "| PM-01 | Main screen |",
        "## §2 Details",
        "### §5.1 BR/UX to screen trace",
        "|　**BR-01**　| PM-01 |",
        "### §5.3 Functional trace",
      ].join("\n"),
    );

    expect([...trace.keys()]).toEqual(["BR-01"]);
    expect([...(trace.get("BR-01") ?? [])]).toEqual(["PM-01"]);
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
