import type { Drive, Kind, Layer, SubDoc, WorkflowPhase } from "../schema/index.ts";
import { routeSignalCandidates } from "../schema/route-map.ts";

export type AdmissionRouteMode =
  | "forward"
  | "discovery"
  | "scrum"
  | "reverse"
  | "redesign"
  | "recovery"
  | "incident"
  | "refactor"
  | "retrofit"
  | "add-feature"
  | "research"
  | "design-bottomup"
  | "version-up"
  | "verify";

export interface AdmissionTuple {
  routeMode: AdmissionRouteMode;
  kind: Kind;
  layer: Layer;
  workflowPhase?: WorkflowPhase;
}

export interface PlanAdmissionRequest extends AdmissionTuple {
  routeSignal: string;
  drive: Drive;
  branch: string;
  status?: "draft" | "confirmed" | "completed" | "archived";
  subDoc?: SubDoc;
  issue?: { provider: "github"; issueId: number; episodeId: string; projectionDigest: string };
  origin?: { planId: string; revision: number; digest: string };
  /** 駆動モデルの判定正本。起点種別や実装資産の有無ではなく遷移方向で決める。 */
  transitionDirection?: "implementation_to_design" | "design_to_implementation";
  /** PoC等の先行実装の扱いは証跡であり、駆動モデルを決める主軸ではない。 */
  implementationDisposition?: "preserved" | "discarded" | "none";
  reentry?: { targetPlanId: string; targetRevision: number; phase: "forward_merge" };
  implementationTarget?: { targetPlanId: string; targetRevision: number };
  escapeReason?: string;
  supersedes?: readonly string[];
}

export interface AdmissionViolation {
  code: string;
  message: string;
}

export type AdmissionDecision =
  | { ok: true; tuple: AdmissionTuple; issueRequired: boolean }
  | { ok: false; violations: AdmissionViolation[] };

const layers = <T extends Kind>(routeMode: AdmissionRouteMode, kind: T, values: readonly Layer[]) =>
  values.map((layer) => ({ routeMode, kind, layer }));

/**
 * PLAN authoringの唯一の許可表。kind/layerの別配列を掛け合わせない。
 * workflow phaseを持つtupleは下のphase展開で追加する。
 */
export const ADMISSION_TUPLES: readonly AdmissionTuple[] = [
  { routeMode: "forward", kind: "charter", layer: "L0" },
  ...layers("forward", "design", ["L1", "L2", "L3", "L4", "L5", "L6"]),
  { routeMode: "forward", kind: "impl", layer: "L7" },
  ...layers("discovery", "poc", ["cross"]),
  ...layers("scrum", "poc", ["cross"]),
  ...["R0", "R1", "R2", "R3", "R4"].map((workflowPhase) => ({
    routeMode: "reverse" as const,
    kind: "reverse" as const,
    layer: "cross" as const,
    workflowPhase: workflowPhase as WorkflowPhase,
  })),
  ...layers("redesign", "design", ["L1", "L2", "L3", "L4", "L5", "L6"]),
  ...layers("redesign", "add-design", ["L3", "L4", "L5", "L6"]),
  { routeMode: "recovery", kind: "recovery", layer: "cross" },
  { routeMode: "incident", kind: "troubleshoot", layer: "L7" },
  { routeMode: "incident", kind: "recovery", layer: "cross" },
  { routeMode: "refactor", kind: "refactor", layer: "L7" },
  { routeMode: "retrofit", kind: "retrofit", layer: "L7" },
  ...layers("add-feature", "add-design", ["L3", "L4", "L5", "L6"]),
  { routeMode: "add-feature", kind: "add-impl", layer: "L7" },
  ...layers("research", "research", ["L1", "L2", "L3", "L4"]),
  ...layers("design-bottomup", "add-design", ["L3", "L4", "L5", "L6"]),
  { routeMode: "design-bottomup", kind: "add-impl", layer: "L7" },
  { routeMode: "version-up", kind: "impl", layer: "L7" },
  ...layers("verify", "verify", ["L8", "L9", "L10", "L11", "L12", "L13", "L14"]),
];

function expectedPrefix(mode: AdmissionRouteMode): string {
  return mode === "forward" ? "work/forward-" : `work/${mode}-`;
}

function sameTuple(left: AdmissionTuple, right: AdmissionTuple): boolean {
  return (
    left.routeMode === right.routeMode &&
    left.kind === right.kind &&
    left.layer === right.layer &&
    left.workflowPhase === right.workflowPhase
  );
}

/** 起票の安全境界。候補提示routeFilingのfallbackを使用しない。 */
export function evaluatePlanAdmission(request: PlanAdmissionRequest): AdmissionDecision {
  const violations: AdmissionViolation[] = [];
  const signal = request.routeSignal.trim().toLowerCase();
  const candidates =
    signal === "forward" ? ["forward"] : [...new Set(routeSignalCandidates(signal))];

  if (candidates.length === 0) {
    violations.push({
      code: "plan-admission-unknown-signal",
      message: "未知signalは起票できません",
    });
  } else if (candidates.length !== 1 || candidates[0] !== request.routeMode) {
    violations.push({
      code: "plan-admission-ambiguous-route",
      message: "signalとroute_modeが一意に一致しません",
    });
  }

  const tuple: AdmissionTuple = {
    routeMode: request.routeMode,
    kind: request.kind,
    layer: request.layer,
    ...(request.workflowPhase ? { workflowPhase: request.workflowPhase } : {}),
  };
  if (!ADMISSION_TUPLES.some((allowed) => sameTuple(allowed, tuple))) {
    violations.push({
      code: "plan-admission-tuple-forbidden",
      message: "kind/layer/phaseの組合せは未許可です",
    });
  }
  if (request.status === "archived") {
    violations.push({
      code: "plan-admission-archived-forbidden",
      message: "新規起票にarchivedは使用できません",
    });
  }
  if (!request.branch.startsWith(expectedPrefix(request.routeMode))) {
    violations.push({
      code: "plan-admission-branch-forbidden",
      message: "branch prefixがroute_modeと一致しません",
    });
  }

  if (request.routeMode === "redesign" && request.supersedes?.length !== 1) {
    violations.push({
      code: "plan-admission-redesign-supersede-required",
      message: "redesignには差替える既存設計を一件だけ指定します",
    });
  }
  if (
    request.routeMode === "reverse" &&
    request.transitionDirection !== "implementation_to_design"
  ) {
    violations.push({
      code: "plan-admission-reverse-direction-required",
      message: "reverseは実装から設計へ引き戻す遷移だけを許可します",
    });
  }
  if (request.routeMode === "reverse" && request.implementationDisposition !== "preserved") {
    violations.push({
      code: "plan-admission-reverse-preserved-implementation-required",
      message: "reverseは活かす先行実装を明示します",
    });
  }
  if (request.routeMode === "redesign") {
    if (request.transitionDirection !== "design_to_implementation") {
      violations.push({
        code: "plan-admission-redesign-direction-required",
        message: "redesignは設計から実装へ降下する遷移だけを許可します",
      });
    }
    if (
      request.implementationDisposition !== "discarded" &&
      request.implementationDisposition !== "none"
    ) {
      violations.push({
        code: "plan-admission-redesign-no-preserved-implementation",
        message: "redesignは先行実装を廃棄済みまたは未存在として設計から実装します",
      });
    }
    if (
      !request.implementationTarget?.targetPlanId ||
      request.implementationTarget.targetRevision < 1
    ) {
      violations.push({
        code: "plan-admission-redesign-implementation-target-required",
        message: "redesignにはForward合流後に開始する実装PLANを指定します",
      });
    }
  }

  const issueRequired = request.routeMode !== "forward";
  if (issueRequired) {
    if (!request.issue?.issueId || !request.issue.episodeId || !request.issue.projectionDigest) {
      violations.push({
        code: "plan-admission-issue-required",
        message: "Forward外起票にはE4投影済みGitHub Issueが必要です",
      });
    }
    if (!request.origin?.planId || !request.origin.digest || request.origin.revision < 1) {
      violations.push({
        code: "plan-admission-origin-required",
        message: "Forward外起票にはorigin PLAN revisionが必要です",
      });
    }
    if (!request.reentry?.targetPlanId || request.reentry.targetRevision < 1) {
      violations.push({
        code: "plan-admission-reentry-required",
        message: "Forward外起票には再合流先が必要です",
      });
    }
    if (!request.escapeReason?.trim()) {
      violations.push({
        code: "plan-admission-escape-reason-required",
        message: "Forward外起票にはescape reasonが必要です",
      });
    }
  }
  return violations.length === 0 ? { ok: true, tuple, issueRequired } : { ok: false, violations };
}
