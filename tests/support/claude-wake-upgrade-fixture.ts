export interface ClaudeWakeUpgradeFixtureIdentity {
  readonly projectId: string;
  readonly memoryId: string;
  readonly operationId: string;
  readonly producerProvider: "codex";
  readonly consumerProvider: "claude";
  readonly sessionId: string;
  readonly exactHead: string;
  readonly reviewRevision: string;
}

export function admitHistoricalFixturePayload(input: {
  readonly historicalPayload?: unknown;
  readonly requestedEnvelope?: unknown;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "historical_payload_unavailable" } {
  if (
    input.historicalPayload === "unavailable_do_not_reconstruct" &&
    typeof input.requestedEnvelope === "string"
  ) {
    return { ok: false, reason: "historical_payload_unavailable" };
  }
  return { ok: true };
}

export function fixtureIdentityMatches(
  actual: ClaudeWakeUpgradeFixtureIdentity,
  expected: ClaudeWakeUpgradeFixtureIdentity,
): boolean {
  return (Object.keys(expected) as (keyof ClaudeWakeUpgradeFixtureIdentity)[]).every(
    (key) => actual[key] === expected[key],
  );
}
