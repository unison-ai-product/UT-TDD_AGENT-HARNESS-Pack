export const DESCENT_LAYERS = [
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8",
  "L9",
  "L10",
  "L11",
  "L12",
  "L13",
  "L14",
] as const;

export type Layer = (typeof DESCENT_LAYERS)[number];
export type ArtifactRole = "requirement" | "design" | "test-design" | "source" | "test";
export type ArtifactStatus = "active" | "park" | "defer" | "placeholder";
export type DescentRuleKind = "descent" | "pair" | "impl-guard";
export type ObligationCondition = "active" | "impl-present";
export type RuleFrom = Layer | "*";
export type ObligationStatus = "satisfied" | "deferred" | "unmet";
export type FindingCode = "untraceable" | "duplicate-key" | "invalid-defer";

export interface AdjacencyRule {
  from: RuleFrom;
  to: Layer;
  kind: DescentRuleKind;
  condition: ObligationCondition;
  note: string;
}

export interface DescentAdjacency {
  rules: AdjacencyRule[];
}

export interface TraceKeyedArtifact {
  traceKey: string;
  layer: Layer;
  role: ArtifactRole;
  path: string;
  status: ArtifactStatus;
  traceKeyFromRange?: boolean;
}

export interface ThinCoverageAdvisory {
  traceKey: string;
  requiredLayer: Layer;
  detail: string;
}

export interface DeferEntry {
  traceKey: string;
  fromLayer: Layer;
  waitingLayer: Layer;
  waitingSpec: string;
  dischargeCondition: string;
  owner: string;
}

export interface Obligation {
  traceKey: string;
  fromLayer: Layer;
  requiredLayer: Layer;
  kind: DescentRuleKind;
  reason: string;
}

export interface GradedObligation extends Obligation {
  status: ObligationStatus;
  defer?: DeferEntry;
}

export interface ImplAheadViolation {
  traceKey: string;
  landedAt: Layer;
  waitingLayer: Layer;
  waitingSpec: string;
  owner: string;
}

export interface ChainSummary {
  traceKey: string;
  complete: boolean;
  firstGap: Layer | null;
  layers: Layer[];
}

export interface DescentFinding {
  code: FindingCode;
  traceKey: string;
  layer?: Layer;
  role?: ArtifactRole;
  path?: string;
  detail: string;
}

export interface DescentResult {
  ok: boolean;
  obligations: GradedObligation[];
  implAhead: ImplAheadViolation[];
  chains: ChainSummary[];
  findings: DescentFinding[];
  advisories: ThinCoverageAdvisory[];
}

export const DEFAULT_DESCENT_ADJACENCY: DescentAdjacency = {
  rules: [
    { from: "L1", to: "L3", kind: "descent", condition: "active", note: "requirements to FR" },
    { from: "L3", to: "L4", kind: "descent", condition: "active", note: "FR to basic design" },
    {
      from: "L4",
      to: "L5",
      kind: "descent",
      condition: "active",
      note: "basic to detailed design",
    },
    {
      from: "L5",
      to: "L6",
      kind: "descent",
      condition: "active",
      note: "detailed to function design",
    },
    {
      from: "L6",
      to: "L7",
      kind: "pair",
      condition: "active",
      note: "function design to unit test design",
    },
    {
      from: "L5",
      to: "L8",
      kind: "pair",
      condition: "impl-present",
      note: "implementation needs integration test design",
    },
    {
      from: "L4",
      to: "L9",
      kind: "pair",
      condition: "impl-present",
      note: "implementation needs system test design",
    },
    {
      from: "L3",
      to: "L12",
      kind: "pair",
      condition: "impl-present",
      note: "implementation needs acceptance/deploy evidence",
    },
    {
      from: "*",
      to: "L4",
      kind: "impl-guard",
      condition: "impl-present",
      note: "implementation cannot bypass basic design",
    },
    {
      from: "*",
      to: "L5",
      kind: "impl-guard",
      condition: "impl-present",
      note: "implementation cannot bypass detailed design",
    },
    {
      from: "*",
      to: "L6",
      kind: "impl-guard",
      condition: "impl-present",
      note: "implementation cannot bypass function design",
    },
    {
      from: "*",
      to: "L7",
      kind: "impl-guard",
      condition: "impl-present",
      note: "implementation cannot bypass unit test design",
    },
  ],
};
