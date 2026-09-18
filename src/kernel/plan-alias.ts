type AliasResult =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly error: { readonly ruleId: string; readonly candidates: readonly string[] };
    };

export function resolveLegacyPlanAlias(alias: string, planIds: readonly string[]): AliasResult {
  if (planIds.includes(alias)) return { ok: true, value: alias };
  const candidates = planIds.filter((planId) => planId.startsWith(`${alias}-`)).sort();
  if (candidates.length === 1) return { ok: true, value: candidates[0] };
  return {
    ok: false,
    error: {
      ruleId: candidates.length ? "plan-migration-collision" : "plan-asset-not-found",
      candidates,
    },
  };
}
