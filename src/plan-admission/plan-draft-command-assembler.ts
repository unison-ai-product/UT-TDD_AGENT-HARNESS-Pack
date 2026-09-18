import {
  type CanonicalPlanDraftCommand,
  calculatePlanDraftCommandDigests,
} from "../kernel/plan-draft-command-digest.ts";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import { parseReservablePlanIdIdentity, planIdMatchesShape } from "../schema/plan-id.ts";
import type { PlanDraftCommand } from "./plan-draft-service.ts";
import {
  type AdmissionDecision,
  evaluatePlanAdmission,
  type PlanAdmissionRequest,
} from "./policy.ts";

export interface DraftManifestV2 {
  readonly version: 2;
  readonly command_id: string;
  readonly plan_id: string;
  readonly recorded_at: string;
  readonly admission: unknown;
  readonly source: { readonly path: string; readonly content: string };
  readonly projection: { readonly path: string };
}

/** Git、clock、ID採番器から取得済みの値。assembler自身は外部状態を読み取らない。 */
export interface PlanDraftEnvironmentSnapshot {
  readonly assetId: string;
  readonly reservationId: string;
  readonly certificateId: string;
  readonly namespace: string;
  readonly ordinal: number;
  readonly sourceCommit: string;
  readonly actor: string;
  readonly reason: string;
  readonly identityAlgorithm: string;
  readonly bodyDigest: string;
  readonly routeTupleDigest: string;
  readonly leaseTokenHash: string;
  readonly expiresAt: string;
}

export interface AssembledPlanDraftCommand {
  readonly canonical: CanonicalPlanDraftCommand;
  readonly command: PlanDraftCommand<PlanDraftExecutionPayload>;
}

export interface PlanDraftExecutionPayload {
  readonly canonical: CanonicalPlanDraftCommand;
  readonly admission: PlanAdmissionRequest;
}

type AdmittedDecision = Extract<AdmissionDecision, { ok: true }>;

/**
 * 検証済みmanifest/admissionと明示snapshotを、一つの改変検知可能なcommandへ束縛する。
 * digestの自己申告は受け取らず、全digestはdomainの共通計算境界から導出する。
 */
export function assemblePlanDraftCommand(input: {
  readonly manifest: DraftManifestV2;
  readonly admission: PlanAdmissionRequest;
  readonly decision: AdmittedDecision;
  readonly environment: PlanDraftEnvironmentSnapshot;
}): AssembledPlanDraftCommand {
  const { manifest, admission, decision, environment } = input;
  const identity = parsePlanIdentity(manifest.plan_id);
  const parsed = parseLegacyPlanSource(manifest.source.content);
  if (!parsed || parsed.planId !== manifest.plan_id) fail("plan-draft-source-plan-id-mismatch");
  const canonicalDecision = evaluatePlanAdmission(admission);
  if (!canonicalDecision.ok || !sameDecision(decision, canonicalDecision))
    fail("plan-draft-admission-decision-mismatch");
  if (
    !planIdMatchesShape(identity, admission) ||
    parsed.frontmatter.kind !== admission.kind ||
    parsed.frontmatter.layer !== admission.layer ||
    parsed.frontmatter.drive !== admission.drive ||
    parsed.frontmatter.route_signal !== admission.routeSignal ||
    parsed.frontmatter.route_mode !== admission.routeMode ||
    parsed.frontmatter.workflow_phase !== admission.workflowPhase
  )
    fail("plan-draft-source-admission-mismatch");
  if (manifest.source.path !== `docs/plans/${manifest.plan_id}.md`)
    fail("plan-draft-source-path-mismatch");
  if (environment.namespace !== identity.namespace || environment.ordinal !== identity.ordinal)
    fail("plan-draft-plan-id-reservation-mismatch");
  validateSnapshot(manifest, environment);

  const canonicalPayloadJson = stableJson({
    schemaVersion: 1,
    manifest: {
      version: manifest.version,
      commandId: manifest.command_id,
      planId: manifest.plan_id,
      recordedAt: manifest.recorded_at,
      source: manifest.source,
      projection: manifest.projection,
    },
    admittedRequest: admission,
    admittedDecision: canonicalDecision,
    environment,
  });
  const canonical: CanonicalPlanDraftCommand = Object.freeze({
    commandId: manifest.command_id,
    assetId: environment.assetId,
    planId: manifest.plan_id,
    alias: manifest.plan_id,
    sourcePath: manifest.source.path,
    projectionPath: manifest.projection.path,
    sourceCommit: environment.sourceCommit,
    actor: environment.actor,
    reason: environment.reason,
    canonicalPayloadJson,
    bodyDigest: environment.bodyDigest,
    identityAlgorithm: environment.identityAlgorithm,
    reservationId: environment.reservationId,
    namespace: environment.namespace,
    ordinal: environment.ordinal,
    leaseTokenHash: environment.leaseTokenHash,
    expiresAt: environment.expiresAt,
    routeTupleDigest: environment.routeTupleDigest,
    certificateId: environment.certificateId,
    occurredAt: manifest.recorded_at,
  });
  const { commandPayloadDigest } = calculatePlanDraftCommandDigests(canonical);
  const payload: PlanDraftExecutionPayload = Object.freeze({ canonical, admission });
  const command: PlanDraftCommand<PlanDraftExecutionPayload> = Object.freeze({
    commandId: canonical.commandId,
    commandPayloadDigest,
    planId: canonical.planId,
    recordedAt: canonical.occurredAt,
    payload,
    source: Object.freeze({ ...manifest.source }),
    projectionPath: canonical.projectionPath,
  });
  return Object.freeze({ canonical, command });
}

function parsePlanIdentity(planId: string) {
  const identity = parseReservablePlanIdIdentity(planId);
  if (!identity) fail("plan-draft-plan-id-invalid");
  return identity;
}

function sameDecision(left: AdmittedDecision, right: AdmittedDecision): boolean {
  return (
    left.issueRequired === right.issueRequired &&
    left.tuple.routeMode === right.tuple.routeMode &&
    left.tuple.kind === right.tuple.kind &&
    left.tuple.layer === right.tuple.layer &&
    left.tuple.workflowPhase === right.tuple.workflowPhase
  );
}

function validateSnapshot(manifest: DraftManifestV2, snapshot: PlanDraftEnvironmentSnapshot): void {
  if (
    !manifest.command_id.trim() ||
    !snapshot.assetId.trim() ||
    !snapshot.reservationId.trim() ||
    !snapshot.certificateId.trim() ||
    !snapshot.actor.trim() ||
    !snapshot.reason.trim() ||
    !snapshot.identityAlgorithm.trim()
  )
    fail("plan-draft-environment-invalid");
  if (
    !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(snapshot.sourceCommit) ||
    !validSha(snapshot.bodyDigest) ||
    !validSha(snapshot.routeTupleDigest) ||
    !validSha(snapshot.leaseTokenHash)
  )
    fail("plan-draft-environment-invalid");
  const occurredAt = Date.parse(manifest.recorded_at);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(occurredAt) || !Number.isFinite(expiresAt) || expiresAt <= occurredAt)
    fail("plan-draft-environment-invalid");
}

function validSha(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(ruleId: string): never {
  throw new Error(ruleId);
}
