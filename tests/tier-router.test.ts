import { describe, expect, it } from "vitest";
import type { RuntimeDetection } from "../src/runtime/detect";
import {
  assignCross,
  isRouterRole,
  roster,
  route,
  routeTeamMembers,
  routeToAdapterPlan,
} from "../src/task/tier-router";
import {
  FRONTIER_MODELS,
  FRONTIER_ROLES,
  other,
  ROLE_ARCHETYPE,
  resolveModel,
  TIER_TABLE,
  tierFor,
} from "../src/task/tier-router-policy";

function det(
  mode: RuntimeDetection["mode"],
  currentRuntime: RuntimeDetection["currentRuntime"],
): RuntimeDetection {
  return {
    mode,
    claude: mode === "hybrid" || mode === "claude-only",
    codex: mode === "hybrid" || mode === "codex-only",
    currentRuntime,
    availableRuntimes: [],
    missingRuntimes: [],
  };
}

describe("U-TIER: cost-tiered provider router", () => {
  it("U-TIER-001: archetype が tier 帯を決める (相談/検証=T0, ワーカー=T1/T2)", () => {
    expect(tierFor("tl", "trivial", [])).toBe("T0");
    expect(tierFor("uiux", "critical", [])).toBe("T0");
    expect(tierFor("qa", "standard", [])).toBe("T0");
    expect(tierFor("se", "trivial", [])).toBe("T2");
    expect(tierFor("se", "standard", [])).toBe("T1");
    expect(tierFor("docs", "trivial", [])).toBe("T2");
  });

  it("U-TIER-002: ワーカーは原則 T2、難易度↑ or risk で T1 (原則安く + risk override)", () => {
    expect(tierFor("se", "simple", [])).toBe("T2");
    expect(tierFor("se", "complex", [])).toBe("T1");
    expect(tierFor("se", "trivial", ["license"])).toBe("T1");
  });

  it("U-TIER-003: ワーカーは T0 に解決できない (fail-close 不変条件)", () => {
    expect(() => resolveModel("se", "T0", "claude")).toThrow(/invariant/);
    expect(() => resolveModel("docs", "T0", "codex")).toThrow(/invariant/);
    expect(resolveModel("se", "T2", "claude")).toBe("claude-haiku-4-5");
    expect(resolveModel("se", "T1", "codex")).toBe("gpt-5.4");
  });

  it("U-TIER-004: GPT(Codex) も Claude と対称 (全 role 両 provider・同 archetype)", () => {
    const r = roster();
    expect(r).toHaveLength(5);
    for (const binding of r) {
      expect(binding.claude).toMatch(/^claude-/);
      expect(binding.codex).toMatch(/^gpt-/);
      expect(binding.archetype).toBe(ROLE_ARCHETYPE[binding.role]);
    }
    for (const tier of ["T0", "T1", "T2"] as const) {
      expect(TIER_TABLE[tier].claude).toBeTruthy();
      expect(TIER_TABLE[tier].codex).toBeTruthy();
    }
    expect([...FRONTIER_ROLES].sort()).toEqual(["qa", "tl", "uiux"]);
  });

  it("U-TIER-005: T0 (opus/gpt-5.5) は明示許可ゲート (fail-close)", () => {
    const d = det("claude-only", "claude");
    const blocked = route({ role: "tl", task: { text: "design the api boundary" } }, d);
    expect(blocked.tier).toBe("T0");
    expect(blocked.status).toBe("blocked-needs-approval");
    expect(blocked.model).toBeNull();

    const ready = route({ role: "tl", task: { text: "design the api boundary" } }, d, {
      auth: { explicit: true },
    });
    expect(ready.status).toBe("ready");
    expect(ready.model).toBe("claude-opus-4-8");
    expect(FRONTIER_MODELS.has(ready.model ?? "")).toBe(true);
  });

  it("U-TIER-006: ワーカー role は明示許可があっても T0/フロンティアに届かない", () => {
    const d = det("claude-only", "claude");
    const dec = route({ role: "se", task: { text: "refactor the runtime adapter module" } }, d, {
      auth: { explicit: true },
    });
    expect(dec.tier).not.toBe("T0");
    expect(FRONTIER_MODELS.has(dec.model ?? "")).toBe(false);
  });

  it("U-TIER-007: 難易度ルーターがワーカー帯で T2↔T1 を自動振り分け", () => {
    const d = det("codex-only", "codex");
    const cheap = route({ role: "se", task: { text: "rename a field" } }, d);
    expect(cheap.tier).toBe("T2");
    expect(cheap.model).toBe("gpt-5.3-codex-spark");

    const hard = route(
      { role: "se", task: { text: "refactor the database integration architecture" } },
      d,
    );
    expect(hard.tier).toBe("T1");
    expect(hard.model).toBe("gpt-5.4");
  });

  it("U-TIER-008: assignCross は hybrid で判断を相手 provider にフリップ", () => {
    expect(assignCross(det("hybrid", "claude"))).toEqual({
      execution: "claude",
      judgement: "codex",
      review_kind: "cross_agent",
    });
    expect(assignCross(det("hybrid", "codex"))).toEqual({
      execution: "codex",
      judgement: "claude",
      review_kind: "cross_agent",
    });
    expect(assignCross(det("claude-only", "claude")).review_kind).toBe("intra_runtime_subagent");
    expect(other("claude")).toBe("codex");
  });

  it("U-TIER-009: route は主 provider (currentRuntime) でモデルを選ぶ", () => {
    const claudeDriven = route(
      { role: "se", task: { text: "rename a field" } },
      det("hybrid", "claude"),
    );
    expect(claudeDriven.provider).toBe("claude");
    expect(claudeDriven.model).toBe("claude-haiku-4-5");

    const codexDriven = route(
      { role: "se", task: { text: "rename a field" } },
      det("hybrid", "codex"),
    );
    expect(codexDriven.provider).toBe("codex");
    expect(codexDriven.model).toBe("gpt-5.3-codex-spark");
  });

  it("U-TIER-010: route が主→相手のプロバイダ切替を自動配線する (assignCross wired)", () => {
    const claudeDriven = route(
      { role: "se", task: { text: "rename a field" } },
      det("hybrid", "claude"),
    );
    expect(claudeDriven.cross).toEqual({
      execution: "claude",
      judgement: "codex",
      review_kind: "cross_agent",
    });

    const codexDriven = route(
      { role: "se", task: { text: "rename a field" } },
      det("hybrid", "codex"),
    );
    expect(codexDriven.cross).toEqual({
      execution: "codex",
      judgement: "claude",
      review_kind: "cross_agent",
    });

    const single = route(
      { role: "se", task: { text: "rename a field" } },
      det("claude-only", "claude"),
    );
    expect(single.cross.review_kind).toBe("intra_runtime_subagent");
  });

  it("U-TIER-011: routeToAdapterPlan が決定を provider adapter プランへ接続する", () => {
    const ready = route(
      { role: "se", task: { text: "rename a field" } },
      det("codex-only", "codex"),
    );
    const plan = routeToAdapterPlan(ready, "rename a field", { mode: "codex-only" });
    expect(plan).not.toBeNull();
    expect(plan?.provider).toBe("codex");
    expect(plan?.command).toBe("codex");
    expect(plan?.args).toContain("gpt-5.3-codex-spark");
    const injected = routeToAdapterPlan(ready, "rename a field", {
      mode: "codex-only",
      contextInjection: {
        required_paths: ["docs/skills/refactoring.md"],
        optional_paths: [],
      },
    });
    expect(injected?.context_injection?.required_paths).toEqual(["docs/skills/refactoring.md"]);
    expect(injected?.stdin).toContain("docs/skills/refactoring.md");

    // blocked (T0 未承認) は実行不可 → null (fail-close)。
    const blocked = route(
      { role: "tl", task: { text: "design the api boundary" } },
      det("claude-only", "claude"),
    );
    expect(blocked.status).toBe("blocked-needs-approval");
    expect(
      routeToAdapterPlan(blocked, "design the api boundary", { mode: "claude-only" }),
    ).toBeNull();
  });

  it("U-TIER-012: 連携状態(hybrid)は実装と検証を明示的に別 provider にする", () => {
    const impl = route({ role: "se", task: { text: "rename a field" } }, det("hybrid", "claude"));
    const review = route(
      { role: "qa", task: { text: "rename a field" } },
      det("hybrid", "claude"),
      {
        auth: { explicit: true },
      },
    );
    // impl=ワーカー=主(claude)、review=検証=相手(codex) で明示的に別 provider。
    expect(impl.provider).toBe("claude");
    expect(review.provider).toBe("codex");
    expect(impl.provider).not.toBe(review.provider);
    expect(impl.cross.review_kind).toBe("cross_agent");
    expect(review.cross.review_kind).toBe("cross_agent");
  });

  it("U-TIER-013: isRouterRole は 5 役のみ true (po/aim は engine fallback)", () => {
    for (const role of ["tl", "qa", "uiux", "se", "docs"]) expect(isRouterRole(role)).toBe(true);
    for (const role of ["po", "aim", "unknown"]) expect(isRouterRole(role)).toBe(false);
  });

  it("U-TIER-014: routeTeamMembers が team をクロス配置へ通す (ワーカー=主 / 検証=相手)", () => {
    const members = [
      { role: "se", task: "rename a field" },
      { role: "qa", task: "verify coverage" },
      { role: "po", task: "decide" },
    ];
    const routings = routeTeamMembers(members, det("hybrid", "claude"), {
      primary: "claude",
      auth: { explicit: true },
    });
    // se=ワーカー=主(claude)。
    expect(routings[0].routed).toBe(true);
    expect(routings[0].decision?.provider).toBe("claude");
    expect(routings[0].decision?.model).toBe("claude-haiku-4-5");
    // qa=検証=相手(codex)、明示許可ありで T0 ready。
    expect(routings[1].routed).toBe(true);
    expect(routings[1].decision?.provider).toBe("codex");
    expect(routings[1].decision?.model).toBe("gpt-5.5");
    expect(routings[1].decision?.status).toBe("ready");
    // po=router 非対象 → routed=false (engine fallback)。
    expect(routings[2].routed).toBe(false);
    expect(routings[2].decision).toBeUndefined();
  });

  it("U-TIER-015: routeTeamMembers は明示許可なしで T0 検証 member を block (fail-close)", () => {
    const routings = routeTeamMembers(
      [{ role: "qa", task: "verify coverage" }],
      det("hybrid", "claude"),
      {
        primary: "claude",
      },
    );
    expect(routings[0].decision?.status).toBe("blocked-needs-approval");
    expect(routings[0].decision?.model).toBeNull();
    expect(routings[0].decision?.provider).toBe("codex");
  });
});
