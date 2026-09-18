import type { EvidenceRecord } from "../../plan-asset/domain/evidence-record.ts";
import type { ForwardEventName, ForwardState, TransitionSpec } from "./transition-policy.ts";

export interface ForwardSubject {
  readonly subjectId: string;
  readonly subjectRevision: number;
  readonly sourceCommit: string;
}

export interface ForwardExceptionContext {
  readonly action: "block" | "reject" | "supersede" | "reopen" | "resume";
  readonly actor: string;
  readonly reason: string;
  readonly subjectRevision: number;
  readonly sourceCommit: string;
  readonly resumeState?: ForwardState;
  readonly replacementSubjectId?: string;
}

export interface ForwardEvent extends ForwardSubject {
  readonly eventId: string;
  readonly commandId: string;
  readonly sequence: number;
  readonly event: ForwardEventName;
  readonly fromState: ForwardState;
  readonly toState: ForwardState;
  readonly evidenceIds: readonly string[];
  readonly payloadDigest: string;
  readonly digest: string;
  readonly exceptionContext?: ForwardExceptionContext;
}

export interface ForwardCommand {
  readonly event: ForwardEventName;
  readonly commandId?: string;
  readonly expectedFrom?: ForwardState;
  readonly sourceCommit?: string;
  readonly evidenceIds?: readonly string[];
  readonly exceptionContext?: ForwardExceptionContext;
}

export interface ForwardEvidenceContext {
  readonly evidence?: readonly EvidenceRecord[];
  readonly now?: string;
  readonly authorFamily?: "codex" | "claude";
  readonly evidencePolicy?: ForwardEvidenceEvaluator;
}

export interface ForwardEvidenceResult {
  readonly usable: boolean;
  readonly required: readonly string[];
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export interface ForwardEvidenceEvaluationInput {
  readonly spec: TransitionSpec;
  readonly subject: ForwardSubject;
  readonly evidence: readonly EvidenceRecord[];
  readonly context: ForwardEvidenceContext;
}

export interface ForwardEvidenceEvaluator {
  evaluate(input: ForwardEvidenceEvaluationInput): ForwardEvidenceResult;
}

export interface ForwardGuardVerdict extends ForwardEvidenceResult {
  readonly verdict: "allow" | "deny";
  readonly ruleId: string;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly state: ForwardState;
  readonly event: ForwardEventName | null;
  readonly nextState: ForwardState | null;
}

export interface ForwardReduction {
  readonly ok: true;
  readonly state: ForwardState;
  readonly digest: string;
  readonly stateDigest: string;
  readonly events: readonly ForwardEvent[];
  readonly eventDigests: readonly string[];
}

export interface ForwardError {
  readonly ok: false;
  readonly ruleId: string;
  readonly exitCode: 1 | 2 | 3;
  readonly message?: string;
}

export type ForwardResult<T> = { readonly ok: true; readonly value: T } | ForwardError;

export interface ForwardTransition {
  readonly event: ForwardEvent;
  readonly nextState: ForwardState;
  readonly digest: string;
}
