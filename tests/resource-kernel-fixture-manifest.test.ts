import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_FIXTURE_STATUSES,
  analyzeFixtureManifest,
  type FixtureManifest,
  fixtureManifestMessages,
  parseContractSections,
  parseFixtureManifest,
  parseL8FixtureRows,
} from "../src/lint/resource-kernel-fixture-manifest.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

const L8 = "docs/test-design/harness/L8-integration-test-design.md";
const MANIFEST = "docs/test-design/harness/resource-kernel-fixture-manifest.yaml";
const PLAN = "docs/plans/PLAN-L5-25-resource-kernel-physical-protocol.md";

function loadRepoInput() {
  const root = workspaceRead({
    id: "U-RGKFIX",
    mode: "head_snapshot",
    reason: "fixture manifest は HEAD の L8 表・manifest・PLAN 節と突合して判定する",
  });
  return {
    rows: parseL8FixtureRows(readFileSync(join(root, L8), "utf8")),
    manifest: parseFixtureManifest(readFileSync(join(root, MANIFEST), "utf8")),
    contractSections: parseContractSections(readFileSync(join(root, PLAN), "utf8")),
    pathExists: (p: string) => existsSync(join(root, p)),
  };
}

const baseEntry = {
  id: "fx-rgk-frame-split",
  case: "IT-RGK-PHYS-001",
  lane: "mock",
  status: "planned",
  path: "tests/fixtures/resource-kernel/frame-split",
  contractRef: "§2",
  inputs: ["frame bytes"],
  generation: "split and write",
};

function manifestOf(entries: (typeof baseEntry)[]): FixtureManifest {
  return {
    contractDoc: PLAN,
    fixtureRoot: "tests/fixtures/resource-kernel",
    entries,
  };
}

describe("Resource Kernel fixture manifest lint (U-RGKFIX, PLAN-L5-25 §7)", () => {
  it("U-RGKFIX-001: 実 repo の L8 fixture 42 件が manifest と双方向一致し、属性が揃う", () => {
    const input = loadRepoInput();
    expect(input.rows).toHaveLength(42);
    expect(input.manifest.entries).toHaveLength(42);
    const r = analyzeFixtureManifest(input);
    expect(fixtureManifestMessages(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.missingFromManifest).toEqual([]);
    expect(r.danglingInManifest).toEqual([]);
    expect(r.duplicateIds).toEqual([]);
  });

  it("U-RGKFIX-002: 実 repo の 42 件は全て planned で、path は 1 件も実在しない", () => {
    const input = loadRepoInput();
    const r = analyzeFixtureManifest(input);
    // 実装未着地なので materialized は 0。planned の path が実在したら実体の偽装として Red。
    expect(r.statusCounts).toEqual({ planned: 42 });
    expect(r.plannedPathExists).toEqual([]);
    for (const e of input.manifest.entries) {
      expect(ALLOWED_FIXTURE_STATUSES).toContain(e.status);
      expect(input.pathExists(e.path)).toBe(false);
    }
  });

  it("U-RGKFIX-003: planned で path 実在 / materialized で path 不在の双方を fail-close 検出する", () => {
    const rows = [{ case: "IT-RGK-PHYS-001", lane: "mock", fixtureId: "fx-rgk-frame-split" }];
    const plannedButExists = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([baseEntry]),
      contractSections: new Set(["2"]),
      pathExists: () => true,
    });
    expect(plannedButExists.ok).toBe(false);
    expect(plannedButExists.plannedPathExists).toHaveLength(1);

    const materializedButMissing = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([{ ...baseEntry, status: "materialized" }]),
      contractSections: new Set(["2"]),
      pathExists: () => false,
    });
    expect(materializedButMissing.ok).toBe(false);
    expect(materializedButMissing.materializedPathMissing).toHaveLength(1);
  });

  it("U-RGKFIX-004: 欠落・dangling・重複・case/lane 不一致・属性欠落・不明節を検出する", () => {
    const rows = [
      { case: "IT-RGK-PHYS-001", lane: "mock", fixtureId: "fx-rgk-frame-split" },
      { case: "IT-RGK-PHYS-002", lane: "mock", fixtureId: "fx-rgk-predecode-corpus" },
      { case: "IT-RGK-PHYS-003", lane: "mock", fixtureId: "" },
    ];
    const r = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([
        { ...baseEntry, case: "IT-RGK-PHYS-009", lane: "real-OS", contractRef: "§99" },
        { ...baseEntry },
        { ...baseEntry, id: "fx-rgk-not-in-l8" },
        { ...baseEntry, id: "fx-rgk-empty", inputs: [], generation: "", path: "" },
      ]),
      contractSections: new Set(["2"]),
      pathExists: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.missingFromManifest).toContain("fx-rgk-predecode-corpus");
    expect(r.missingFromManifest).toContain("IT-RGK-PHYS-003 (fixture 未記載)");
    expect(r.danglingInManifest).toEqual(["fx-rgk-empty", "fx-rgk-not-in-l8"]);
    expect(r.duplicateIds).toEqual(["fx-rgk-frame-split"]);
    expect(r.caseMismatch).toHaveLength(1);
    expect(r.laneMismatch).toHaveLength(1);
    expect(r.emptyFields).toEqual(["fx-rgk-empty"]);
    expect(r.unknownContractRef).toEqual(["fx-rgk-frame-split: §99"]);
    expect(fixtureManifestMessages(r).length).toBeGreaterThan(5);
  });

  it("U-RGKFIX-005: fixture_root 外の path と status 語彙外を検出する", () => {
    const rows = [{ case: "IT-RGK-PHYS-001", lane: "mock", fixtureId: "fx-rgk-frame-split" }];
    const r = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([{ ...baseEntry, status: "assumed-green", path: "tests/elsewhere/x" }]),
      contractSections: new Set(["2"]),
      pathExists: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.invalidStatus).toEqual(["fx-rgk-frame-split: assumed-green"]);
    expect(r.pathOutsideRoot).toEqual(["fx-rgk-frame-split: tests/elsewhere/x"]);
  });
});
