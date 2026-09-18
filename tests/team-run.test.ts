import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSlots, nodeAgentSlotsDeps } from "../src/runtime/agent-slots.ts";
import type { RuntimeDetection } from "../src/runtime/detect.ts";
import { type TeamDefinition, teamMemberSchema } from "../src/schema/team.ts";
import { classifyProposalDocumentCoverage } from "../src/task/classify.ts";
import { routeTeamMembers } from "../src/task/tier-router.ts";
import { recommendTeamLaunch } from "../src/team/launch-policy.ts";
import { MODEL_IDS } from "../src/team/model-policy.ts";
import {
  buildTeamRunPlan,
  executeTeamRunPlan,
  type MemberPlacement,
  providerFromEngine,
  validateTeamRun,
} from "../src/team/run.ts";
import {
  dependencyFailedMessage,
  duplicateRoleProviderMessage,
  serializeAfterTargetAmbiguousMessage,
  serializeAfterTargetNotFoundMessage,
  TEAM_MEMBER_PROMPT_HEADER,
  TEAM_RUN_REQUIRES_CROSS_PROVIDER_REVIEW_MESSAGE,
  TEAM_RUN_REQUIRES_HYBRID_MESSAGE,
} from "../src/team/run-policy.ts";

const hybrid = (currentRuntime: "claude" | "codex"): RuntimeDetection => ({
  mode: "hybrid",
  claude: true,
  codex: true,
  currentRuntime,
  availableRuntimes: [],
  missingRuntimes: [],
});

/** CLI と同じ routings → placements 変換 (tier-router 決定を team run へ橋渡し)。 */
function placementsFor(
  team: TeamDefinition,
  detection: RuntimeDetection,
  options: { primary: "claude" | "codex"; allowFrontier?: boolean },
): (MemberPlacement | null)[] {
  const routings = routeTeamMembers(
    team.members.map((m) => ({ role: m.role, task: m.task })),
    detection,
    { primary: options.primary, auth: options.allowFrontier ? { explicit: true } : undefined },
  );
  return routings.map((r): MemberPlacement | null => {
    if (!r.routed || !r.decision) return null;
    const d = r.decision;
    if (d.status !== "ready" || !d.model) {
      return { provider: d.provider, model: "", blockedReason: d.reason ?? "blocked" };
    }
    return { provider: d.provider, model: d.model };
  });
}

const baseTeam = (members: TeamDefinition["members"]): TeamDefinition => ({
  name: "review-team",
  strategy: "sequential",
  max_parallel: 8,
  members,
});

describe("team run validation", () => {
  it("maps engine names to providers", () => {
    expect(providerFromEngine("codex-se")).toBe("codex");
    expect(providerFromEngine("pmo-sonnet")).toBe("claude");
    expect(providerFromEngine("qa-test")).toBe("local");
  });

  it("passes hybrid team when worker and reviewer use different providers", () => {
    const result = validateTeamRun(
      baseTeam([
        { role: "se", engine: "codex-se", task: "implement" },
        { role: "tl", engine: "pmo-sonnet", task: "review", serialize_after: "se" },
      ]),
      "hybrid",
    );
    expect(result.ok).toBe(true);
    expect(result.providers).toEqual(["codex", "claude"]);
  });

  it("fails outside hybrid mode", () => {
    const result = validateTeamRun(
      baseTeam([{ role: "se", engine: "codex-se", task: "implement" }]),
      "codex-only",
    );
    expect(result.ok).toBe(false);
    expect(result.messages).toContain(TEAM_RUN_REQUIRES_HYBRID_MESSAGE);
  });

  it("fails hybrid team with same-provider worker and reviewer", () => {
    const result = validateTeamRun(
      baseTeam([
        { role: "se", engine: "codex-se", task: "implement" },
        { role: "tl", engine: "codex-tl", task: "review" },
      ]),
      "hybrid",
    );
    expect(result.ok).toBe(false);
    expect(result.messages).toContain(TEAM_RUN_REQUIRES_CROSS_PROVIDER_REVIEW_MESSAGE);
  });

  it("fails duplicate role/provider assignments", () => {
    const result = validateTeamRun(
      baseTeam([
        { role: "se", engine: "codex-se", task: "a" },
        { role: "se", engine: "codex-pg", task: "b" },
        { role: "tl", engine: "pmo-sonnet", task: "review" },
      ]),
      "hybrid",
    );
    expect(result.ok).toBe(false);
    expect(result.messages).toContain(duplicateRoleProviderMessage("se:codex"));
  });

  it("builds a shared Claude/Codex launch plan from the same team member flow", () => {
    const result = buildTeamRunPlan(
      {
        name: "speed-team",
        strategy: "parallel",
        max_parallel: 2,
        members: [
          { role: "se", engine: "codex-se", task: "implement slice A" },
          { role: "tl", engine: "pmo-sonnet", task: "review slice A" },
        ],
      },
      "hybrid",
    );

    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.strategy).toBe("parallel");
    expect(result.members.map((m) => m.provider)).toEqual(["codex", "claude"]);
    expect(result.members.every((m) => m.prompt.includes(TEAM_MEMBER_PROMPT_HEADER))).toBe(true);
    expect(result.members[0].prompt).toContain("provider: codex");
    expect(result.members[1].prompt).toContain("provider: claude");
    // 実装 intent は engine family (codex) より優先して luna に解決 (PLAN-L7-430)。
    expect(result.members[0].model_selection.model).toBe(MODEL_IDS.codex.luna);
    expect(result.members[0].adapter).toMatchObject({
      command: "codex",
      dry_run: true,
      model: MODEL_IDS.codex.luna,
    });
    expect(result.members[0].adapter?.args).toContain("-m");
    expect(result.members[1].model_selection.model).toBe(MODEL_IDS.claude.opus);
    expect(result.members[1].adapter).toMatchObject({
      command: "claude",
      dry_run: true,
      model: MODEL_IDS.claude.opus,
    });
  });

  it("routes structured intent from the team contract and rejects unknown member fields", () => {
    const result = buildTeamRunPlan(
      {
        name: "typed-intent-team",
        strategy: "sequential",
        max_parallel: 1,
        members: [
          {
            role: "qa",
            engine: "codex-qa",
            task: "generic task text",
            intent: "implementation",
          },
        ],
      },
      "codex-only",
    );

    expect(result.members[0].model_selection).toMatchObject({
      task_intent: "implementation",
      model: MODEL_IDS.codex.luna,
    });
    expect(() =>
      teamMemberSchema.parse({
        role: "qa",
        engine: "codex-qa",
        task: "generic task text",
        intent: "invalid",
      }),
    ).toThrow();
    expect(() =>
      teamMemberSchema.parse({
        role: "qa",
        engine: "codex-qa",
        task: "generic task text",
        intent: "implementation",
        typo_intent: "test",
      }),
    ).toThrow();
  });

  it("honors explicit model policy overrides in the shared launch plan", () => {
    const result = buildTeamRunPlan(
      {
        name: "speed-team",
        strategy: "parallel",
        max_parallel: 2,
        members: [
          {
            role: "se",
            engine: "codex-se",
            task: "implement small docs change",
            difficulty: "critical",
            model: MODEL_IDS.codex.worker,
            effort: "high",
          },
          { role: "tl", engine: "pmo-sonnet", task: "review slice A" },
        ],
      },
      "hybrid",
    );

    expect(result.ok).toBe(true);
    expect(result.members[0].model_selection).toMatchObject({
      difficulty: "critical",
      difficulty_source: "explicit",
      model: MODEL_IDS.codex.worker,
      model_source: "explicit",
      reasoning_effort: "high",
      effort_source: "explicit",
    });
    expect(result.members[0].prompt).toContain("reasoning_effort: high");
  });

  it("builds an executable proposal coverage team from mini/spark lanes without executing frontier judgement", () => {
    const task = "Rename a local docs helper and update README wording.";
    const coverage = classifyProposalDocumentCoverage({ text: task });
    const recommendation = recommendTeamLaunch({
      task,
      mode: "hybrid",
      proposalSubagents: coverage.recommended_subagents,
    });

    expect(recommendation.should_launch).toBe(true);
    expect(recommendation.definition?.name).toBe("proposal-coverage-team");
    expect(recommendation.definition?.max_parallel).toBe(7);
    const members = recommendation.definition?.members ?? [];
    expect(members.filter((member) => member.model === MODEL_IDS.codex.mini)).toHaveLength(4);
    expect(members.filter((member) => member.model === MODEL_IDS.codex.spark)).toHaveLength(3);
    expect(members.some((member) => member.model === MODEL_IDS.codex.frontier)).toBe(false);
    expect(members.every((member) => member.ownership)).toBe(true);
    expect(members.some((member) => member.engine === "pmo-sonnet")).toBe(true);

    const plan = buildTeamRunPlan(recommendation.definition as TeamDefinition, "hybrid");
    expect(plan.ok).toBe(true);
    expect(plan.strategy).toBe("sequential");
    expect(
      plan.members.filter((member) => member.model_selection.model === MODEL_IDS.codex.mini),
    ).toHaveLength(4);
    expect(
      plan.members.filter((member) => member.model_selection.model === MODEL_IDS.codex.spark),
    ).toHaveLength(3);
    expect(plan.members.some((member) => member.prompt.includes("ownership:"))).toBe(true);
  });

  it("passes provider-neutral skill injection to every runtime adapter", () => {
    const result = buildTeamRunPlan(
      {
        name: "speed-team",
        strategy: "parallel",
        max_parallel: 2,
        members: [
          { role: "se", engine: "codex-se", task: "implement slice A" },
          { role: "tl", engine: "pmo-sonnet", task: "review slice A" },
        ],
      },
      "hybrid",
      {
        contextInjection: {
          required_paths: ["docs/skills/refactoring.md"],
          optional_paths: ["docs/skills/review-checklist.yaml"],
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.members.map((member) => member.adapter?.context_injection)).toEqual([
      {
        required_paths: ["docs/skills/refactoring.md"],
        optional_paths: ["docs/skills/review-checklist.yaml"],
      },
      {
        required_paths: ["docs/skills/refactoring.md"],
        optional_paths: ["docs/skills/review-checklist.yaml"],
      },
    ]);
    expect(
      result.members.every((member) => member.adapter?.stdin?.includes("refactoring.md")),
    ).toBe(true);
  });

  it("keeps dependent team members on the same flow but schedules them sequentially", () => {
    const result = buildTeamRunPlan(
      {
        name: "review-team",
        strategy: "parallel",
        max_parallel: 2,
        members: [
          { role: "se", engine: "codex-se", task: "implement slice A" },
          {
            role: "tl",
            engine: "pmo-sonnet",
            task: "review slice A",
            serialize_after: "se",
          },
        ],
      },
      "hybrid",
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe("sequential");
    expect(result.members.map((member) => member.role)).toEqual(["se", "tl"]);
    expect(result.messages).not.toContain("team serialization requires sequential execution");
  });

  it("rejects serialize_after targets that do not exist or are ambiguous", () => {
    const missing = buildTeamRunPlan(
      {
        name: "review-team",
        strategy: "parallel",
        max_parallel: 2,
        members: [
          { role: "se", engine: "codex-se", task: "implement slice A" },
          { role: "tl", engine: "pmo-sonnet", task: "review slice A", serialize_after: "qa" },
        ],
      },
      "hybrid",
    );
    expect(missing.ok).toBe(false);
    expect(missing.messages).toContain(serializeAfterTargetNotFoundMessage("tl:pmo-sonnet", "qa"));

    const ambiguous = buildTeamRunPlan(
      {
        name: "review-team",
        strategy: "parallel",
        max_parallel: 2,
        members: [
          { role: "se", engine: "codex-se", task: "implement slice A" },
          { role: "se", engine: "claude-se", task: "implement slice B" },
          { role: "tl", engine: "pmo-sonnet", task: "review slice A", serialize_after: "se" },
        ],
      },
      "hybrid",
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.messages).toContain(
      serializeAfterTargetAmbiguousMessage("tl:pmo-sonnet", "se"),
    );
  });

  it("keeps explicit serialization reasons green while forcing sequential scheduling", () => {
    const result = buildTeamRunPlan(
      {
        name: "review-team",
        strategy: "parallel",
        max_parallel: 2,
        serialization: { file_conflict: false, downstream_dependency: true, shared_state: false },
        members: [
          { role: "se", engine: "codex-se", task: "implement slice A" },
          { role: "tl", engine: "pmo-sonnet", task: "review slice A" },
        ],
      },
      "hybrid",
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe("sequential");
  });

  it("executes provider adapters through team_runner slots when explicitly requested", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-team-run-"));
    try {
      const plan = buildTeamRunPlan(
        {
          name: "speed-team",
          strategy: "parallel",
          max_parallel: 2,
          members: [
            { role: "se", engine: "codex-se", task: "implement slice A" },
            { role: "tl", engine: "pmo-sonnet", task: "review slice A" },
          ],
        },
        "hybrid",
        { execute: true, planId: "PLAN-L7-64-team-runner" },
      );
      const commands: string[] = [];
      const deps = nodeAgentSlotsDeps(repo);
      const execution = await executeTeamRunPlan(plan, {
        slots: deps,
        runCommand: async ({ command, args }) => {
          commands.push(`${command} ${args[0]}`);
          return { exitCode: 0 };
        },
      });

      expect(execution.ok).toBe(true);
      expect(commands).toEqual(expect.arrayContaining(["codex exec", "claude --print"]));
      expect(execution.executions).toHaveLength(2);
      expect(execution.executions.every((row) => row.status === "completed")).toBe(true);
      const slots = loadSlots(deps);
      expect(slots).toHaveLength(2);
      expect(slots.every((slot) => slot.slot_source === "team_runner")).toBe(true);
      expect(slots.every((slot) => slot.released_at !== null)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not execute dependent members after their dependency fails", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-team-run-dependency-fail-"));
    try {
      const plan = buildTeamRunPlan(
        {
          name: "speed-team",
          strategy: "parallel",
          max_parallel: 2,
          members: [
            { role: "tl", engine: "pmo-sonnet", task: "review slice A", serialize_after: "se" },
            { role: "se", engine: "codex-se", task: "implement slice A" },
          ],
        },
        "hybrid",
        { execute: true, planId: "PLAN-L7-65-model-policy" },
      );
      const commands: string[] = [];
      const execution = await executeTeamRunPlan(plan, {
        slots: nodeAgentSlotsDeps(repo),
        runCommand: async ({ command, args }) => {
          commands.push(`${command} ${args[0]}`);
          return { exitCode: 7 };
        },
      });

      expect(execution.ok).toBe(false);
      expect(commands).toEqual(["codex exec"]);
      expect(execution.executions).toHaveLength(2);
      expect(execution.executions[1]).toMatchObject({
        role: "tl",
        status: "failed",
        skipped_reason: dependencyFailedMessage("se"),
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("executes parallel teams in max_parallel batches instead of serializing everything", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-team-run-parallel-"));
    try {
      const plan = buildTeamRunPlan(
        {
          name: "speed-team",
          strategy: "parallel",
          max_parallel: 2,
          members: [
            { role: "se", engine: "codex-se", task: "implement slice A" },
            { role: "tl", engine: "pmo-sonnet", task: "review slice A" },
            { role: "qa", engine: "claude-qa", task: "verify slice A" },
          ],
        },
        "hybrid",
        { execute: true, planId: "PLAN-L7-64-team-runner" },
      );
      let active = 0;
      let peak = 0;
      const started: string[] = [];
      const deps = nodeAgentSlotsDeps(repo);
      const execution = await executeTeamRunPlan(plan, {
        slots: deps,
        runCommand: async ({ command, args }) => {
          active += 1;
          peak = Math.max(peak, active);
          started.push(`${command} ${args[0]}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return { exitCode: 0 };
        },
      });

      expect(execution.ok).toBe(true);
      expect(peak).toBe(2);
      expect(started).toEqual(["codex exec", "claude --print", "claude --print"]);
      expect(loadSlots(deps).every((slot) => slot.released_at !== null)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("routes a hybrid team through the tier-router cross placement (worker=primary / reviewer=other)", () => {
    const team = baseTeam([
      { role: "se", engine: "codex-se", task: "rename a field", serialize_after: undefined },
      { role: "qa", engine: "qa-test", task: "verify coverage", serialize_after: "se" },
    ]);
    const placements = placementsFor(team, hybrid("claude"), {
      primary: "claude",
      allowFrontier: true,
    });
    const result = buildTeamRunPlan(team, "hybrid", { placements });

    expect(result.ok).toBe(true);
    const se = result.members.find((m) => m.role === "se");
    const qa = result.members.find((m) => m.role === "qa");
    // 実装レーン (PO 指示 2026-07-08): 実装(se)=相手(codex) がクロス実行、
    // 検証(qa)=実行側と別 provider (=主 claude、フロンティア) がクロスレビュー。
    expect(se?.provider).toBe("codex");
    expect(se?.model_selection.model).toBe("gpt-5.3-codex-spark");
    expect(qa?.provider).toBe("claude");
    expect(qa?.model_selection.model).toBe("claude-opus-5");
    expect(se?.provider).not.toBe(qa?.provider);
    expect(se?.adapter?.command).toBe("codex");
    expect(qa?.adapter?.command).toBe("claude");
  });

  it("blocks a routed frontier reviewer without explicit permission (fail-close)", () => {
    const team = baseTeam([
      { role: "se", engine: "codex-se", task: "rename a field" },
      { role: "qa", engine: "qa-test", task: "verify coverage", serialize_after: "se" },
    ]);
    const placements = placementsFor(team, hybrid("claude"), { primary: "claude" });
    const result = buildTeamRunPlan(team, "hybrid", { execute: true, placements });

    expect(result.ok).toBe(false);
    expect(result.messages.some((m) => m.startsWith("member blocked by frontier gate: qa"))).toBe(
      true,
    );
    const qa = result.members.find((m) => m.role === "qa");
    expect(qa?.executable).toBe(false);
    expect(qa?.adapter).toBeUndefined();
    // ワーカーは明示許可不要で配置される (実装レーン: 相手=codex がクロス実行)。
    const se = result.members.find((m) => m.role === "se");
    expect(se?.provider).toBe("codex");
    expect(se?.executable).toBe(true);
  });

  it("flips the routed implementation worker to claude when codex hosts the session", () => {
    const team = baseTeam([
      { role: "se", engine: "pmo-sonnet", task: "rename a field" },
      { role: "tl", engine: "codex-tl", task: "review slice A", serialize_after: "se" },
    ]);
    const placements = placementsFor(team, hybrid("codex"), {
      primary: "codex",
      allowFrontier: true,
    });
    const result = buildTeamRunPlan(team, "hybrid", { placements });

    expect(result.ok).toBe(true);
    const se = result.members.find((m) => m.role === "se");
    const tl = result.members.find((m) => m.role === "tl");
    // 主=codex の実装レーン: 実行(se)=相手(claude)、相談(tl)=主(codex)=フロンティア。
    expect(se?.provider).toBe("claude");
    expect(se?.model_selection.model).toBe(MODEL_IDS.claude.haiku);
    expect(tl?.provider).toBe("codex");
    expect(tl?.model_selection.model).toBe(MODEL_IDS.codex.frontier);
  });
});
