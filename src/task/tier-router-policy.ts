import { MODEL_IDS, type TaskDifficulty } from "../team/model-policy";
import type { Archetype, Provider, RouterRole, Tier } from "./tier-router";

export const ROLE_ARCHETYPE: Record<RouterRole, Archetype> = {
  tl: "consult",
  uiux: "consult",
  qa: "verify",
  se: "worker",
  docs: "worker",
};

export const TIER_TABLE: Record<Tier, Record<Provider, string>> = {
  T0: { claude: MODEL_IDS.claude.opus, codex: MODEL_IDS.codex.frontier },
  T1: { claude: MODEL_IDS.claude.sonnet, codex: MODEL_IDS.codex.worker },
  T2: { claude: MODEL_IDS.claude.haiku, codex: MODEL_IDS.codex.spark },
};

export const FRONTIER_MODELS: ReadonlySet<string> = new Set(Object.values(TIER_TABLE.T0));

export const FRONTIER_ROLES: ReadonlySet<RouterRole> = new Set(
  (Object.keys(ROLE_ARCHETYPE) as RouterRole[]).filter((r) => ROLE_ARCHETYPE[r] !== "worker"),
);

export const other = (p: Provider): Provider => (p === "claude" ? "codex" : "claude");

const DIFFICULTY_RANK: Record<TaskDifficulty, number> = {
  trivial: 0,
  simple: 1,
  standard: 2,
  complex: 3,
  critical: 4,
};

export function tierFor(role: RouterRole, difficulty: TaskDifficulty, riskFlags: string[]): Tier {
  if (ROLE_ARCHETYPE[role] !== "worker") return "T0";
  const cheap = DIFFICULTY_RANK[difficulty] <= DIFFICULTY_RANK.simple && riskFlags.length === 0;
  return cheap ? "T2" : "T1";
}

export function resolveModel(role: RouterRole, tier: Tier, provider: Provider): string {
  if (ROLE_ARCHETYPE[role] === "worker" && tier === "T0") {
    throw new Error(
      `invariant violation: worker role ${role} cannot resolve to T0 (frontier opus/gpt-5.5)`,
    );
  }
  return TIER_TABLE[tier][provider];
}

export type ReviewEntry = "machine" | "T2" | "T1" | "T0";

export function reviewPolicy(
  difficulty: TaskDifficulty,
  riskFlags: string[],
): { reviewEntry: ReviewEntry; gate: boolean; crossReview: boolean } {
  const rank = DIFFICULTY_RANK[difficulty];
  const risky = riskFlags.length > 0;
  if (rank >= 4) return { reviewEntry: "T0", gate: true, crossReview: true };
  if (rank === 3) return { reviewEntry: "T1", gate: true, crossReview: true };
  if (rank === 2 || risky) return { reviewEntry: "T1", gate: risky, crossReview: false };
  if (rank === 1) return { reviewEntry: "T2", gate: false, crossReview: false };
  return { reviewEntry: "machine", gate: false, crossReview: false };
}
