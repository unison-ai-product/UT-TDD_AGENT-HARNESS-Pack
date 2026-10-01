import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateStaticGate } from "../src/gate/static.ts";
import { loadGateConfirmDocs } from "../src/lint/gate-confirm.ts";
import { loadL6CompletionInputs } from "../src/lint/l6-completion.ts";
import { loadL7CompletionDocs } from "../src/lint/l7-completion.ts";
import { loadScreenImplPairFreezeInput } from "../src/lint/screen-impl-pair-freeze.ts";
import { lintPlanWithGate } from "../src/plan/lint.ts";
import { resolveAuthoringSourcePath, resolveVModelRoots } from "../src/shared/design-root.ts";
import { lintVmodel, loadPairDocs } from "../src/vmodel/lint.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "ut-tdd-design-root-"));
}

describe("release consumer design root (PLAN-L7-676 PR-2b)", () => {
  it("U-RCDEV-011: resolves consumer roots, preserves harness priority, and maps catalog paths", () => {
    const root = fixtureRoot();
    try {
      mkdirSync(join(root, "docs", "design"), { recursive: true });
      mkdirSync(join(root, "docs", "test-design"), { recursive: true });
      expect(resolveVModelRoots(root)).toEqual({
        designRoot: "docs/design",
        testDesignRoot: "docs/test-design",
      });
      expect(resolveAuthoringSourcePath(root, "docs/design/harness/L6/x.md")).toBe(
        "docs/design/L6/x.md",
      );
      expect(resolveAuthoringSourcePath(root, "docs/test-design/harness/L7/x.md")).toBe(
        "docs/test-design/L7/x.md",
      );

      mkdirSync(join(root, "docs", "design", "harness"), { recursive: true });
      mkdirSync(join(root, "docs", "test-design", "harness"), { recursive: true });
      expect(resolveVModelRoots(root)).toEqual({
        designRoot: "docs/design/harness",
        testDesignRoot: "docs/test-design/harness",
      });
      expect(resolveAuthoringSourcePath(root, "docs/design/harness/L6/x.md")).toBe(
        "docs/design/harness/L6/x.md",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RCDEV-012: missing document roots return typed results without ENOENT", () => {
    const root = fixtureRoot();
    try {
      const gates = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"];
      for (const gate of gates) {
        const result = evaluateStaticGate({ gate, repoRoot: root });
        expect(result).toMatchObject({ gate, applicable: true, passed: false });
        expect(result.messages.join("\n")).not.toContain("ENOENT");
      }
      expect(loadPairDocs(root)).toEqual([]);
      expect(lintVmodel(undefined, root).messages.join("\n")).not.toContain("ENOENT");
      expect(loadGateConfirmDocs(root)).toEqual({
        gateText: readFileSync(join(headSnapshotRoot(), "docs/governance/gate-design.md"), "utf8"),
        docs: [],
      });
      expect(loadL6CompletionInputs(root).l6Docs).toEqual([]);
      expect(loadL7CompletionDocs(root)).toEqual([]);
      expect(loadScreenImplPairFreezeInput(root).screenDesignPresent).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RCDEV-013: plan lint treats a missing docs/plans directory as zero plans", () => {
    const root = fixtureRoot();
    try {
      const absent = lintPlanWithGate(undefined, root, "schedule");
      expect(absent.ok).toBe(true);
      expect(absent.messages[0]).toContain("checked=0");

      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writeFileSync(
        join(root, "docs", "plans", "PLAN-L7-fixture.md"),
        "---\nplan_id: PLAN-L7-fixture\n---\n",
        "utf8",
      );
      const present = lintPlanWithGate(undefined, root, "schedule");
      expect(present.ok).toBe(true);
      expect(present.messages[0]).toContain("checked=1");
      expect(existsSync(join(root, "docs", "plans"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
