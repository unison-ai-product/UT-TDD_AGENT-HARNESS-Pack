import { createHash } from "node:crypto";
import type {
  PackPublicationPreparationReceipt,
  PublicationPortResult,
} from "./pack-publication-adapter.ts";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/**
 * Honest implementation trace for this bounded slice. The remaining PLAN
 * candidates stay explicit until their independent one-axis oracle lands;
 * this metadata prevents the focused slice from being mistaken for the full
 * 70-candidate closure.
 */
export const PACK_PUBLICATION_ADMISSION_COVERAGE = Object.freeze({
  implemented: [
    "CANDIDATE-PACKPUB-ADM-001",
    "CANDIDATE-PACKPUB-ADM-002",
    "CANDIDATE-PACKPUB-ADM-003",
    "CANDIDATE-PACKPUB-ADM-004",
    "CANDIDATE-PACKPUB-ADM-005",
    "CANDIDATE-PACKPUB-ADM-006",
    "CANDIDATE-PACKPUB-ADM-007",
    "CANDIDATE-PACKPUB-ADM-008",
    "CANDIDATE-PACKPUB-ADM-009",
    "CANDIDATE-PACKPUB-ADM-010",
    "CANDIDATE-PACKPUB-ADM-011",
    "CANDIDATE-PACKPUB-ADM-012",
    "CANDIDATE-PACKPUB-ADM-013",
    "CANDIDATE-PACKPUB-ADM-014",
    "CANDIDATE-PACKPUB-ADM-015",
    "CANDIDATE-PACKPUB-ADM-020",
    "CANDIDATE-PACKPUB-ADM-036",
    "CANDIDATE-PACKPUB-ADM-040",
    "CANDIDATE-PACKPUB-ADM-042",
    "CANDIDATE-PACKPUB-ADM-048",
    "CANDIDATE-PACKPUB-ADM-057",
  ] as const,
  deferred: [
    "CANDIDATE-PACKPUB-ADM-016..019",
    "CANDIDATE-PACKPUB-ADM-021..035",
    "CANDIDATE-PACKPUB-ADM-037..039",
    "CANDIDATE-PACKPUB-ADM-041",
    "CANDIDATE-PACKPUB-ADM-043..047",
    "CANDIDATE-PACKPUB-ADM-049..056",
    "CANDIDATE-PACKPUB-ADM-058..070",
  ] as const,
});

export interface PackPublicationAdmissionConfiguration {
  readonly repositoryId: number;
  readonly repository: string;
  readonly targetRef: string;
  readonly rulesetId: number;
  readonly requiredContexts: readonly string[];
  readonly casAuthorityInstallationId: number;
}

export interface PackPublicationAdmissionApprovalReference {
  readonly nonce: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly intentBindingDigest: string;
  readonly consumed: boolean;
  readonly preparation: boolean;
}

export interface PackPublicationRepositoryObservation {
  readonly repositoryId: number;
  readonly repository: string;
  readonly targetRef: string;
  readonly rulesetId: number;
  readonly requiredContexts: readonly string[];
  readonly casAuthorityInstallationId: number;
}

export interface PackPublicationPullRequestAdmissionObservation {
  readonly pullRequest: string;
  readonly branch: string;
  readonly headOid: string;
  readonly baseOid: string;
  readonly treeDigest: string;
}

export interface PackPublicationReviewObservation {
  readonly pullRequest: string;
  readonly reviewedHead: string;
  readonly conclusion: "approved" | "changes_requested" | "commented";
  readonly reviewer: string;
  readonly author: string;
  readonly closingReceiptDigest: string;
}

export interface PackPublicationCheckObservation {
  readonly headOid: string;
  readonly checks: readonly Readonly<{ context: string; conclusion: string }>[];
}

export interface PackPublicationMergeBaseObservation {
  readonly mergeBase: string;
}

export interface PackPublicationSealedStagingObservation {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly treeDigest: string;
  readonly manifestDigest: string;
  readonly expectedMainOid: string;
  readonly branch: string;
}

export interface PackPublicationAdmissionObserver {
  readonly repository: () =>
    | PublicationPortResult<PackPublicationRepositoryObservation>
    | Promise<PublicationPortResult<PackPublicationRepositoryObservation>>;
  readonly pullRequest: (
    pullRequest: string,
  ) =>
    | PublicationPortResult<PackPublicationPullRequestAdmissionObservation>
    | Promise<PublicationPortResult<PackPublicationPullRequestAdmissionObservation>>;
  readonly review: (
    pullRequest: string,
  ) =>
    | PublicationPortResult<PackPublicationReviewObservation>
    | Promise<PublicationPortResult<PackPublicationReviewObservation>>;
  readonly checks: (
    headOid: string,
  ) =>
    | PublicationPortResult<PackPublicationCheckObservation>
    | Promise<PublicationPortResult<PackPublicationCheckObservation>>;
  readonly mergeBase: (input: {
    readonly headOid: string;
    readonly expectedMainOid: string;
  }) =>
    | PublicationPortResult<PackPublicationMergeBaseObservation>
    | Promise<PublicationPortResult<PackPublicationMergeBaseObservation>>;
  readonly staging: (
    operationId: string,
  ) =>
    | PublicationPortResult<PackPublicationSealedStagingObservation | null>
    | Promise<PublicationPortResult<PackPublicationSealedStagingObservation | null>>;
}

export interface PackPublicationAdmissionLedgerRecord {
  readonly status: "admitted";
  readonly sequence: number;
  readonly previousRecordDigest: string | null;
  readonly recordDigest: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly pullRequest: string;
  readonly observationBundleDigest: string;
  readonly publicationIntentIdentity: string;
  readonly approvalBindings: readonly string[];
  readonly sealed: Readonly<PackPublicationAdmissionSealedValues>;
}

export interface PackPublicationAdmissionSealedValues {
  readonly repositoryId: number;
  readonly repository: string;
  readonly targetRef: string;
  readonly rulesetId: number;
  readonly requiredContexts: readonly string[];
  readonly casAuthorityInstallationId: number;
  readonly expectedMainOid: string;
  readonly preparationReceiptDigest: string;
  readonly reviewedPullRequest: string;
  readonly reviewedHead: string;
  readonly baseOid: string;
  readonly treeDigest: string;
  readonly reviewConclusion: "approved";
  readonly reviewer: string;
  readonly closingReceiptDigest: string;
  readonly requiredCheckConclusions: readonly Readonly<{
    context: string;
    conclusion: "success";
  }>[];
  readonly mergeBase: string;
  readonly publicationIntentIdentity: string;
  readonly approvalBindings: readonly string[];
  readonly observationBundleDigest: string;
}

export interface PackPublicationAdmissionLedger {
  readonly read: () =>
    | readonly PackPublicationAdmissionLedgerRecord[]
    | Promise<readonly PackPublicationAdmissionLedgerRecord[]>;
  readonly append: (record: PackPublicationAdmissionLedgerRecord) => void | Promise<void>;
  readonly appendObservation: (input: {
    readonly recordDigest: string;
    readonly observationBundleDigest: string;
    readonly operationId: string;
  }) => void | Promise<void>;
}

export interface PackPublicationAdmissionInput {
  readonly receipt: unknown;
  readonly configuration: PackPublicationAdmissionConfiguration;
  readonly approvals: readonly PackPublicationAdmissionApprovalReference[];
  readonly observer: PackPublicationAdmissionObserver;
  readonly ledger: PackPublicationAdmissionLedger;
  readonly caller?: Readonly<{
    reviewedHead?: string;
    baseOid?: string;
    checks?: PackPublicationCheckObservation;
    closingReceiptDigest?: string;
    configuration?: PackPublicationAdmissionConfiguration;
    preparationReceiptDigest?: string;
    publicationIntentIdentity?: string;
  }>;
}

export type PackPublicationAdmissionFailureStatus = "denied" | "indeterminate";

export type PackPublicationAdmissionResult =
  | {
      readonly ok: true;
      readonly status: "admitted";
      readonly record: PackPublicationAdmissionLedgerRecord;
      readonly remoteWrites: 0;
      readonly approvalConsumes: 0;
    }
  | {
      readonly ok: false;
      readonly status: PackPublicationAdmissionFailureStatus;
      readonly phase: "admission";
      readonly reason: string;
      readonly remoteWrites: 0;
      readonly approvalConsumes: 0;
    };

export function derivePackPublicationPreparationReceiptDigest(
  receipt: PackPublicationPreparationReceipt,
): string {
  return digest(receipt);
}

export function derivePackPublicationAdmissionIntentIdentity(input: {
  readonly operationId: string;
  readonly repositoryId: number;
  readonly targetRef: string;
  readonly expectedMainOid: string;
  readonly reviewedHead: string;
  readonly preparationReceiptDigest: string;
}): string {
  return digest({
    operationId: input.operationId,
    repositoryId: input.repositoryId,
    targetRef: input.targetRef,
    expectedMainOid: input.expectedMainOid,
    reviewedHead: input.reviewedHead,
    preparationReceiptDigest: input.preparationReceiptDigest,
  });
}

export function derivePackPublicationAdmissionApprovalBinding(input: {
  readonly nonce: string;
  readonly publicationIntentIdentity: string;
}): string {
  return digest(input);
}

export function derivePackPublicationAdmissionRecordDigest(
  record: Omit<PackPublicationAdmissionLedgerRecord, "recordDigest">,
): string {
  return digest(record);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function deny(reason: string): PackPublicationAdmissionResult {
  return {
    ok: false,
    status: "denied",
    phase: "admission",
    reason,
    remoteWrites: 0,
    approvalConsumes: 0,
  };
}

function indeterminate(reason: string): PackPublicationAdmissionResult {
  return {
    ok: false,
    status: "indeterminate",
    phase: "admission",
    reason,
    remoteWrites: 0,
    approvalConsumes: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReceipt(value: unknown): value is PackPublicationPreparationReceipt {
  if (!isRecord(value)) return false;
  if (value.kind !== "pack-publication-preparation-receipt-v1") return false;
  if (
    !isRecord(value.identity) ||
    !isRecord(value.binding) ||
    !isRecord(value.read_back_observation)
  )
    return false;
  const identity = value.identity;
  const binding = value.binding;
  const readBack = value.read_back_observation;
  return (
    Object.keys(value).sort().join(",") === "binding,identity,kind,read_back_observation" &&
    typeof identity.pullRequest === "string" &&
    /^[1-9][0-9]*$/.test(identity.pullRequest) &&
    typeof identity.headOid === "string" &&
    SHA1.test(identity.headOid) &&
    typeof identity.baseOid === "string" &&
    SHA1.test(identity.baseOid) &&
    typeof identity.treeDigest === "string" &&
    SHA256.test(identity.treeDigest) &&
    Object.keys(identity).sort().join(",") === "baseOid,headOid,pullRequest,treeDigest" &&
    typeof binding.operationId === "string" &&
    binding.operationId.length > 0 &&
    Object.keys(binding).length === 1 &&
    Object.keys(binding)[0] === "operationId" &&
    typeof readBack.journalEventDigest === "string" &&
    SHA256.test(readBack.journalEventDigest) &&
    typeof readBack.pullRequest === "string" &&
    readBack.pullRequest === identity.pullRequest &&
    Object.keys(readBack).sort().join(",") === "journalEventDigest,pullRequest"
  );
}

function resultFailure(
  result: PublicationPortResult<unknown>,
): PackPublicationAdmissionResult | null {
  if (result.status === "attested") return null;
  if (result.status === "mismatch") return deny(result.reason);
  return indeterminate(result.reason);
}

function validRepositoryObservation(value: unknown): value is PackPublicationRepositoryObservation {
  if (!isRecord(value)) return false;
  const repositoryId = value.repositoryId;
  const rulesetId = value.rulesetId;
  const installationId = value.casAuthorityInstallationId;
  if (!Number.isSafeInteger(repositoryId) || (repositoryId as number) <= 0) return false;
  if (typeof value.repository !== "string" || typeof value.targetRef !== "string") return false;
  if (!Number.isSafeInteger(rulesetId) || (rulesetId as number) <= 0) return false;
  if (
    !Array.isArray(value.requiredContexts) ||
    !value.requiredContexts.every((item) => typeof item === "string")
  )
    return false;
  return Number.isSafeInteger(installationId) && (installationId as number) > 0;
}

function validStagingObservation(
  value: unknown,
): value is PackPublicationSealedStagingObservation | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.operationId === "string" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.treeDigest === "string" &&
    typeof value.manifestDigest === "string" &&
    typeof value.expectedMainOid === "string" &&
    typeof value.branch === "string"
  );
}

function validPullRequestObservation(
  value: unknown,
): value is PackPublicationPullRequestAdmissionObservation {
  if (!isRecord(value)) return false;
  return (
    typeof value.pullRequest === "string" &&
    /^[1-9][0-9]*$/.test(value.pullRequest) &&
    typeof value.branch === "string" &&
    value.branch.length > 0 &&
    typeof value.headOid === "string" &&
    SHA1.test(value.headOid) &&
    typeof value.baseOid === "string" &&
    SHA1.test(value.baseOid) &&
    typeof value.treeDigest === "string" &&
    SHA256.test(value.treeDigest)
  );
}

function validReviewObservation(value: unknown): value is PackPublicationReviewObservation {
  if (!isRecord(value)) return false;
  return (
    typeof value.pullRequest === "string" &&
    typeof value.reviewedHead === "string" &&
    typeof value.conclusion === "string" &&
    typeof value.reviewer === "string" &&
    typeof value.author === "string" &&
    typeof value.closingReceiptDigest === "string"
  );
}

function validChecksObservation(value: unknown): value is PackPublicationCheckObservation {
  if (!isRecord(value) || typeof value.headOid !== "string" || !Array.isArray(value.checks))
    return false;
  return value.checks.every(
    (check) =>
      isRecord(check) && typeof check.context === "string" && typeof check.conclusion === "string",
  );
}

function validMergeBaseObservation(value: unknown): value is PackPublicationMergeBaseObservation {
  return isRecord(value) && typeof value.mergeBase === "string" && SHA1.test(value.mergeBase);
}

function validLedgerRecord(record: PackPublicationAdmissionLedgerRecord): boolean {
  const { recordDigest: _recordDigest, ...withoutDigest } = record;
  return derivePackPublicationAdmissionRecordDigest(withoutDigest) === record.recordDigest;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((item) => right.includes(item))
  );
}

function configValid(value: unknown): value is PackPublicationAdmissionConfiguration {
  if (!isRecord(value)) return false;
  const requiredContexts = value.requiredContexts;
  return (
    Number.isSafeInteger(value.repositoryId) &&
    (value.repositoryId as number) > 0 &&
    typeof value.repository === "string" &&
    value.repository.length > 0 &&
    typeof value.targetRef === "string" &&
    value.targetRef.length > 0 &&
    Number.isSafeInteger(value.rulesetId) &&
    (value.rulesetId as number) > 0 &&
    Array.isArray(requiredContexts) &&
    requiredContexts.length > 0 &&
    requiredContexts.every((item) => typeof item === "string") &&
    sameSet(requiredContexts, requiredContexts) &&
    Number.isSafeInteger(value.casAuthorityInstallationId) &&
    (value.casAuthorityInstallationId as number) > 0
  );
}

function callerMatches(input: {
  readonly caller: PackPublicationAdmissionInput["caller"];
  readonly config: PackPublicationAdmissionConfiguration;
  readonly baseOid: string;
  readonly review: PackPublicationReviewObservation;
  readonly checks: PackPublicationCheckObservation;
  readonly receiptDigest: string;
  readonly intentIdentity: string;
}): string | null {
  const { caller, config, baseOid, review, checks, receiptDigest, intentIdentity } = input;
  if (!caller) return null;
  if (caller.reviewedHead !== undefined && caller.reviewedHead !== review.reviewedHead)
    return "admission_caller_override";
  if (caller.baseOid !== undefined && caller.baseOid !== baseOid)
    return "admission_caller_override";
  if (caller.checks !== undefined && canonical(caller.checks) !== canonical(checks))
    return "admission_caller_override";
  if (
    caller.closingReceiptDigest !== undefined &&
    caller.closingReceiptDigest !== review.closingReceiptDigest
  )
    return "admission_caller_override";
  if (caller.configuration !== undefined && canonical(caller.configuration) !== canonical(config))
    return "admission_caller_override";
  if (
    caller.preparationReceiptDigest !== undefined &&
    caller.preparationReceiptDigest !== receiptDigest
  )
    return "admission_receipt_digest_override";
  if (
    caller.publicationIntentIdentity !== undefined &&
    caller.publicationIntentIdentity !== intentIdentity
  )
    return "admission_intent_override";
  return null;
}

function findReplay(
  records: readonly PackPublicationAdmissionLedgerRecord[],
  input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly pullRequest: string;
    readonly expectedMainOid: string;
    readonly observationBundleDigest: string;
  },
): PackPublicationAdmissionLedgerRecord | PackPublicationAdmissionResult | null {
  const matching = records.filter(
    (record) =>
      record.operationId === input.operationId ||
      record.idempotencyKey === input.idempotencyKey ||
      record.pullRequest === input.pullRequest,
  );
  if (matching.length === 0) return null;
  const exact = matching.find(
    (record) =>
      record.operationId === input.operationId &&
      record.idempotencyKey === input.idempotencyKey &&
      record.pullRequest === input.pullRequest &&
      record.observationBundleDigest === input.observationBundleDigest,
  );
  if (exact) return exact;
  if (matching.some((record) => record.operationId === input.operationId))
    return deny("admission_operation_replay");
  if (matching.some((record) => record.idempotencyKey === input.idempotencyKey))
    return deny("admission_idempotency_replay");
  if (
    matching.some(
      (record) =>
        record.pullRequest === input.pullRequest &&
        record.sealed.expectedMainOid !== input.expectedMainOid,
    )
  )
    return deny("admission_pr_expected_main_conflict");
  return deny("admission_pr_replay");
}

export async function admitPackPublication(
  input: PackPublicationAdmissionInput,
): Promise<PackPublicationAdmissionResult> {
  if (input.receipt === undefined || input.receipt === null)
    return deny("admission_receipt_missing");
  if (!validReceipt(input.receipt)) return deny("admission_receipt_invalid");
  if (!configValid(input.configuration)) return deny("admission_configuration_invalid");
  const receipt = input.receipt;
  const receiptDigest = derivePackPublicationPreparationReceiptDigest(receipt);
  let repositoryResult: PublicationPortResult<PackPublicationRepositoryObservation>;
  try {
    repositoryResult = await input.observer.repository();
  } catch {
    return indeterminate("repository_observation_unavailable");
  }
  const repositoryFailure = resultFailure(repositoryResult);
  if (repositoryFailure) return repositoryFailure;
  if (repositoryResult.status !== "attested")
    return indeterminate("repository_observation_unavailable");
  if (!validRepositoryObservation(repositoryResult.value))
    return indeterminate("repository_observation_schema_invalid");
  const repository = repositoryResult.value;
  if (repository.repositoryId !== input.configuration.repositoryId)
    return deny("admission_repository_id_mismatch");
  if (repository.repository !== input.configuration.repository)
    return deny("admission_repository_name_mismatch");
  if (repository.targetRef !== input.configuration.targetRef)
    return deny("admission_target_ref_mismatch");
  if (repository.rulesetId !== input.configuration.rulesetId)
    return deny("admission_ruleset_mismatch");
  if (repository.casAuthorityInstallationId !== input.configuration.casAuthorityInstallationId)
    return deny("admission_installation_mismatch");
  if (!sameSet(repository.requiredContexts, input.configuration.requiredContexts))
    return repository.requiredContexts.length === 0
      ? deny("admission_checks_missing")
      : deny("admission_required_context_set_mismatch");
  let prResult: PublicationPortResult<PackPublicationPullRequestAdmissionObservation>;
  try {
    prResult = await input.observer.pullRequest(receipt.identity.pullRequest);
  } catch {
    return indeterminate("pull_request_observation_unavailable");
  }
  const prFailure = resultFailure(prResult);
  if (prFailure) return prFailure;
  if (prResult.status !== "attested") return indeterminate("pull_request_observation_unavailable");
  if (!validPullRequestObservation(prResult.value))
    return indeterminate("pull_request_observation_schema_invalid");
  const pr = prResult.value;
  if (pr.pullRequest !== receipt.identity.pullRequest) return deny("admission_pr_mismatch");
  if (pr.headOid !== receipt.identity.headOid) return deny("admission_head_mismatch");
  if (pr.baseOid !== receipt.identity.baseOid) return deny("admission_base_mismatch");
  if (pr.treeDigest !== receipt.identity.treeDigest) return deny("admission_tree_digest_mismatch");
  let reviewResult: PublicationPortResult<PackPublicationReviewObservation>;
  try {
    reviewResult = await input.observer.review(pr.pullRequest);
  } catch {
    return indeterminate("review_observation_unavailable");
  }
  const reviewFailure = resultFailure(reviewResult);
  if (reviewFailure) return reviewFailure;
  if (reviewResult.status !== "attested") return indeterminate("review_observation_unavailable");
  if (!validReviewObservation(reviewResult.value))
    return indeterminate("review_observation_schema_invalid");
  const review = reviewResult.value;
  if (review.pullRequest !== pr.pullRequest) return deny("admission_review_pr_mismatch");
  if (!SHA1.test(review.reviewedHead)) return deny("admission_review_head_invalid");
  if (review.reviewedHead !== pr.headOid) return deny("admission_review_head_mismatch");
  if (review.conclusion !== "approved") return deny("admission_review_not_approved");
  if (review.reviewer === review.author) return deny("admission_review_author_conflict");
  if (!SHA256.test(review.closingReceiptDigest)) return deny("admission_review_receipt_invalid");
  let checksResult: PublicationPortResult<PackPublicationCheckObservation>;
  try {
    checksResult = await input.observer.checks(review.reviewedHead);
  } catch {
    return indeterminate("checks_observation_unavailable");
  }
  const checksFailure = resultFailure(checksResult);
  if (checksFailure) return checksFailure;
  if (checksResult.status !== "attested") return indeterminate("checks_observation_unavailable");
  if (!validChecksObservation(checksResult.value))
    return indeterminate("checks_observation_schema_invalid");
  const checks = checksResult.value;
  if (checks.headOid !== review.reviewedHead) return deny("admission_checks_head_mismatch");
  if (
    !checks.checks.every(
      (check) => typeof check.context === "string" && typeof check.conclusion === "string",
    )
  )
    return indeterminate("checks_observation_schema_invalid");
  const required = checks.checks.filter((check) =>
    input.configuration.requiredContexts.includes(check.context),
  );
  if (required.length === 0) return deny("admission_checks_missing");
  if (
    !input.configuration.requiredContexts.every((context) =>
      required.some((check) => check.context === context),
    )
  )
    return deny("admission_required_context_uncovered");
  if (!required.every((check) => check.conclusion === "success"))
    return deny("admission_check_not_success");
  let stagingResult: PublicationPortResult<PackPublicationSealedStagingObservation | null>;
  try {
    stagingResult = await input.observer.staging(receipt.binding.operationId);
  } catch {
    return indeterminate("staging_observation_unavailable");
  }
  const stagingFailure = resultFailure(stagingResult);
  if (stagingFailure) return stagingFailure;
  if (stagingResult.status !== "attested") return indeterminate("staging_observation_unavailable");
  if (!validStagingObservation(stagingResult.value))
    return indeterminate("staging_observation_schema_invalid");
  const staging = stagingResult.value;
  if (!staging) return deny("admission_staging_record_missing");
  if (staging.operationId !== receipt.binding.operationId)
    return deny("admission_staging_operation_mismatch");
  if (!SHA256.test(staging.manifestDigest)) return deny("admission_staging_manifest_invalid");
  if (staging.treeDigest !== pr.treeDigest) return deny("admission_staging_tree_mismatch");
  if (staging.expectedMainOid !== pr.baseOid)
    return deny("admission_staging_expected_main_mismatch");
  if (staging.branch !== pr.branch) return deny("admission_staging_branch_mismatch");
  let mergeBaseResult: PublicationPortResult<PackPublicationMergeBaseObservation>;
  try {
    mergeBaseResult = await input.observer.mergeBase({
      headOid: pr.headOid,
      expectedMainOid: staging.expectedMainOid,
    });
  } catch {
    return indeterminate("merge_base_observation_unavailable");
  }
  const mergeBaseFailure = resultFailure(mergeBaseResult);
  if (mergeBaseFailure) return mergeBaseFailure;
  if (mergeBaseResult.status !== "attested")
    return indeterminate("merge_base_observation_unavailable");
  if (!validMergeBaseObservation(mergeBaseResult.value))
    return indeterminate("merge_base_observation_schema_invalid");
  if (mergeBaseResult.value.mergeBase !== staging.expectedMainOid)
    return deny("admission_merge_base_mismatch");
  if (input.approvals.length === 0) return deny("admission_approval_missing");
  if (new Set(input.approvals.map((approval) => approval.nonce)).size !== input.approvals.length)
    return deny("admission_approval_set_conflict");
  if (input.approvals.some((approval) => approval.nonce.length === 0))
    return deny("admission_approval_binding_mismatch");
  if (input.approvals.some((approval) => approval.operationId !== receipt.binding.operationId))
    return deny("admission_approval_binding_mismatch");
  if (input.approvals.some((approval) => approval.consumed))
    return deny("admission_approval_consumed");
  if (input.approvals.some((approval) => approval.preparation))
    return deny("admission_approval_set_conflict");
  if (input.approvals.some((approval) => approval.idempotencyKey !== staging.idempotencyKey))
    return deny("admission_staging_key_mismatch");
  const intentIdentity = derivePackPublicationAdmissionIntentIdentity({
    operationId: receipt.binding.operationId,
    repositoryId: repository.repositoryId,
    targetRef: repository.targetRef,
    expectedMainOid: staging.expectedMainOid,
    reviewedHead: review.reviewedHead,
    preparationReceiptDigest: receiptDigest,
  });
  const callerFailure = callerMatches({
    caller: input.caller,
    config: input.configuration,
    baseOid: pr.baseOid,
    review,
    checks,
    receiptDigest,
    intentIdentity,
  });
  if (callerFailure) return deny(callerFailure);
  const approvalIdentityBindings = input.approvals
    .map((approval) => ({
      nonce: approval.nonce,
      binding: derivePackPublicationAdmissionApprovalBinding({
        nonce: approval.nonce,
        publicationIntentIdentity: intentIdentity,
      }),
    }))
    .sort((left, right) => left.nonce.localeCompare(right.nonce));
  if (
    input.approvals.some(
      (approval) =>
        approval.intentBindingDigest !==
        derivePackPublicationAdmissionApprovalBinding({
          nonce: approval.nonce,
          publicationIntentIdentity: intentIdentity,
        }),
    )
  )
    return deny("admission_approval_binding_mismatch");
  const sealed: PackPublicationAdmissionSealedValues = {
    repositoryId: repository.repositoryId,
    repository: repository.repository,
    targetRef: repository.targetRef,
    rulesetId: repository.rulesetId,
    requiredContexts: [...input.configuration.requiredContexts].sort(),
    casAuthorityInstallationId: repository.casAuthorityInstallationId,
    expectedMainOid: staging.expectedMainOid,
    preparationReceiptDigest: receiptDigest,
    reviewedPullRequest: pr.pullRequest,
    reviewedHead: review.reviewedHead,
    baseOid: pr.baseOid,
    treeDigest: pr.treeDigest,
    reviewConclusion: "approved",
    reviewer: review.reviewer,
    closingReceiptDigest: review.closingReceiptDigest,
    requiredCheckConclusions: required
      .map((check) => ({ context: check.context, conclusion: "success" as const }))
      .sort((left, right) => left.context.localeCompare(right.context)),
    mergeBase: mergeBaseResult.value.mergeBase,
    publicationIntentIdentity: intentIdentity,
    approvalBindings: approvalIdentityBindings.map((item) => item.binding),
    observationBundleDigest: digest({
      repository,
      pr,
      review,
      checks: sealedChecks(required),
      mergeBase: mergeBaseResult.value,
      staging,
    }),
  };
  const observationBundleDigest = sealed.observationBundleDigest;
  const records = await input.ledger.read();
  if (records.some((record) => !validLedgerRecord(record)))
    return indeterminate("admission_ledger_invalid");
  const replay = findReplay(records, {
    operationId: receipt.binding.operationId,
    idempotencyKey: staging.idempotencyKey,
    pullRequest: pr.pullRequest,
    expectedMainOid: staging.expectedMainOid,
    observationBundleDigest,
  });
  if (replay && !("ok" in replay))
    return { ok: true, status: "admitted", record: replay, remoteWrites: 0, approvalConsumes: 0 };
  if (replay) return replay;
  const previous = records.at(-1);
  const withoutDigest: Omit<PackPublicationAdmissionLedgerRecord, "recordDigest"> = {
    status: "admitted",
    sequence: (previous?.sequence ?? 0) + 1,
    previousRecordDigest: previous?.recordDigest ?? null,
    operationId: receipt.binding.operationId,
    idempotencyKey: staging.idempotencyKey,
    pullRequest: pr.pullRequest,
    observationBundleDigest,
    publicationIntentIdentity: intentIdentity,
    approvalBindings: sealed.approvalBindings,
    sealed,
  };
  const record: PackPublicationAdmissionLedgerRecord = {
    ...withoutDigest,
    recordDigest: derivePackPublicationAdmissionRecordDigest(withoutDigest),
  };
  await input.ledger.appendObservation({
    recordDigest: record.recordDigest,
    observationBundleDigest,
    operationId: record.operationId,
  });
  await input.ledger.append(record);
  return { ok: true, status: "admitted", record, remoteWrites: 0, approvalConsumes: 0 };
}

function sealedChecks(
  checks: readonly Readonly<{ context: string; conclusion: string }>[],
): readonly Readonly<{ context: string; conclusion: "success" }>[] {
  return checks
    .filter((check) => check.conclusion === "success")
    .map((check) => ({ context: check.context, conclusion: "success" as const }));
}
