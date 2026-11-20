import { describe, expect, it } from "vitest";
import {
  reconcileDispositionTarget,
  resolveCanonicalTarget,
  type TargetKind,
  type TargetRegistry,
} from "../../src/disposition/domain/target-resolver.ts";

const registry: TargetRegistry = {
  pathAliases: { "a.md": ["docs/a.md"] },
  trackedPaths: new Set(["docs/a.md", "docs/family/a.md", "docs/family/b.md"]),
  familyMembers: {
    "docs/family/": ["docs/family/a.md", "docs/family/b.md"],
  },
  targetSlots: new Set(["DOC-L4-BATCH"]),
};

describe("canonical target resolver", () => {
  it("U-TARGET-001: resolves all three typed target kinds without filesystem inference", () => {
    expect(
      resolveCanonicalTarget({ kind: "artifact_path", ref: "docs/a.md" }, registry),
    ).toMatchObject({
      ok: true,
    });
    expect(resolveCanonicalTarget({ kind: "artifact_path", ref: "a.md" }, registry)).toMatchObject({
      ok: true,
      value: { canonicalRefs: ["docs/a.md"] },
    });
    expect(
      resolveCanonicalTarget({ kind: "artifact_family", ref: "docs/family/" }, registry),
    ).toMatchObject({
      ok: true,
      value: { canonicalRefs: ["docs/family/a.md", "docs/family/b.md"] },
    });
    expect(
      resolveCanonicalTarget({ kind: "target_slot", ref: "DOC-L4-BATCH" }, registry),
    ).toMatchObject({
      ok: true,
    });
  });

  it("U-TARGET-002: accepts a unique source disposition basename alias for a tracked path", () => {
    expect(
      reconcileDispositionTarget(
        {
          displayRef: "a.md",
          edge: { kind: "artifact_path", ref: "docs/a.md" },
        },
        registry,
      ),
    ).toEqual({
      ok: true,
      value: ["docs/a.md"],
    });
  });

  it("U-DISPPTR-002: rejects retired plan_alias as an unknown target kind", () => {
    const result = resolveCanonicalTarget(
      { kind: "plan_alias" as unknown as TargetKind, ref: "PLAN-L0-01" },
      registry,
    );
    expect(result.ok).toBe(false);
  });

  it("U-TARGET-003: fails closed for unresolved, ambiguous, and absent targets", () => {
    const ambiguous: TargetRegistry = {
      ...registry,
      pathAliases: { ...registry.pathAliases, SAME: ["docs/a.md", "docs/family/a.md"] },
    };
    expect(resolveCanonicalTarget({ kind: "artifact_path", ref: "SAME" }, ambiguous)).toMatchObject(
      {
        ok: false,
        findings: [{ ruleId: "target-ambiguous" }],
      },
    );
    expect(
      resolveCanonicalTarget({ kind: "artifact_path", ref: "docs/missing.md" }, registry),
    ).toMatchObject({
      ok: false,
      findings: [{ ruleId: "target-existence-missing" }],
    });
    expect(
      resolveCanonicalTarget({ kind: "artifact_family", ref: "docs/missing/" }, registry),
    ).toMatchObject({ ok: false, findings: [{ ruleId: "target-unresolved" }] });
  });

  it("U-TARGET-004: rejects phantom family members and canonical mismatches", () => {
    const phantom: TargetRegistry = {
      ...registry,
      familyMembers: { "docs/family/": ["docs/family/a.md", "docs/phantom.md"] },
    };
    expect(
      resolveCanonicalTarget({ kind: "artifact_family", ref: "docs/family/" }, phantom),
    ).toMatchObject({ ok: false, findings: [{ ruleId: "target-existence-missing" }] });
    expect(
      reconcileDispositionTarget(
        { displayRef: "PLAN-L0-01", edge: { kind: "artifact_path", ref: "docs/a.md" } },
        registry,
      ),
    ).toMatchObject({ ok: false, findings: [{ ruleId: "target-canonical-mismatch" }] });
  });
});
