import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProviderHandover,
  type ProviderHandoverDeps,
  readProviderHandoverCurrent,
  runProviderHandover,
} from "../src/runtime/provider-handover.ts";

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
  it("U-PHOVER-001: builds a Claude to Codex mechanical package with sanitized context", () => {
    const pkg = buildProviderHandover(
      {
        from: "claude",
        to: "codex",
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
    expect(pkg.active_plan).toBeNull();
    expect(pkg.handover_id).toBe("20260608000000-claude-to-codex");
    expect(JSON.stringify(pkg)).not.toContain("secret123");
  });

  it("U-PHOVER-001: rejects same-provider handover", () => {
    expect(() =>
      buildProviderHandover(
        {
          from: "codex",
          to: "codex",
          summary: "x",
        },
        NOW,
      ),
    ).toThrow(/different/);
  });

  it("U-PHOVER-001: rejects a blank summary", () => {
    expect(() => buildProviderHandover({ from: "claude", to: "codex", summary: " " }, NOW)).toThrow(
      /summary/,
    );
  });

  it("U-PHOVER-002: writes package and CURRENT.json under .ut-tdd/handover/provider", () => {
    const d = deps();
    const result = runProviderHandover(
      {
        from: "codex",
        to: "claude",
        summary: "handoff",
      },
      d,
    );
    expect(result.written).toContain(join(".ut-tdd", "handover", "provider", "CURRENT.json"));
    const current = readProviderHandoverCurrent(d);
    expect(current?.handover_id).toBe(result.package.handover_id);
  });

  it("U-PHOVER-002: dry-run does not write files", () => {
    const d = deps();
    const result = runProviderHandover(
      {
        from: "codex",
        to: "claude",
        summary: "handoff",
        dryRun: true,
      },
      d,
    );
    expect(result.written).toEqual([]);
    expect(d.files.size).toBe(0);
  });
});
