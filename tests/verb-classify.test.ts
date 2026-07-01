import { describe, expect, it } from "vitest";
import { classifyVerificationVerb } from "../src/runtime/verb-classify";

describe("verb-classify (PLAN-RECOVERY-05 item 2) — Bash → 検証 verb 正規化", () => {
  // Codex cross-review 検証観点 1: bun / npm / npx / direct binary が同じ verb に落ちる。
  it("normalizes bun/npm/npx/direct invocations of the same tool to one verb", () => {
    expect(classifyVerificationVerb("bun run vitest run tests/x")).toBe("vitest");
    expect(classifyVerificationVerb("npx vitest run")).toBe("vitest");
    expect(classifyVerificationVerb("vitest run tests/y")).toBe("vitest");
    expect(classifyVerificationVerb("npm exec -- vitest")).toBe("vitest");
  });

  // 検証観点 2: 引数違いの連続失敗が同一 verb (= 同一ループ) として拾える。
  it("groups different-argument runs of the same tool under one verb", () => {
    expect(classifyVerificationVerb("bun run vitest run tests/a.test.ts")).toBe(
      classifyVerificationVerb("bun run vitest run tests/b.test.ts"),
    );
  });

  // 検証観点 3: 異なる検証系を誤併合しない。
  it("does not mis-merge different verification systems", () => {
    const verbs = new Set([
      classifyVerificationVerb("bun run vitest run"),
      classifyVerificationVerb("bun run typecheck"),
      classifyVerificationVerb("bun src/cli.ts doctor"),
    ]);
    expect(verbs.size).toBe(3);
    expect(classifyVerificationVerb("tsc --noEmit")).toBe("tsc");
    expect(classifyVerificationVerb("bun run typecheck")).toBe("tsc");
    expect(classifyVerificationVerb("ut-tdd doctor")).toBe("doctor");
  });

  it("classifies lint via biome and via the run-lint script alias", () => {
    expect(classifyVerificationVerb("biome check src")).toBe("lint");
    expect(classifyVerificationVerb("bun run lint")).toBe("lint");
  });

  it("prefers the explicit tool over a path that merely contains a keyword", () => {
    // path に lint を含むが vitest 実行 → vitest を採る (順序: vitest が lint より先)。
    expect(classifyVerificationVerb("bun run vitest run tests/lint-rules.test.ts")).toBe("vitest");
  });

  // 未分類コマンドは null (強引に併合しない = escalation 対象外)。
  it("returns null for unclassified commands (no force-merge)", () => {
    expect(classifyVerificationVerb("git status")).toBeNull();
    expect(classifyVerificationVerb("ls -la")).toBeNull();
    expect(classifyVerificationVerb("echo hello")).toBeNull();
    expect(classifyVerificationVerb("")).toBeNull();
  });
});
