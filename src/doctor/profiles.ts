export type DoctorScope = "full" | "toolchain";

export type DoctorRunProfileId =
  | "source-full"
  | "source-toolchain"
  | "consumer-toolchain"
  | "consumer-setup-smoke";
export type DoctorRunProfileAudience = DoctorRunProfile["audience"];

export type DoctorRunProfile =
  | {
      id: "source-full";
      audience: "source";
      invocation: "registry";
      scope: "full";
      setupSmoke: false;
      outputIds: readonly string[];
      sourceOnly: true;
    }
  | {
      id: "source-toolchain";
      audience: "source";
      invocation: "registry";
      scope: "toolchain";
      setupSmoke: false;
      outputIds: readonly string[];
      sourceOnly: false;
    }
  | {
      id: "consumer-toolchain";
      audience: "consumer";
      invocation: "registry";
      scope: "toolchain";
      setupSmoke: false;
      outputIds: readonly string[];
      sourceOnly: false;
    }
  | {
      id: "consumer-setup-smoke";
      audience: "consumer";
      invocation: "setup-smoke";
      setupSmoke: true;
      outputIds: readonly string[];
      sourceOnly: false;
    };

export interface DoctorRunProfileResolutionOptions {
  setupSmoke?: boolean;
  scope?: DoctorScope;
  profile?: DoctorRunProfileId;
}

export const FULL_DOCTOR_OUTPUT_IDS = [
  "backfill",
  "scrum-reverse",
  "plan-supersession",
  "plan-body-substance",
  "plan-completion-drift",
  "propagation",
  "pair-freeze",
  "module-drift",
  "merged-plan-status",
  "plan-artifact-existence",
  "asset-drift",
  "skill-assignment",
  "descent-obligation",
  "change-impact",
  "change-set-integrity",
  "verification-profile",
  "branch-kind-check",
  "coding-rules",
  "design-language",
  "ddd-tdd-rules",
  "runtime-portability",
  "rule-drift",
  "gate-confirm",
  "plan-schedule",
  "plan-governance",
  "plan-dod",
  "placeholder-deps",
  "g1-trace",
  "g3-trace",
  "rule-automation-closure",
  "drive-model-passage",
  "drive-db-registration",
  "db-currency",
  "fr-roadmap-coverage",
  "telemetry-closure",
  "cycle-p4-verification",
  "l14-close-audit",
  "project-hook",
  "github-ci-policy",
  "codex-hook-adapter",
  "codex-wrapper-parity",
  "toolchain-pin",
  "l6-fr-coverage",
  "readability",
  "runtime-readability",
  "feedback-log",
  "l6-completion",
  "l7-completion",
  "review-evidence",
  "guardrail-invariants",
  "verification-groups",
  "roadmap",
  "impl-plan-trace",
  "oracle-test-trace",
  "tracked-canonical",
  "sub-doc-catalog-drift",
  "sub-doc-section-structure",
  "screen-impl-pair-freeze",
  "dependency-drift",
  "regression-expansion",
  "db-projection-coverage",
  "db-projection-ingestion",
  "doc-consistency",
  "entity-coverage",
  "fr-registry-audit",
  "improvement-backlog",
  "right-arm-gate-planning",
  "g8-integration-workflow",
  "g9-system-workflow",
  "g10-ux-workflow",
  "lint-wiring",
  "proposal-document-coverage",
  "frontend-design-coverage",
  "handover-outstanding",
  "green-command-digest",
  "forward-convergence",
  "forward-convergence-audit",
] as const;

export const TOOLCHAIN_DOCTOR_OUTPUT_IDS = ["toolchain-pin"] as const;

export const DOCTOR_RUN_PROFILES = {
  "source-full": {
    id: "source-full",
    audience: "source",
    invocation: "registry",
    scope: "full",
    setupSmoke: false,
    outputIds: FULL_DOCTOR_OUTPUT_IDS,
    sourceOnly: true,
  },
  "source-toolchain": {
    id: "source-toolchain",
    audience: "source",
    invocation: "registry",
    scope: "toolchain",
    setupSmoke: false,
    outputIds: TOOLCHAIN_DOCTOR_OUTPUT_IDS,
    sourceOnly: false,
  },
  "consumer-toolchain": {
    id: "consumer-toolchain",
    audience: "consumer",
    invocation: "registry",
    scope: "toolchain",
    setupSmoke: false,
    outputIds: TOOLCHAIN_DOCTOR_OUTPUT_IDS,
    sourceOnly: false,
  },
  "consumer-setup-smoke": {
    id: "consumer-setup-smoke",
    audience: "consumer",
    invocation: "setup-smoke",
    setupSmoke: true,
    outputIds: [],
    sourceOnly: false,
  },
} as const satisfies Record<DoctorRunProfileId, DoctorRunProfile>;

export const DOCTOR_RUN_PROFILE_IDS = [
  "source-full",
  "source-toolchain",
  "consumer-toolchain",
  "consumer-setup-smoke",
] as const satisfies readonly DoctorRunProfileId[];

export function doctorOutputIdsForScope(scope: DoctorScope): readonly string[] {
  if (scope === "toolchain") return TOOLCHAIN_DOCTOR_OUTPUT_IDS;
  return FULL_DOCTOR_OUTPUT_IDS;
}

export function isConsumerSafeDoctorRunProfile(profile: DoctorRunProfile): boolean {
  return profile.sourceOnly === false;
}

export function resolveDoctorRunProfile(
  options: DoctorRunProfileResolutionOptions = {},
): DoctorRunProfile {
  if (options.profile) {
    return { ...DOCTOR_RUN_PROFILES[options.profile] };
  }

  if (options.setupSmoke === true) {
    return consumerSafeDoctorRunProfile("consumer-setup-smoke");
  }

  const scope = options.scope ?? "full";
  if (scope === "toolchain") {
    return consumerSafeDoctorRunProfile("source-toolchain");
  }

  return { ...DOCTOR_RUN_PROFILES["source-full"] };
}

function consumerSafeDoctorRunProfile(id: DoctorRunProfileId): DoctorRunProfile {
  const profile = DOCTOR_RUN_PROFILES[id];
  if (!isConsumerSafeDoctorRunProfile(profile)) {
    throw new Error(
      `doctor run profile '${id}' is source-only and cannot be used by consumer-safe routes`,
    );
  }
  return { ...profile };
}

export function doctorRunProfilesForAudience(
  audience: DoctorRunProfileAudience,
): DoctorRunProfile[] {
  return DOCTOR_RUN_PROFILE_IDS.map((id) => DOCTOR_RUN_PROFILES[id])
    .filter((profile) => profile.audience === audience)
    .map((profile) => ({ ...profile }));
}

export function consumerSafeDoctorRunProfiles(): DoctorRunProfile[] {
  return DOCTOR_RUN_PROFILE_IDS.map((id) => DOCTOR_RUN_PROFILES[id])
    .filter(isConsumerSafeDoctorRunProfile)
    .map((profile) => ({ ...profile }));
}
