import { describe, expect, it } from "vitest";
import {
  analyzeDeliverablePlanTrace,
  analyzeDeliverableTraceGate,
  isDeliverableArtifactPath,
} from "../src/lint/deliverable-plan-trace.ts";

describe("PLAN-L7-450 W4/W3 deliverable trace", () => {
  it("U-L7-450-W4-001: a new orphan test file fails closed and a declared file is green", () => {
    const orphan = analyzeDeliverablePlanTrace({
      artifactFiles: ["tests/new.test.ts"],
      tracedPaths: new Set(),
      baseline: new Map(),
    });
    expect(orphan.ok).toBe(false);
    expect(orphan.findings).toContainEqual(
      expect.objectContaining({ kind: "orphan-deliverable", artifactPath: "tests/new.test.ts" }),
    );
    expect(
      analyzeDeliverablePlanTrace({
        artifactFiles: ["tests/new.test.ts"],
        tracedPaths: new Set(["tests/new.test.ts"]),
        baseline: new Map(),
      }).ok,
    ).toBe(true);
  });

  it("U-L7-450-W3-001: ledger and untraced deliverables must agree in both directions", () => {
    const result = analyzeDeliverablePlanTrace({
      artifactFiles: ["scripts/legacy.ts"],
      tracedPaths: new Set(),
      baseline: new Map([[".claude/removed.md", "PLAN-OLD"]]),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "orphan-deliverable",
      "stale-deliverable-trace-debt",
    ]);
  });

  it("U-L7-450-W3-002: ignores gitignored Claude runtime state in every workspace", () => {
    expect(isDeliverableArtifactPath(".claude/agent-memory/reviewer/MEMORY.md")).toBe(false);
    expect(isDeliverableArtifactPath(".claude/settings.local.json")).toBe(false);
    expect(isDeliverableArtifactPath(".claude/scheduled_tasks.lock")).toBe(false);
    expect(isDeliverableArtifactPath(".claude/agents/code-reviewer.md")).toBe(true);
  });

  it("U-L7-450-W2-003: duplicate ownership shares the same fail-closed gate finding set", () => {
    const result = analyzeDeliverableTraceGate({
      artifactFiles: ["scripts/new.ts"],
      tracedPaths: new Set(["scripts/new.ts"]),
      ownersByPath: new Map([["scripts/new.ts", ["PLAN-A", "PLAN-B"]]]),
      baseline: new Map(),
      ownershipBaseline: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: "duplicate-artifact-ownership",
        artifactPath: "scripts/new.ts",
      }),
    );
  });

  it("U-L7-450-W2-004: duplicate baseline is bidirectional and independent from orphan debt", () => {
    const green = analyzeDeliverableTraceGate({
      artifactFiles: ["scripts/owned.ts"],
      tracedPaths: new Set(["scripts/owned.ts"]),
      ownersByPath: new Map([["scripts/owned.ts", ["PLAN-A", "PLAN-B"]]]),
      baseline: new Map(),
      ownershipBaseline: new Set(["scripts/owned.ts"]),
    });
    expect(green.ok).toBe(true);
    expect(
      analyzeDeliverableTraceGate({
        ...green,
        artifactFiles: ["scripts/owned.ts"],
        tracedPaths: new Set(["scripts/owned.ts"]),
        ownersByPath: new Map([["scripts/owned.ts", ["PLAN-A"]]]),
        baseline: new Map(),
        ownershipBaseline: new Set(["scripts/owned.ts"]),
      }).findings,
    ).toContainEqual(
      expect.objectContaining({
        kind: "stale-deliverable-trace-debt",
        artifactPath: "scripts/owned.ts",
      }),
    );
  });
});
