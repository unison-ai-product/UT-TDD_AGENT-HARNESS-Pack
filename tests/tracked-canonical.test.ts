// PLAN-REVERSE-41 塊B: git tracked top-level ⊆ repository-structure.md canonical の突合 (IMP-127)。
// NEW 未記載 top-level (canonical ツリーに無い tracked 物) を fail-close。現 drift 0 (baseline 空)。
import { describe, expect, it } from "vitest";
import {
  analyzeTrackedCanonical,
  loadTrackedCanonicalInput,
  TRACKED_CANONICAL_BASELINE,
} from "../src/lint/tracked-canonical";

describe("analyzeTrackedCanonical (U-TCAN-001..003)", () => {
  const canonicalText = "src/ tests/ docs/ scripts/ .ut-tdd/ .claude/ vendor/";

  it("U-TCAN-001: canonical 未記載かつ baseline 外の tracked top-level = drift (NEW fail-close)", () => {
    const r = analyzeTrackedCanonical({
      trackedTopLevels: ["src", "rogue-dir"],
      canonicalText,
      baseline: new Set(),
    });
    expect(r.drift).toEqual(["rogue-dir"]);
    expect(r.ok).toBe(false);
  });

  it("U-TCAN-002: canonical 記載済 top-level は drift でない", () => {
    const r = analyzeTrackedCanonical({
      trackedTopLevels: ["src", "tests", "docs"],
      canonicalText,
      baseline: new Set(),
    });
    expect(r.drift).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("U-TCAN-003: baseline 済 top-level は drift でない (known-exception)", () => {
    const r = analyzeTrackedCanonical({
      trackedTopLevels: ["legacy-thing"],
      canonicalText,
      baseline: new Set(["legacy-thing"]),
    });
    expect(r.drift).toHaveLength(0);
  });
});

describe("loadTrackedCanonicalInput real repo (U-TCAN-004/005)", () => {
  it("U-TCAN-004: 実 repo の drift は 0 (全 tracked top-level が repository-structure.md 記載、fail-close 回帰網)", () => {
    const r = analyzeTrackedCanonical(loadTrackedCanonicalInput(process.cwd()));
    expect(r.drift).toEqual([]);
  });

  it("U-TCAN-005: baseline は空 (現 drift 0、known-exception なし)", () => {
    expect(TRACKED_CANONICAL_BASELINE.size).toBe(0);
  });
});
