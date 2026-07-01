import { describe, expect, it } from "vitest";
import {
  detectMode,
  type ExecutionMode,
  NEXT_ACTION_BY_MODE,
  nextActionForMode,
} from "../src/runtime/detect";

describe("detectMode (requirements_v1.2 §7.1)", () => {
  it("returns one of the 4 valid modes", () => {
    const d = detectMode();
    expect(["standalone", "claude-only", "codex-only", "hybrid"]).toContain(d.mode);
    expect(typeof d.claude).toBe("boolean");
    expect(typeof d.codex).toBe("boolean");
  });

  it("hybrid iff both runtimes available", () => {
    const d = detectMode();
    expect(d.mode === "hybrid").toBe(d.claude && d.codex);
  });

  it("uses provider spawnability rather than command-name presence", () => {
    const d = detectMode({
      env: {},
      isProviderSpawnable: (provider) => provider === "claude",
    });

    expect(d).toMatchObject({
      mode: "claude-only",
      claude: true,
      codex: false,
      availableRuntimes: ["claude"],
      missingRuntimes: ["codex"],
    });
  });

  it("keeps current runtime env signals separate from provider availability", () => {
    const d = detectMode({
      env: { CODEX_HOME: "/tmp/codex" },
      isProviderSpawnable: () => false,
    });

    expect(d).toMatchObject({
      mode: "standalone",
      codex: false,
      currentRuntime: "codex",
      availableRuntimes: [],
      missingRuntimes: ["claude", "codex"],
    });
  });
});

describe("nextActionForMode (PLAN-L7-84 / A-138 ITEM-1, requirements §6)", () => {
  const MODES: ExecutionMode[] = ["standalone", "claude-only", "codex-only", "hybrid"];

  it("U-DETECT-001: maps every mode to a defined judgment-gate guidance", () => {
    for (const mode of MODES) {
      expect(nextActionForMode(mode)).toBe(NEXT_ACTION_BY_MODE[mode]);
      expect(nextActionForMode(mode).length).toBeGreaterThan(0);
    }
  });

  it("U-DETECT-002: standalone requires human review (judgment gates cannot auto-pass)", () => {
    expect(nextActionForMode("standalone")).toMatch(/^human-review-required:/);
  });

  it("U-DETECT-003: single-runtime modes ask for intra_runtime_subagent evidence", () => {
    expect(nextActionForMode("claude-only")).toMatch(/^single-runtime:/);
    expect(nextActionForMode("codex-only")).toMatch(/^single-runtime:/);
    expect(nextActionForMode("claude-only")).toContain("intra_runtime_subagent");
  });

  it("U-DETECT-004: hybrid routes judgment gates to a cross-runtime reviewer", () => {
    expect(nextActionForMode("hybrid")).toMatch(/^cross-review-ready:/);
  });

  it("U-DETECT-005: every value is a machine-switchable token + human guidance (ASCII)", () => {
    for (const mode of MODES) {
      const value = nextActionForMode(mode);
      // 先頭 token (`:` 手前) で機械 switch でき、JSON 公開契約として ASCII のみ。
      expect(value).toMatch(/^[a-z][a-z-]*: .+/);
      expect([...value].every((ch) => ch.charCodeAt(0) <= 127)).toBe(true);
    }
  });
});
