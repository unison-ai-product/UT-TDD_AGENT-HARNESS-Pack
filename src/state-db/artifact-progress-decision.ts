export type ArtifactProgressColor = "red" | "yellow" | "green";

export type ArtifactProgressState =
  | "dependency_unchecked"
  | "implemented_unverified"
  | "recovering"
  | "verified";

export interface ArtifactProgressDecisionInput {
  linkedTestCount: number;
  passedLinkedTestRunCount?: number;
  dependencyChecked: boolean;
  dependencyCheckRunId?: string;
  dependencyCheckedAt?: string;
  openDependencyImpacts: number;
  recoveryPlanIds?: string[];
}

export interface ArtifactProgressDecision {
  state: ArtifactProgressState;
  color: ArtifactProgressColor;
  reason: string;
}

export function deriveArtifactProgressDecision(
  input: ArtifactProgressDecisionInput,
): ArtifactProgressDecision {
  const recoveryPlanIds = input.recoveryPlanIds ?? [];
  if (recoveryPlanIds.length > 0) {
    return {
      state: "recovering",
      color: "yellow",
      reason: `recovery in progress: ${recoveryPlanIds.join(",")}`,
    };
  }
  if (!input.dependencyChecked || input.openDependencyImpacts > 0) {
    return {
      state: "dependency_unchecked",
      color: "red",
      reason:
        input.openDependencyImpacts > 0
          ? `${input.openDependencyImpacts} open dependency impact(s)`
          : "dependency check is missing",
    };
  }
  if ((input.passedLinkedTestRunCount ?? 0) > 0) {
    return {
      state: "verified",
      color: "green",
      reason: "linked test run passed and dependency impact is clear",
    };
  }
  if (input.linkedTestCount > 0) {
    return {
      state: "implemented_unverified",
      color: "yellow",
      reason: "linked test exists but no passing test run is recorded",
    };
  }
  return {
    state: "implemented_unverified",
    color: "yellow",
    reason: "implemented artifact has no linked test evidence yet",
  };
}
