import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProviderHandover,
  type ProviderHandoverDeps,
  readProviderHandoverCurrent,
  runProviderHandover,
} from "../src/runtime/provider-handover";

const NOW = "2026-06-08T00:00:00.000Z";

function deps(): ProviderHandoverDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    repoRoot: "/repo",
    now: () => NOW,
    readText: (p) => files.get(p) ?? null,
    writeText: (p, c) => files.set(p, c),
  };
}

describe("provider handover", () => {
  it("U-PHOVER-002: builds a Claude to Codex mechanical package with sanitized context", () => {
    const pkg = buildProviderHandover(
      {
        from: "claude",
        to: "codex",
        activePlan: "PLAN-L4-99-provider-handover",
        budget: "token=secret123",
        summary: "continue without token=secret123",
        nextActions: ["implement provider handover"],
        files: ["src/runtime/provider-handover.ts"],
      },
      NOW,
    );
    expect(pkg.schema_version).toBe("provider-handover.v1");
    expect(pkg.handover_kind).toBe("mechanical");
    expect(pkg.from).toBe("claude");
    expect(pkg.to).toBe("codex");
    expect(JSON.stringify(pkg)).not.toContain("secret123");
  });

  it("rejects same-provider handover", () => {
    expect(() =>
      buildProviderHandover(
        {
          from: "codex",
          to: "codex",
          activePlan: "PLAN-L4-99-provider-handover",
          summary: "x",
        },
        NOW,
      ),
    ).toThrow(/different/);
  });

  it("writes package and CURRENT.json under .ut-tdd/handover/provider", () => {
    const d = deps();
    const result = runProviderHandover(
      {
        from: "codex",
        to: "claude",
        activePlan: "PLAN-L4-99-provider-handover",
        summary: "handoff",
      },
      d,
    );
    expect(result.written).toContain(join(".ut-tdd", "handover", "provider", "CURRENT.json"));
    const current = readProviderHandoverCurrent(d);
    expect(current?.handover_id).toBe(result.package.handover_id);
  });

  it("dry-run does not write files", () => {
    const d = deps();
    const result = runProviderHandover(
      {
        from: "codex",
        to: "claude",
        activePlan: "PLAN-L4-99-provider-handover",
        summary: "handoff",
        dryRun: true,
      },
      d,
    );
    expect(result.written).toEqual([]);
    expect(d.files.size).toBe(0);
  });
});
