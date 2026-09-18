import type {
  EvidenceClaimsRule,
  EvidenceExitRule,
  EvidenceKind,
  EvidenceProducer,
} from "../../plan-asset/domain/evidence-types.ts";

export const FORWARD_STATES = [
  "proposed",
  "planned",
  "pair_freeze_ready",
  "pair_frozen",
  "red_frozen",
  "implementing",
  "implementation_complete",
  "trace_freeze_ready",
  "trace_frozen",
  "review_ready",
  "reviewed",
  "accepted",
  "archived",
  "blocked",
  "superseded",
  "rejected",
  "reopened",
] as const;
export type ForwardState = (typeof FORWARD_STATES)[number];

export const FORWARD_EVENTS = [
  "plan",
  "prepare-pair-freeze",
  "freeze-pair",
  "freeze-red",
  "begin-implementation",
  "complete-implementation",
  "prepare-trace-freeze",
  "freeze-trace",
  "prepare-review",
  "submit-review",
  "accept",
  "archive",
  "block",
  "supersede",
  "reject",
  "reopen",
  "resume",
] as const;
export type ForwardEventName = (typeof FORWARD_EVENTS)[number];

export interface EvidenceRequirementSpec {
  readonly requirementId: string;
  readonly requiredKind: EvidenceKind;
  readonly acceptedProducers: readonly EvidenceProducer[];
  readonly exitRule: EvidenceExitRule;
  readonly claimsRule: EvidenceClaimsRule;
  readonly maxAgeMs?: number;
}

export interface TransitionSpec {
  readonly event: ForwardEventName;
  readonly from: readonly ForwardState[];
  readonly to: ForwardState;
  readonly evidence: readonly EvidenceRequirementSpec[];
  readonly missingRule: string;
}

const exactZero = { kind: "exact", expected: 0 } as const;
const redExit = { kind: "nonzero" } as const;
const day = 24 * 60 * 60 * 1000;
const normalStates = FORWARD_STATES.slice(0, 13);

export const TRANSITION_POLICY: readonly TransitionSpec[] = Object.freeze([
  spec({
    event: "plan",
    from: ["proposed"],
    to: "planned",
    evidence: [
      requirement({
        requirementId: "scope",
        requiredKind: "scope-approval",
        acceptedProducers: ["po", "human"],
        claimsRule: { kind: "recorded" },
      }),
    ],
  }),
  spec({
    event: "prepare-pair-freeze",
    from: ["planned"],
    to: "pair_freeze_ready",
    evidence: [pair("pair-artifact"), review("design-pair-review")],
  }),
  spec({
    event: "freeze-pair",
    from: ["pair_freeze_ready"],
    to: "pair_frozen",
    evidence: [pair("pair-artifact"), review("design-pair-review")],
  }),
  spec({ event: "freeze-red", from: ["pair_frozen"], to: "red_frozen", evidence: [red("red")] }),
  spec({
    event: "begin-implementation",
    from: ["red_frozen"],
    to: "implementing",
    evidence: [pair("pair-artifact"), red("red")],
    missingRule: "forward-red-evidence-missing",
  }),
  spec({
    event: "complete-implementation",
    from: ["implementing"],
    to: "implementation_complete",
    evidence: [implementation("implementation"), test("targeted", "targeted-test-run")],
  }),
  spec({
    event: "prepare-trace-freeze",
    from: ["implementation_complete"],
    to: "trace_freeze_ready",
    evidence: [trace("trace-materialization")],
  }),
  spec({
    event: "freeze-trace",
    from: ["trace_freeze_ready"],
    to: "trace_frozen",
    evidence: [trace("trace-closure"), test("green", "green-test-run")],
  }),
  spec({
    event: "prepare-review",
    from: ["trace_frozen"],
    to: "review_ready",
    evidence: [trace("trace-closure"), test("green", "green-test-run")],
    missingRule: "forward-trace-freeze-missing",
  }),
  spec({
    event: "submit-review",
    from: ["review_ready"],
    to: "reviewed",
    evidence: [review("independent-review")],
  }),
  spec({
    event: "accept",
    from: ["reviewed"],
    to: "accepted",
    evidence: [review("independent-review"), test("gate", "gate-run")],
    missingRule: "forward-accept-evidence-missing",
  }),
  spec({
    event: "archive",
    from: ["accepted"],
    to: "archived",
    evidence: [
      decision("acceptance", "acceptance-decision"),
      decision("retention", "retention-decision"),
    ],
  }),
  spec({
    event: "block",
    from: normalStates.filter((state) => state !== "accepted" && state !== "archived"),
    to: "blocked",
    evidence: [exception()],
    missingRule: "forward-exception-context-missing",
  }),
  spec({
    event: "supersede",
    from: normalStates.filter((state) => state !== "archived"),
    to: "superseded",
    evidence: [exception()],
    missingRule: "forward-exception-context-missing",
  }),
  spec({
    event: "reject",
    from: ["review_ready", "reviewed"],
    to: "rejected",
    evidence: [exception()],
    missingRule: "forward-exception-context-missing",
  }),
  spec({
    event: "reopen",
    from: ["blocked", "superseded", "rejected"],
    to: "reopened",
    evidence: [exception()],
    missingRule: "forward-exception-context-missing",
  }),
  spec({
    event: "resume",
    from: ["reopened"],
    to: "planned",
    evidence: [exception()],
    missingRule: "forward-exception-context-missing",
  }),
]);

export function transitionFor(event: ForwardEventName): TransitionSpec | undefined {
  return TRANSITION_POLICY.find((candidate) => candidate.event === event);
}

export function edgeFor(state: ForwardState, event: ForwardEventName): TransitionSpec | undefined {
  const candidate = transitionFor(event);
  return candidate?.from.includes(state) ? candidate : undefined;
}

function spec(input: {
  readonly event: ForwardEventName;
  readonly from: readonly ForwardState[];
  readonly to: ForwardState;
  readonly evidence: readonly EvidenceRequirementSpec[];
  readonly missingRule?: string;
}): TransitionSpec {
  return Object.freeze({
    event: input.event,
    from: Object.freeze([...input.from]),
    to: input.to,
    evidence: Object.freeze([...input.evidence]),
    missingRule: input.missingRule ?? "forward-evidence-missing",
  });
}
function requirement(input: {
  readonly requirementId: string;
  readonly requiredKind: EvidenceKind;
  readonly acceptedProducers: readonly EvidenceProducer[];
  readonly claimsRule: EvidenceClaimsRule;
  readonly exitRule?: EvidenceExitRule;
  readonly maxAgeMs?: number;
}): EvidenceRequirementSpec {
  return {
    requirementId: input.requirementId,
    requiredKind: input.requiredKind,
    acceptedProducers: input.acceptedProducers,
    claimsRule: input.claimsRule,
    exitRule: input.exitRule ?? exactZero,
    ...(input.maxAgeMs ? { maxAgeMs: input.maxAgeMs } : {}),
  };
}
function pair(id: string): EvidenceRequirementSpec {
  return requirement({
    requirementId: id,
    requiredKind: "pair-artifact-declaration",
    acceptedProducers: ["codex", "claude", "human"],
    claimsRule: {
      kind: "recorded",
    },
  });
}
function review(kind: "design-pair-review" | "independent-review"): EvidenceRequirementSpec {
  return requirement({
    requirementId: kind,
    requiredKind: kind,
    acceptedProducers: ["codex", "claude"],
    claimsRule: { kind: "review-approved" },
  });
}
function red(id: string): EvidenceRequirementSpec {
  return requirement({
    requirementId: id,
    requiredKind: "red-test-run",
    acceptedProducers: ["codex", "claude", "ci"],
    claimsRule: { kind: "red-observed" },
    exitRule: redExit,
    maxAgeMs: day,
  });
}
function test(
  id: string,
  kind: "targeted-test-run" | "green-test-run" | "gate-run",
): EvidenceRequirementSpec {
  return requirement({
    requirementId: id,
    requiredKind: kind,
    acceptedProducers:
      kind === "gate-run" || kind === "green-test-run" ? ["ci"] : ["codex", "claude", "ci"],
    claimsRule: kind === "gate-run" ? { kind: "gate-passed" } : { kind: "recorded" },
    exitRule: exactZero,
    maxAgeMs: day,
  });
}
function implementation(id: string): EvidenceRequirementSpec {
  return requirement({
    requirementId: id,
    requiredKind: "implementation-digest",
    acceptedProducers: ["codex", "claude"],
    claimsRule: { kind: "recorded" },
  });
}
function trace(kind: "trace-materialization" | "trace-closure"): EvidenceRequirementSpec {
  return requirement({
    requirementId: kind,
    requiredKind: kind,
    acceptedProducers: ["codex", "claude", "ci"],
    claimsRule: kind === "trace-closure" ? { kind: "trace-clean" } : { kind: "recorded" },
    exitRule: exactZero,
    maxAgeMs: kind === "trace-closure" ? day : undefined,
  });
}
function decision(
  id: string,
  kind: "acceptance-decision" | "retention-decision",
): EvidenceRequirementSpec {
  return requirement({
    requirementId: id,
    requiredKind: kind,
    acceptedProducers: ["po", "human"],
    claimsRule: {
      kind: "decision",
      expected: kind === "acceptance-decision" ? "accepted" : "archive",
    },
  });
}
function exception(): EvidenceRequirementSpec {
  return requirement({
    requirementId: "exception",
    requiredKind: "exception-context",
    acceptedProducers: ["po", "human", "codex", "claude"],
    claimsRule: {
      kind: "recorded",
    },
  });
}
