import { digestOf, reduceForward } from "../domain/reducer.ts";
import {
  type ForwardEventName,
  type ForwardState,
  transitionFor,
} from "../domain/transition-policy.ts";
import type {
  ForwardCommand,
  ForwardError,
  ForwardEvent,
  ForwardEvidenceContext,
  ForwardEvidenceEvaluator,
  ForwardReduction,
  ForwardSubject,
} from "../domain/types.ts";
import { ForwardWorkflow } from "../domain/workflow.ts";
import type { ForwardLedgerPort } from "../ports/forward-ledger.ts";
import type { ForwardProjectionPort } from "../ports/forward-projection.ts";

export interface ForwardTransitionRequest extends ForwardSubject {
  readonly event: ForwardEventName;
  readonly commandId?: string;
  readonly expectedFrom?: ForwardState;
  readonly evidence?: ForwardEvidenceContext["evidence"];
  readonly now?: string;
  readonly authorFamily?: "codex" | "claude";
  readonly exceptionContext?: ForwardCommand["exceptionContext"];
}

export interface ForwardCliEnvelope {
  readonly schemaVersion: "forward-cli/v1";
  readonly command: "status" | "transition" | "explain";
  readonly planId: string;
  readonly subjectId: string;
  readonly subjectRevision: number;
  readonly state: ForwardState | null;
  readonly currentState: ForwardState | null;
  readonly event: ForwardEventName | null;
  readonly nextState: ForwardState | null;
  readonly verdict: "allow" | "deny" | "explain";
  readonly ruleId: string;
  readonly evidence: {
    readonly required: readonly string[];
    readonly accepted: readonly string[];
    readonly rejected: readonly string[];
  };
  readonly digest: string;
  readonly exitCode: 0 | 1 | 2 | 3;
}

export interface ForwardApplicationDeps {
  readonly ledger: ForwardLedgerPort;
  readonly projection: ForwardProjectionPort;
  readonly evidencePolicy: ForwardEvidenceEvaluator;
  readonly frontmatterStatus?: string;
}

export class ForwardWorkflowApplication {
  readonly externalIntents: readonly never[] = Object.freeze([]);
  readonly deps: ForwardApplicationDeps;
  constructor(deps: ForwardApplicationDeps) {
    this.deps = deps;
  }
  get ledger(): ForwardLedgerPort {
    return this.deps.ledger;
  }
  get projection(): ForwardProjectionPort {
    return this.deps.projection;
  }

  status(subject: ForwardSubject): ForwardCliEnvelope {
    const loaded = this.load(subject);
    if (!loaded.ok) return this.errorEnvelope("status", subject, loaded);
    if (loaded.events.length === 0)
      return this.errorEnvelope("status", subject, {
        ok: false,
        ruleId: "forward-ledger-unavailable",
        exitCode: 3,
      });
    const reduced = reduceForward(loaded.events);
    if (!reduced.ok) return this.errorEnvelope("status", subject, reduced);
    const projection = this.deps.projection.read(subject);
    if (!projection.ok) return this.errorEnvelope("status", subject, projection);
    if (!this.projectionMatches(reduced, projection))
      return this.errorEnvelope("status", subject, {
        ok: false,
        ruleId: "forward-ledger-unavailable",
        exitCode: 3,
      });
    return this.envelope({
      command: "status",
      subject,
      reduced,
      verdict: "allow",
      ruleId: "forward-status",
      event: null,
      nextState: null,
      exitCode: 0,
    });
  }

  explain(
    subject: ForwardSubject,
    request: Omit<ForwardTransitionRequest, keyof ForwardSubject>,
  ): ForwardCliEnvelope {
    const loaded = this.load(subject);
    if (!loaded.ok) return this.errorEnvelope("explain", subject, loaded);
    if (loaded.events.length === 0)
      return this.errorEnvelope("explain", subject, {
        ok: false,
        ruleId: "forward-ledger-unavailable",
        exitCode: 3,
      });
    const workflow = ForwardWorkflow.reconstruct(subject, loaded.events, this.deps.evidencePolicy);
    if (!workflow.ok) return this.errorEnvelope("explain", subject, workflow);
    const reduced = reduceForward(loaded.events);
    if (!reduced.ok) return this.errorEnvelope("explain", subject, reduced);
    const projection = this.deps.projection.read(subject);
    if (!projection.ok || !this.projectionMatches(reduced, projection))
      return this.errorEnvelope("explain", subject, {
        ok: false,
        ruleId: "forward-ledger-unavailable",
        exitCode: 3,
      });
    const verdict = workflow.value.explain(request, request);
    return this.envelope({
      command: "explain",
      subject,
      reduced,
      verdict: "explain",
      ruleId: verdict.ruleId,
      event: null,
      nextState: null,
      exitCode: 0,
      evidence: verdict,
    });
  }

  transition(request: ForwardTransitionRequest): ForwardCliEnvelope {
    const subject: ForwardSubject = {
      subjectId: request.subjectId,
      subjectRevision: request.subjectRevision,
      sourceCommit: request.sourceCommit,
    };
    if (!this.deps.ledger.isAvailable() || !this.deps.projection.isAvailable())
      return this.errorEnvelope("transition", subject, {
        ok: false,
        ruleId: "forward-ledger-unavailable",
        exitCode: 3,
      });
    const loaded = this.load(subject);
    if (!loaded.ok) return this.errorEnvelope("transition", subject, loaded);
    const workflow = ForwardWorkflow.reconstruct(subject, loaded.events, this.deps.evidencePolicy);
    if (!workflow.ok) return this.errorEnvelope("transition", subject, workflow);
    const existing = request.commandId
      ? this.deps.ledger.findByCommand(subject, request.commandId)
      : null;
    if (existing) {
      const spec = transitionFor(request.event);
      const evidence = spec
        ? this.deps.evidencePolicy.evaluate({
            spec,
            subject,
            evidence: request.evidence ?? [],
            context: request,
          })
        : null;
      const expectedPayloadDigest =
        evidence?.usable && request.commandId
          ? digestOf({
              commandId: request.commandId,
              event: request.event,
              expectedFrom: request.expectedFrom ?? existing.fromState,
              subject,
              evidenceIds: [...new Set(evidence.accepted)].sort(bytewise),
              exceptionContext: request.exceptionContext ?? null,
            })
          : null;
      if (
        !expectedPayloadDigest ||
        existing.event !== request.event ||
        existing.payloadDigest !== expectedPayloadDigest
      )
        return this.errorEnvelope("transition", subject, {
          ok: false,
          ruleId: "forward-command-conflict",
          exitCode: 1,
        });
      const reduced = reduceForward(loaded.events);
      if (!reduced.ok) return this.errorEnvelope("transition", subject, reduced);
      const projected = this.deps.projection.read(subject);
      if (!projected.ok || !this.projectionMatches(reduced, projected)) {
        const repaired = this.deps.projection.project(subject, existing, reduced);
        if (!repaired.ok) return this.errorEnvelope("transition", subject, repaired);
        const rebuilt = this.deps.projection.read(subject);
        if (!rebuilt.ok || !this.projectionMatches(reduced, rebuilt))
          return this.errorEnvelope("transition", subject, {
            ok: false,
            ruleId: "forward-ledger-unavailable",
            exitCode: 3,
          });
      }
      return this.envelope({
        command: "transition",
        subject,
        reduced,
        verdict: "allow",
        ruleId: "forward-transition-replayed",
        event: existing.event,
        nextState: existing.toState,
        exitCode: 0,
      });
    }
    const verdict = workflow.value.explain(request, request);
    const reduced = reduceForward(loaded.events);
    if (!reduced.ok) return this.errorEnvelope("transition", subject, reduced);
    const projection = this.deps.projection.read(subject);
    if (
      (loaded.events.length === 0 && projection.ok) ||
      (loaded.events.length > 0 && (!projection.ok || !this.projectionMatches(reduced, projection)))
    )
      return this.errorEnvelope("transition", subject, {
        ok: false,
        ruleId: "forward-ledger-unavailable",
        exitCode: 3,
      });
    if (verdict.verdict === "deny")
      return this.envelope({
        command: "transition",
        subject,
        reduced,
        verdict: "deny",
        ruleId: verdict.ruleId,
        event: null,
        nextState: null,
        exitCode: verdict.exitCode,
        evidence: verdict,
      });
    const next = workflow.value.transition(request, request);
    if (!next.ok) return this.errorEnvelope("transition", subject, next);
    const appended = this.deps.ledger.append(next.value.event);
    if (!appended.ok) return this.errorEnvelope("transition", subject, appended);
    const after = reduceForward([...loaded.events, appended.event]);
    if (!after.ok) return this.errorEnvelope("transition", subject, after);
    if (!appended.replayed) {
      const projected = this.deps.projection.project(subject, appended.event, after);
      if (!projected.ok) return this.errorEnvelope("transition", subject, projected);
      const rebuilt = this.deps.projection.read(subject);
      if (!rebuilt.ok || !this.projectionMatches(after, rebuilt))
        return this.errorEnvelope("transition", subject, {
          ok: false,
          ruleId: "forward-ledger-unavailable",
          exitCode: 3,
        });
    }
    return this.envelope({
      command: "transition",
      subject,
      reduced: after,
      verdict: "allow",
      ruleId: "forward-transition-allowed",
      event: appended.event.event,
      nextState: appended.event.toState,
      exitCode: 0,
      evidence: verdict,
    });
  }

  private load(
    subject: ForwardSubject,
  ): { readonly ok: true; readonly events: readonly ForwardEvent[] } | ForwardError {
    return this.deps.ledger.reconstruct(subject);
  }

  private errorEnvelope(
    command: "status" | "transition" | "explain",
    subject: ForwardSubject,
    error: ForwardError,
  ): ForwardCliEnvelope {
    return this.envelope({
      command,
      subject,
      reduced: null,
      verdict: "deny",
      ruleId: error.ruleId,
      event: null,
      nextState: null,
      exitCode: error.exitCode,
    });
  }

  private envelope(input: {
    readonly command: "status" | "transition" | "explain";
    readonly subject: ForwardSubject;
    readonly reduced: ForwardReduction | null;
    readonly verdict: "allow" | "deny" | "explain";
    readonly ruleId: string;
    readonly event: ForwardEventName | null;
    readonly nextState: ForwardState | null;
    readonly exitCode: 0 | 1 | 2 | 3;
    readonly evidence?: Partial<{
      required: readonly string[];
      accepted: readonly string[];
      rejected: readonly string[];
    }>;
  }): ForwardCliEnvelope {
    return {
      schemaVersion: "forward-cli/v1",
      command: input.command,
      planId: input.subject.subjectId,
      subjectId: input.subject.subjectId,
      subjectRevision: input.subject.subjectRevision,
      state: input.reduced?.state ?? null,
      currentState: input.reduced?.state ?? null,
      event: input.event,
      nextState: input.nextState,
      verdict: input.verdict,
      ruleId: input.ruleId,
      evidence: {
        required: input.evidence?.required ?? [],
        accepted: input.evidence?.accepted ?? [],
        rejected: input.evidence?.rejected ?? [],
      },
      digest: input.reduced ? `sha256:${input.reduced.digest}` : `sha256:${"0".repeat(64)}`,
      exitCode: input.exitCode,
    };
  }

  private projectionMatches(reduced: ForwardReduction, projection: ForwardReduction): boolean {
    return (
      projection.state === reduced.state &&
      projection.digest === reduced.digest &&
      projection.stateDigest === reduced.stateDigest
    );
  }
}

function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
