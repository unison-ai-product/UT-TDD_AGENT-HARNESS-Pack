import { describe, expect, it } from "vitest";
import { buildAdapterPlan } from "../src/runtime/adapter.ts";
import {
  DELEGATION_ROLE_ALLOWLIST,
  MODEL_IDS,
  resolveDelegationRouting,
} from "../src/team/delegation-routing.ts";

describe("delegation routing (PLAN-L7-255)", () => {
  it("U-DELEG-001: unknown role fail-closes with the allowlist named", () => {
    const r = resolveDelegationRouting({
      provider: "codex",
      role: "bogus-role",
      task: "ping",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("bogus-role");
      expect(r.message).toContain("Allowed:");
    }
  });

  it("U-DELEG-002: review-gate roles route to the frontier reviewer tier, not the worker tier", () => {
    const codex = resolveDelegationRouting({
      provider: "codex",
      role: "blind-reviewer",
      task: "review the diff",
    });
    expect(codex).toMatchObject({
      ok: true,
      model: MODEL_IDS.codex.frontier,
      model_source: "review-lane",
      review_lane: "blind-review",
      effort: "low", // sol の ladder base
    });
    const claude = resolveDelegationRouting({
      provider: "claude",
      role: "code-reviewer",
      task: "review the diff",
    });
    expect(claude).toMatchObject({
      ok: true,
      model: MODEL_IDS.claude.opus,
      review_lane: "implementation-review",
      effort: "middle", // opus の ladder base
    });
  });

  it("U-DELEG-008: subagent-form gate roles (ut-tdd-tl/qa-test/security-audit) stay on the frontier reviewer tier", () => {
    // 2026-07-16 クロスレビュー指摘 1: allowlist 合流で許可される subagent 形 gate role が
    // worker tier (terra) へ落ちる欠陥の regression。opus/frontier floor を固定する。
    for (const role of ["ut-tdd-tl", "qa-test", "security-audit"]) {
      const codex = resolveDelegationRouting({ provider: "codex", role, task: "the module" });
      expect(codex).toMatchObject({
        ok: true,
        model: MODEL_IDS.codex.frontier,
        model_source: "review-lane",
      });
      const claude = resolveDelegationRouting({ provider: "claude", role, task: "the module" });
      expect(claude).toMatchObject({
        ok: true,
        model: MODEL_IDS.claude.opus,
        model_source: "review-lane",
      });
    }
  });

  it("U-DELEG-009: codex adapter plan passes ladder-base xhigh through to argv (mini lane)", () => {
    // 実機裏取り 2026-07-16: codex-cli 0.144.1 が `-c model_reasoning_effort=xhigh` を受理・正常応答。
    const plan = buildAdapterPlan(
      {
        provider: "codex",
        role: "docs",
        task: "README typo",
        model: MODEL_IDS.codex.mini,
        effort: "xhigh",
        execute: false,
      },
      "hybrid",
    );
    expect(plan.args).toContain("model_reasoning_effort=xhigh");
    expect(plan.effort).toBe("xhigh");
  });

  it("U-DELEG-003: worker role se flows through selectTeamModel policy with a model+effort", () => {
    const r = resolveDelegationRouting({
      provider: "codex",
      role: "se",
      task: "implement the parser module and wire it into the CLI",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model).toBeTruthy();
      expect(r.effort).toBeTruthy();
      expect(r.model_source).toBe("policy");
      // review 系モデルに紛れない (worker lane 側の解決)
      expect(r.review_lane).toBeUndefined();
    }
  });

  it("U-DELEG-004: explicit --model/--effort always win over routing", () => {
    const r = resolveDelegationRouting({
      provider: "codex",
      role: "blind-reviewer",
      task: "review",
      model: "gpt-5.3-codex-spark",
      effort: "xhigh",
    });
    expect(r).toMatchObject({
      ok: true,
      model: "gpt-5.3-codex-spark",
      effort: "xhigh",
      model_source: "explicit",
      effort_source: "explicit",
    });
  });

  it("U-DELEG-005: codex adapter plan carries effort into argv via -c model_reasoning_effort", () => {
    const plan = buildAdapterPlan(
      {
        provider: "codex",
        role: "blind-reviewer",
        task: "review",
        model: MODEL_IDS.codex.frontier,
        effort: "middle",
        execute: false,
      },
      "hybrid",
    );
    // repo 語彙 middle は codex config 語彙 medium へ正規化される (実機裏取り 2026-07-16:
    // `codex exec -c model_reasoning_effort=low` が受理されることを確認済み)
    expect(plan.args).toContain("-c");
    expect(plan.args).toContain("model_reasoning_effort=medium");
    expect(plan.effort).toBe("medium");
  });

  it("U-DELEG-006: claude adapter plan keeps the existing --effort flag + env contract", () => {
    const plan = buildAdapterPlan(
      {
        provider: "claude",
        role: "se",
        task: "implement",
        model: MODEL_IDS.claude.sonnet,
        effort: "middle",
        execute: false,
      },
      "hybrid",
    );
    expect(plan.args).toContain("--effort");
    expect(plan.args).toContain("medium");
    expect(plan.env).toMatchObject({ CLAUDE_CODE_EFFORT_LEVEL: "medium" });
  });

  it("U-DELEG-007: allowlist covers the real repo role vocabulary", () => {
    for (const role of [
      "qa",
      "blind-reviewer",
      "tl",
      "tl-advisor",
      "se",
      "reviewer",
      "code-reviewer",
      "pmo-haiku",
      "pmo-tech-docs",
    ]) {
      expect(DELEGATION_ROLE_ALLOWLIST.has(role)).toBe(true);
    }
  });
});
