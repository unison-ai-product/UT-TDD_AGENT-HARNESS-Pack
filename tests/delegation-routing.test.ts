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
      role: "reviewer",
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
      model: MODEL_IDS.codex.frontier,
      effort: "xhigh",
    });
    expect(r).toMatchObject({
      ok: true,
      model: MODEL_IDS.codex.frontier,
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
      "ut-tdd-tl",
      "qa-test",
      "security-audit",
      "be-api",
    ]) {
      expect(DELEGATION_ROLE_ALLOWLIST.has(role)).toBe(true);
    }
    for (const role of ["code-reviewer", "pmo-haiku", "pmo-tech-docs", "refactor-scout"]) {
      expect(DELEGATION_ROLE_ALLOWLIST.has(role)).toBe(false);
    }
  });

  it("U-CMDINPUT-001: reviewer routing rejects an invalid model override", () => {
    const result = resolveDelegationRouting({
      provider: "codex",
      role: "blind-reviewer",
      task: "review the diff",
      model: "gpt-6.1-sol%",
    });
    expect(result).toEqual({ ok: false, message: "provider_model_invalid" });
  });

  it("U-CMDINPUT-001: worker routing rejects an invalid model override", () => {
    const result = resolveDelegationRouting({
      provider: "codex",
      role: "se",
      task: "implement the parser module",
      model: "gpt-6.1-sol%",
    });
    expect(result).toEqual({ ok: false, message: "provider_model_invalid" });
  });

  it("U-CMDINPUT-001: reviewer routing reports invalid model before invalid effort", () => {
    const result = resolveDelegationRouting({
      provider: "codex",
      role: "blind-reviewer",
      task: "review the diff",
      model: "gpt-6.1-sol%",
      effort: "ultra",
    });
    expect(result).toEqual({ ok: false, message: "provider_model_invalid" });
  });

  it("U-CMDINPUT-001: worker routing reports invalid model before invalid effort", () => {
    const result = resolveDelegationRouting({
      provider: "codex",
      role: "se",
      task: "implement the parser module",
      model: "gpt-6.1-sol%",
      effort: "ultra",
    });
    expect(result).toEqual({ ok: false, message: "provider_model_invalid" });
  });

  for (const [index, effort] of ["ultra", ""].entries()) {
    describe(`M1 reviewer effort fixture ${index}`, () => {
      it("U-CMDINPUT-002: reviewer invalid effort", () => {
        const result = resolveDelegationRouting({
          provider: "claude",
          role: "reviewer",
          task: "review the diff",
          effort,
        });
        expect(result).toEqual({ ok: false, message: "provider_effort_invalid" });
      });
    });
  }

  for (const [index, effort] of ["ultra", ""].entries()) {
    describe(`M1 worker effort fixture ${index}`, () => {
      it("U-CMDINPUT-002: worker invalid effort", () => {
        const result = resolveDelegationRouting({
          provider: "codex",
          role: "se",
          task: "implement the parser module",
          effort,
        });
        expect(result).toEqual({ ok: false, message: "provider_effort_invalid" });
      });
    });
  }

  it("U-CMDINPUT-003: valid model IDs, aliases, and omitted overrides route normally", () => {
    const reviewerDefault = resolveDelegationRouting({
      provider: "codex",
      role: "blind-reviewer",
      task: "review the diff",
    });
    expect(reviewerDefault).toMatchObject({
      ok: true,
      model: MODEL_IDS.codex.frontier,
      model_source: "review-lane",
    });

    const reviewerModel = resolveDelegationRouting({
      provider: "claude",
      role: "reviewer",
      task: "review the diff",
      model: MODEL_IDS.claude.opus,
    });
    expect(reviewerModel).toMatchObject({
      ok: true,
      model: MODEL_IDS.claude.opus,
      model_source: "explicit",
    });

    const workerDefault = resolveDelegationRouting({
      provider: "codex",
      role: "se",
      task: "implement the parser module",
    });
    expect(workerDefault.ok).toBe(true);

    const workerModel = resolveDelegationRouting({
      provider: "claude",
      role: "se",
      task: "implement the parser module",
      model: MODEL_IDS.claude.sonnet,
    });
    expect(workerModel).toMatchObject({
      ok: true,
      model: MODEL_IDS.claude.sonnet,
      model_source: "explicit",
    });

    const workerAlias = resolveDelegationRouting({
      provider: "codex",
      role: "se",
      task: "implement the parser module",
      model: "sonnet",
    });
    expect(workerAlias).toMatchObject({ ok: true, model: "sonnet", model_source: "explicit" });
  });

  for (const [index, model] of [
    "gpt-6.1-sol%",
    "gpt-6.1-sol'",
    "gpt 6.1 sol",
    "",
    "claude-opus-5-5[1m]",
  ].entries()) {
    describe(`M1 reviewer model fixture ${index}`, () => {
      it("U-CMDINPUT-003: reviewer invalid model syntax", () => {
        const result = resolveDelegationRouting({
          provider: "claude",
          role: "reviewer",
          task: "review the diff",
          model,
        });
        expect(result).toEqual({ ok: false, message: "provider_model_invalid" });
      });
    });
  }

  for (const [index, model] of [
    "gpt-6.1-sol%",
    "gpt-6.1-sol'",
    "gpt 6.1 sol",
    "",
    "claude-opus-5-5[1m]",
  ].entries()) {
    describe(`M1 worker model fixture ${index}`, () => {
      it("U-CMDINPUT-003: worker invalid model syntax", () => {
        const result = resolveDelegationRouting({
          provider: "codex",
          role: "se",
          task: "implement the parser module",
          model,
        });
        expect(result).toEqual({ ok: false, message: "provider_model_invalid" });
      });
    });
  }

  it("U-CMDINPUT-004: reviewer and worker routing accept each declared effort enum", () => {
    const efforts = ["low", "medium", "middle", "high", "xhigh"];
    for (const effort of efforts) {
      const reviewer = resolveDelegationRouting({
        provider: "codex",
        role: "blind-reviewer",
        task: "review the diff",
        effort,
      });
      expect(reviewer).toMatchObject({ ok: true, effort, effort_source: "explicit" });

      const worker = resolveDelegationRouting({
        provider: "claude",
        role: "se",
        task: "implement the parser module",
        effort,
      });
      expect(worker).toMatchObject({ ok: true, effort, effort_source: "explicit" });
    }
  });

  it("U-CMDINPUT-004: omitted effort keeps reviewer and worker defaults", () => {
    const reviewer = resolveDelegationRouting({
      provider: "codex",
      role: "blind-reviewer",
      task: "review the diff",
    });
    expect(reviewer).toMatchObject({ ok: true, effort: "low", effort_source: "ladder" });

    const worker = resolveDelegationRouting({
      provider: "codex",
      role: "se",
      task: "implement the parser module",
    });
    expect(worker).toMatchObject({ ok: true, effort: "high", effort_source: "policy" });
  });
});
