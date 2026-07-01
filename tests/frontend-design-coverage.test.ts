// PLAN-L4-14 §4: §1c FE/UI 設計 doc カバレッジ (設計左腕) の機械検証 gate。
// 右腕 proposal-document-coverage と対称。slot 登録 = body 完成ではない (coverage ≠ substance)。
import { describe, expect, it } from "vitest";
import {
  analyzeFrontendDesignCoverage,
  DESCENT_MARKER,
  FE_COVERAGE_MAP,
  type FeCoverageLayer,
  frontendDesignCoverageMessages,
  loadFrontendDesignCoverageInput,
  SECTION_MARKER,
} from "../src/lint/frontend-design-coverage";
import { VALID_SUB_DOCS } from "../src/schema/index";

// FE_COVERAGE_MAP 全 slug を含み marker を持つ最小の正常 mapDocText。
function okMapText(): string {
  const slugs = FE_COVERAGE_MAP.map((e) => e.slug).join(" ");
  return `... ${SECTION_MARKER} ... ${DESCENT_MARKER} ... ${slugs} ...`;
}

// FE_COVERAGE_MAP の body=present の presentFile を全て実在扱いにする集合。
function allPresent(): Set<string> {
  return new Set(
    FE_COVERAGE_MAP.filter((e) => e.body === "present" && e.presentFile).map(
      (e) => e.presentFile as string,
    ),
  );
}

describe("analyzeFrontendDesignCoverage (U-FEDC-001..006)", () => {
  it("U-FEDC-001: schema 登録済 + 全 present doc 実在 + §1c marker 完備 → ok", () => {
    const r = analyzeFrontendDesignCoverage({
      schema: VALID_SUB_DOCS as Record<string, readonly string[]>,
      mapDocText: okMapText(),
      existingPresentFiles: allPresent(),
    });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.registeredSlugs).toBe(FE_COVERAGE_MAP.length);
  });

  it("U-FEDC-002: FE slug が VALID_SUB_DOCS から消える → unregistered-slug violation", () => {
    const coverage: FeCoverageLayer[] = [{ layer: "L6", slug: "screen-spec", body: "pending" }];
    const r = analyzeFrontendDesignCoverage({
      schema: { L6: ["function-spec", "class-design", "edge-case"] }, // screen-spec 欠落
      mapDocText: okMapText(),
      existingPresentFiles: new Set(),
      coverage,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("unregistered-slug");
  });

  it("U-FEDC-003: body=present の設計 doc が実在しない → missing-present-doc violation", () => {
    const coverage: FeCoverageLayer[] = [
      { layer: "L4", slug: "ui-standard", presentFile: "docs/x/ui-standard.md", body: "present" },
    ];
    const r = analyzeFrontendDesignCoverage({
      schema: { L4: ["ui-standard"] },
      mapDocText: `${SECTION_MARKER} ${DESCENT_MARKER} ui-standard`,
      existingPresentFiles: new Set(), // ファイル不在
      coverage,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("missing-present-doc");
  });

  it("U-FEDC-004: slug が §1c doc に記載されない → slug-not-in-map violation", () => {
    const coverage: FeCoverageLayer[] = [{ layer: "L5", slug: "ui-detail", body: "pending" }];
    const r = analyzeFrontendDesignCoverage({
      schema: { L5: ["ui-detail"] },
      mapDocText: `${SECTION_MARKER} ${DESCENT_MARKER}`, // ui-detail を含まない
      existingPresentFiles: new Set(),
      coverage,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("slug-not-in-map");
  });

  it("U-FEDC-005: §1c section / descent 鎖 marker が消える → missing-section + missing-descent-chain", () => {
    const coverage: FeCoverageLayer[] = [{ layer: "L5", slug: "ui-detail", body: "pending" }];
    const r = analyzeFrontendDesignCoverage({
      schema: { L5: ["ui-detail"] },
      mapDocText: "ui-detail のみ、marker 無し",
      existingPresentFiles: new Set(),
      coverage,
    });
    expect(r.ok).toBe(false);
    const kinds = r.violations.map((v) => v.kind);
    expect(kinds).toContain("missing-section");
    expect(kinds).toContain("missing-descent-chain");
    expect(frontendDesignCoverageMessages(r)[0]).toContain("PLAN-L4-14");
  });

  it("U-FEDC-006: messages は ok 時に present/pending 件数を出す", () => {
    const r = analyzeFrontendDesignCoverage({
      schema: VALID_SUB_DOCS as Record<string, readonly string[]>,
      mapDocText: okMapText(),
      existingPresentFiles: allPresent(),
    });
    expect(frontendDesignCoverageMessages(r)[0]).toContain("frontend-design-coverage — OK");
    expect(frontendDesignCoverageMessages(r)[0]).toContain("drift 0");
    expect(r.presentBodies).toBe(6);
    expect(r.pendingBodies).toBe(0);
  });
});

describe("loadFrontendDesignCoverageInput real repo (U-FEDC-007)", () => {
  it("U-FEDC-007: 実 repo の §1c FE カバレッジが schema↔§1c↔実ファイルで drift 0 (回帰固定)", () => {
    const r = analyzeFrontendDesignCoverage(loadFrontendDesignCoverageInput(process.cwd()));
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-FEDC-008: L3 screen-functional / L5 ui-detail / L6 screen-spec が登録済 (定義→slot 完了)", () => {
    expect(VALID_SUB_DOCS.L3 as readonly string[]).toContain("screen-functional");
    expect(VALID_SUB_DOCS.L5 as readonly string[]).toContain("ui-detail");
    expect(VALID_SUB_DOCS.L6 as readonly string[]).toContain("screen-spec");
    expect(FE_COVERAGE_MAP.find((e) => e.layer === "L3")?.body).toBe("present");
    expect(FE_COVERAGE_MAP.find((e) => e.layer === "L5")?.body).toBe("present");
    expect(FE_COVERAGE_MAP.find((e) => e.layer === "L6")?.body).toBe("present");
  });
});
