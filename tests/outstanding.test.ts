import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeOutstandingWork,
  computeOutstandingWork,
  outstandingSummaryLine,
} from "../src/lint/outstanding.ts";
import { analyzePlaceholderDeps, loadPlaceholderDepsDocs } from "../src/lint/placeholder-deps.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// IMP-139: open defer の additive surface 回帰。

describe("analyzeOutstandingWork", () => {
  it("負の openDefers は 0 にクランプする", () => {
    const o = analyzeOutstandingWork(-5);
    expect(o.openDefers).toBe(0);
  });
});

describe("outstandingSummaryLine", () => {
  it("open defer の 1 行サマリ", () => {
    expect(outstandingSummaryLine({ openDefers: 1 })).toBe("outstanding: open defers=1");
  });
});

describe("computeOutstandingWork", () => {
  function makeDualRootOutstandingRepo(): {
    root: string;
    planPath: string;
    designPath: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-planret-012-outstanding-"));
    const planPath = join(root, "docs", "plans", "x.md");
    const designPath = join(root, "docs", "design", "harness", "L6-function-design", "y.md");
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "design", "harness", "L6-function-design"), {
      recursive: true,
    });
    writeFileSync(
      planPath,
      [
        "---",
        "layer: L7",
        "status: draft",
        "---",
        "PLAN fixture",
        "- FR-L1-46 explicit_l7_defer waiting_layer:L6 owner:tl",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      designPath,
      [
        "---",
        "status: confirmed",
        "---",
        "- FR-L1-47 explicit_l7_defer waiting_layer:L6 owner:tl",
        "- placeholder_deps: {waiting_layer:L6, waiting_spec: candidate012 fixture}",
      ].join("\n"),
      "utf8",
    );
    return { root, planPath, designPath };
  }

  it("design/test-design 不在は open defer を 0 にする (fail-open)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-outstanding-empty-"));
    try {
      const o = computeOutstandingWork(root);
      expect(o.openDefers).toBe(0);
    } finally {
      removeTestTree(root);
    }
  });

  it("one design open defer is counted", () => {
    const fixture = makeDualRootOutstandingRepo();
    try {
      expect(readFileSync(fixture.designPath, "utf8")).toContain("FR-L1-47 explicit_l7_defer");
      expect(readFileSync(fixture.designPath, "utf8")).toContain("waiting_layer:L6");
      expect(analyzePlaceholderDeps(loadPlaceholderDepsDocs(fixture.root)).specBackfillWaits).toBe(
        1,
      );
      expect(computeOutstandingWork(fixture.root).openDefers).toBe(1);
    } finally {
      removeTestTree(fixture.root);
    }
  });

  it("U-PLANRET-012(b): computeOutstandingWork exposes only openDefers", () => {
    const fixture = makeDualRootOutstandingRepo();
    try {
      expect(computeOutstandingWork(fixture.root)).toEqual({ openDefers: 1 });
    } finally {
      removeTestTree(fixture.root);
    }
  });
});
