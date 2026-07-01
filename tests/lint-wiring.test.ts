import { describe, expect, it } from "vitest";
import {
  analyzeLintWiring,
  DEFERRED_LINTS,
  extractImportSpecs,
  type LintWiringInput,
  lintWiringMessages,
  loadLintWiringInput,
} from "../src/lint/lint-wiring";

function input(lintModules: string[], reachableModules: string[]): LintWiringInput {
  return {
    lintModules,
    reachable: new Set(reachableModules.map((m) => `src/lint/${m}.ts`)),
  };
}

describe("analyzeLintWiring (pure)", () => {
  it("all lint modules reachable from a runtime path = ok, none dead", () => {
    const r = analyzeLintWiring(input(["alpha", "beta"], ["alpha", "beta"]));
    expect(r.ok).toBe(true);
    expect(r.wired).toEqual(["alpha", "beta"]);
    expect(r.unwired).toEqual([]);
    expect(r.deferred).toEqual([]);
  });

  it("an unreachable non-deferred module = dead rule = violation", () => {
    const r = analyzeLintWiring(input(["alpha", "ghost"], ["alpha"]));
    expect(r.ok).toBe(false);
    expect(r.unwired).toEqual(["ghost"]);
    expect(lintWiringMessages(r)[0]).toContain("未配線");
    expect(lintWiringMessages(r)[0]).toContain("ghost");
  });

  it("an unreachable module that is DEFERRED-listed = tolerated (ok)", () => {
    // tool-adapter is the real deferred entry; not reachable here → classified deferred, ok.
    const r = analyzeLintWiring(input(["alpha", "tool-adapter"], ["alpha"]));
    expect(r.ok).toBe(true);
    expect(r.deferred).toEqual(["tool-adapter"]);
    expect(r.unwired).toEqual([]);
    expect(lintWiringMessages(r)[0]).toContain("tool-adapter");
  });

  it("a DEFERRED module that is actually reachable = stale declaration = violation", () => {
    const r = analyzeLintWiring(input(["tool-adapter"], ["tool-adapter"]));
    expect(r.ok).toBe(false);
    expect(r.staleDeferred).toEqual(["tool-adapter"]);
    expect(lintWiringMessages(r)[0]).toContain("stale-deferred");
  });

  it("DEFERRED_LINTS entries each carry a non-empty reason", () => {
    for (const [name, reason] of Object.entries(DEFERRED_LINTS)) {
      expect(name.length).toBeGreaterThan(0);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("extractImportSpecs (comment-stripping robustness)", () => {
  it("ignores commented-out imports so a dead module is not falsely counted as wired", () => {
    const content = [
      'import { real } from "../lint/alpha";',
      '// import { fake } from "../lint/line-commented";',
      '/* import { blk } from "../lint/block-commented"; */',
    ].join("\n");
    const specs = extractImportSpecs(content);
    expect(specs).toContain("../lint/alpha");
    expect(specs).not.toContain("../lint/line-commented");
    expect(specs).not.toContain("../lint/block-commented");
  });

  it("captures sibling ./ imports + dynamic import()/require() (real reachability edges)", () => {
    const content = [
      'import { x } from "./fr-registry-audit";',
      'const y = await import("./improvement-backlog");',
      'const z = require("./doc-consistency");',
    ].join("\n");
    expect(extractImportSpecs(content)).toEqual(
      expect.arrayContaining(["./fr-registry-audit", "./improvement-backlog", "./doc-consistency"]),
    );
  });
});

describe("loadLintWiringInput (live repo regression fence)", () => {
  it("every src/lint module is reachable or DEFERRED, and the 4 re-wired audits are reachable", () => {
    const r = analyzeLintWiring(loadLintWiringInput());
    // No dead rules; tool-adapter is the only intentional deferral.
    expect(r.unwired).toEqual([]);
    expect(r.staleDeferred).toEqual([]);
    expect(r.deferred).toEqual(["tool-adapter"]);
    expect(r.ok).toBe(true);
    // The audits this PLAN re-wired into doctor are now genuinely reachable.
    for (const m of [
      "doc-consistency",
      "entity-coverage",
      "fr-registry-audit",
      "improvement-backlog",
      "lint-wiring",
      "proposal-document-coverage",
    ]) {
      expect(r.wired).toContain(m);
    }
  });
});
