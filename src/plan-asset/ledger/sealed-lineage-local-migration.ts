import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  CustodyDecision,
  CustodyFailureReason,
  CustodyPullRequestFacts,
} from "../../feedback/review-custody.ts";
import {
  observeAndAdmitCustodyReceipt,
  type RunnerEnvironment,
} from "../../feedback/review-custody-runner.ts";
import type { HarnessDb } from "../../state-db/index.ts";
import { parseLegacyPlanSource } from "../adapters/legacy-plan-inventory.ts";
import { loadProjectIdentityFromHead } from "../adapters/project-identity-loader.ts";
import { ledgerRowDigest, migratePlanLedger } from "./schema.ts";
import { ImmediateLedgerTransaction } from "./transaction.ts";

export type SealedLineageBoundary =
  | "asset"
  | "revision"
  | "alias"
  | "admission"
  | "custody"
  | "seal"
  | "certificate"
  | "receipt";

export interface SealedLineageMigrationInput {
  readonly commandId: string;
  readonly repositoryIdentity: string;
  readonly planId: string;
  readonly historicalAssetId: string;
  readonly historicalTerminalRevision: number;
  readonly historicalTailDigest: string;
  readonly historicalProjectionPath: string;
  readonly historicalProjectionBlobOid: string;
  readonly historicalProjectionContentDigest: string;
  readonly successorAssetId: string;
  readonly canonicalPayloadJson: string;
  readonly canonicalPayloadDigest: string;
  readonly bodyDigest: string;
  readonly sourcePath: string;
  readonly sourceCommit: string;
  readonly sourceBlobOid: string;
  readonly actor: string;
  readonly occurredAt: string;
  readonly certificateDigest: string;
  readonly sourceAuthorityDigest: string;
  readonly reviewedImplementationAuthorityDigest: string;
  readonly trustedStatus: "draft";
  readonly issue: {
    readonly number: number;
    readonly episodeId: string;
    readonly preimageDigest: string;
  };
}

export interface SealedLineageGitBlob {
  readonly blobOid: string;
  readonly bytes: Uint8Array;
}

/** Git の読み出しは writer から分離し、pair test ではこの port を置換する。 */
export interface SealedLineageGitPreflightPort {
  readonly readHeadCommit: () => string;
  readonly isReachableFromTrackedRemote: (commit: string) => boolean;
  readonly readBlob: (commit: string, path: string) => SealedLineageGitBlob | undefined;
}

export interface SealedLineageReviewAuthorityObservation {
  readonly pullRequestNumber: number;
  readonly baseRef: string;
  readonly headSha: string;
  readonly custodyState: "custody_admitted" | "custody_rejected";
  readonly custodyReasons: readonly string[];
}

export interface SealedLineageReviewAuthorityPort {
  readonly observe: (
    input: SealedLineageMigrationInput,
  ) => SealedLineageReviewAuthorityObservation | undefined;
}

export interface SealedLineageIssueAuthorityObservation {
  readonly number: number;
  readonly rawBody: string;
  readonly updatedAt: string;
}

export interface SealedLineageIssueAuthorityPort {
  readonly observe: (
    input: SealedLineageMigrationInput,
  ) => SealedLineageIssueAuthorityObservation | undefined;
}

/** `admitReviewCustody` の typed decision と同じ live facts を seal 用 observationへ写す。 */
export class CustodyDecisionSealedLineageReviewAuthorityPort
  implements SealedLineageReviewAuthorityPort
{
  private readonly facts: CustodyPullRequestFacts;
  private readonly decision: CustodyDecision;

  constructor(facts: CustodyPullRequestFacts, decision: CustodyDecision) {
    this.facts = facts;
    this.decision = decision;
  }

  observe(input: SealedLineageMigrationInput): SealedLineageReviewAuthorityObservation | undefined {
    if (
      this.facts.repository !== input.repositoryIdentity ||
      this.facts.prNumber < 1 ||
      !this.facts.baseRef ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(this.facts.headSha)
    )
      return undefined;
    if (
      this.decision.state === "custody_admitted" &&
      (this.decision.repository !== this.facts.repository ||
        this.decision.prNumber !== this.facts.prNumber ||
        this.decision.headSha !== this.facts.headSha)
    )
      return undefined;
    return {
      pullRequestNumber: this.facts.prNumber,
      baseRef: this.facts.baseRef,
      headSha: this.facts.headSha,
      custodyState: this.decision.state,
      custodyReasons: this.decision.state === "custody_rejected" ? this.decision.reasons : [],
    };
  }
}

export interface SealedLineageMigrationOptions {
  readonly fault?: { after(boundary: SealedLineageBoundary): void };
  readonly git?: SealedLineageGitPreflightPort;
  readonly reviewAuthority?: SealedLineageReviewAuthorityPort;
  readonly issueAuthority?: SealedLineageIssueAuthorityPort;
}

/** Node-only production adapter. Review custody remains a separate injected port. */
export class SystemSealedLineageGitPreflightPort implements SealedLineageGitPreflightPort {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  readHeadCommit(): string {
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  isReachableFromTrackedRemote(commit: string): boolean {
    const refs = this.git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])
      .split(/\r?\n/)
      .map((ref) => ref.trim())
      .filter(Boolean);
    return refs.some((ref) => {
      try {
        execFileSync("git", ["-C", this.repoRoot, "merge-base", "--is-ancestor", commit, ref], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    });
  }

  readBlob(commit: string, path: string): SealedLineageGitBlob | undefined {
    try {
      const tree = this.git(["ls-tree", commit, "--", path]).trim();
      const match = /^100644 blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/.exec(tree);
      if (!match || match[2] !== path) return undefined;
      return { blobOid: match[1], bytes: this.gitBytes(["cat-file", "blob", match[1]]) };
    } catch {
      return undefined;
    }
  }

  private git(args: readonly string[]): string {
    return this.gitBytes(args).toString("utf8");
  }

  private gitBytes(args: readonly string[]): Buffer {
    return execFileSync("git", ["-C", this.repoRoot, ...args], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  }
}

/** GitHub の live Issue 本文を文字列のまま返し、digest 導出は application 側に残す。 */
export class SystemSealedLineageIssueAuthorityPort implements SealedLineageIssueAuthorityPort {
  private readonly exec: SealedLineageIssueGhExec;

  constructor(
    exec: SealedLineageIssueGhExec = (args) =>
      execFileSync("gh", [...args], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }),
  ) {
    this.exec = exec;
  }

  observe(input: SealedLineageMigrationInput): SealedLineageIssueAuthorityObservation | undefined {
    try {
      const raw = this.exec([
        "api",
        `repos/${input.repositoryIdentity}/issues/${input.issue.number}`,
        "--header",
        "Cache-Control: no-cache",
      ]);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        !Number.isSafeInteger(parsed.number) ||
        typeof parsed.body !== "string" ||
        typeof parsed.updated_at !== "string"
      )
        return undefined;
      return {
        number: Number(parsed.number),
        rawBody: parsed.body,
        updatedAt: parsed.updated_at,
      };
    } catch {
      return undefined;
    }
  }
}

export type SealedLineageIssueGhExec = (args: readonly string[]) => string;

export interface SealedLineageDryRunRequest {
  readonly commandId: string;
  readonly planId: string;
  readonly actor: string;
  readonly occurredAt: string;
  readonly git: SealedLineageGitPreflightPort;
  readonly projectIdentity: SealedLineageProjectIdentityPort;
  readonly issueAuthority: SealedLineageIssueAuthorityPort;
  readonly reviewCustody: SealedLineageLiveReviewCustodyPort;
}

export interface SealedLineageLiveReviewCustodyPort {
  readonly observe: () => Promise<{
    readonly facts: CustodyPullRequestFacts;
    readonly decision: CustodyDecision;
  }>;
}

export class SystemSealedLineageLiveReviewCustodyPort
  implements SealedLineageLiveReviewCustodyPort
{
  private readonly environment: RunnerEnvironment;

  constructor(environment: RunnerEnvironment) {
    this.environment = environment;
  }

  observe(): Promise<{ facts: CustodyPullRequestFacts; decision: CustodyDecision }> {
    return observeAndAdmitCustodyReceipt(this.environment);
  }
}

export interface SealedLineageProjectIdentityObservation {
  readonly repositoryIdentity: string;
  readonly sourceCommit: string;
  readonly receiptDigest: string;
}

export interface SealedLineageProjectIdentityPort {
  readonly observe: () => SealedLineageProjectIdentityObservation | undefined;
}

type ProjectIdentityLoader = typeof loadProjectIdentityFromHead;

/** #516/#432のcanonical tracked identity loaderをseal dry-runへ適用するsystem port。 */
export class SystemSealedLineageProjectIdentityPort implements SealedLineageProjectIdentityPort {
  private readonly repoRoot: string;
  private readonly expectedRepositoryIdentity?: string;
  private readonly loader: ProjectIdentityLoader;

  constructor(
    repoRoot: string,
    expectedRepositoryIdentity?: string,
    loader: ProjectIdentityLoader = loadProjectIdentityFromHead,
  ) {
    this.repoRoot = repoRoot;
    this.expectedRepositoryIdentity = expectedRepositoryIdentity;
    this.loader = loader;
  }

  observe(): SealedLineageProjectIdentityObservation | undefined {
    const loaded = this.loader({
      repoRoot: this.repoRoot,
      expectedRepositoryIdentity: this.expectedRepositoryIdentity,
    });
    return loaded.ok
      ? {
          repositoryIdentity: loaded.value.repositoryIdentity,
          sourceCommit: loaded.value.provenance.sourceCommit,
          receiptDigest: loaded.value.provenance.receiptDigest,
        }
      : undefined;
  }
}

export type SealedLineageDryRunResult =
  | {
      readonly ok: true;
      readonly input: SealedLineageMigrationInput;
      readonly validation: Extract<ReturnType<typeof validate>, { ok: true }>;
      readonly canonicalManifest: string;
      readonly manifestDigest: string;
    }
  | { readonly ok: false; readonly ruleId: string };

export interface SealedLineageRecoveryExecutionRequest {
  readonly dryRun: SealedLineageDryRunRequest;
  readonly openLedger: () => { readonly db: HarnessDb; readonly close: () => void };
  readonly runPlanRevision: (input: {
    readonly seal: Extract<SealedLineageMigrationResult, { ok: true }>;
    readonly manifestDigest: string;
  }) =>
    | { readonly ok: true; readonly output: string }
    | { readonly ok: false; readonly ruleId: string };
}

export type SealedLineageRecoveryExecutionResult =
  | {
      readonly ok: true;
      readonly manifestDigest: string;
      readonly seal: Extract<SealedLineageMigrationResult, { ok: true }>;
      readonly revisionOutput: string;
    }
  | {
      readonly ok: false;
      readonly stage: "dry-run" | "seal" | "plan-revise";
      readonly ruleId: string;
    };

/**
 * live read-only authorityからseal入力を組み立ててpreflightする。DB writerは生成せず、
 * callerからdigest/Issue custody/repository identityを受け取らない。
 */
export async function assembleSealedLineageMigrationDryRun(
  request: SealedLineageDryRunRequest,
): Promise<SealedLineageDryRunResult> {
  try {
    const sourceCommit = request.git.readHeadCommit();
    if (!request.git.isReachableFromTrackedRemote(sourceCommit))
      return rejected("seal-source-commit-unreachable");
    const project = request.projectIdentity.observe();
    if (!project || project.sourceCommit !== sourceCommit)
      return rejected("seal-git-preflight-unavailable");
    const sourcePath = `docs/plans/${request.planId}.md`;
    const projectionPath = "docs/governance/plan-admission-receipts.json";
    const sourceBlob = request.git.readBlob(sourceCommit, sourcePath);
    const projectionBlob = request.git.readBlob(sourceCommit, projectionPath);
    if (!sourceBlob || !projectionBlob) return rejected("seal-git-preflight-unavailable");
    const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBlob.bytes);
    const parsed = parseLegacyPlanSource(sourceText);
    if (!parsed || parsed.planId !== request.planId) return rejected("seal-source-payload-drift");
    const admission = plainRecord(parsed.frontmatter.admission_receipt);
    const issue = plainRecord(admission?.issue);
    if (!issue || !Number.isSafeInteger(issue.issue_id) || typeof issue.episode_id !== "string")
      return rejected("seal-issue-authority-invalid");
    const terminal = readProjectionTerminal(projectionBlob.bytes, request.planId);
    if (!terminal) return rejected("seal-projection-terminal-mismatch");
    const canonicalPayloadJson = stableCanonical(parsed.frontmatter);
    const base = {
      commandId: request.commandId,
      repositoryIdentity: project.repositoryIdentity,
      planId: request.planId,
      historicalAssetId: terminal.assetId,
      historicalTerminalRevision: terminal.revision,
      historicalTailDigest: terminal.recordDigest,
      historicalProjectionPath: projectionPath,
      historicalProjectionBlobOid: projectionBlob.blobOid,
      historicalProjectionContentDigest: shaBytes(projectionBlob.bytes),
      successorAssetId: deriveSuccessorAssetId(project.repositoryIdentity, request.planId),
      canonicalPayloadJson,
      canonicalPayloadDigest: sha(canonicalPayloadJson),
      bodyDigest: sha(parsed.body),
      sourcePath,
      sourceCommit,
      sourceBlobOid: sourceBlob.blobOid,
      actor: request.actor,
      occurredAt: request.occurredAt,
      certificateDigest: "",
      sourceAuthorityDigest: "",
      reviewedImplementationAuthorityDigest: "",
      trustedStatus: "draft" as const,
      issue: {
        number: Number(issue.issue_id),
        episodeId: issue.episode_id,
        preimageDigest: "",
      },
    };
    const observedIssue = request.issueAuthority.observe(base);
    if (!observedIssue || observedIssue.number !== base.issue.number)
      return rejected("seal-issue-authority-invalid");
    const liveCustody = await request.reviewCustody.observe();
    const reviewAuthority = new CustodyDecisionSealedLineageReviewAuthorityPort(
      liveCustody.facts,
      liveCustody.decision,
    );
    const observedReview = reviewAuthority.observe(base);
    if (!observedReview) return rejected("seal-review-authority-invalid");
    const sourceAuthorityDigest = deriveSourceAuthorityDigest(base);
    const reviewedImplementationAuthorityDigest = deriveReviewAuthorityDigest(base, observedReview);
    const input: SealedLineageMigrationInput = {
      ...base,
      issue: {
        ...base.issue,
        preimageDigest: shaBytes(Buffer.from(observedIssue.rawBody, "utf8")),
      },
      sourceAuthorityDigest,
      reviewedImplementationAuthorityDigest,
      certificateDigest: deriveCertificateDigest({
        ...base,
        sourceAuthorityDigest,
        reviewedImplementationAuthorityDigest,
      }),
    };
    const validation = validate(input);
    if (!validation.ok) return validation;
    const gitCheck = validateGitPreflight(input, request.git);
    if (!gitCheck.ok) return gitCheck;
    const reviewCheck = validateAuthorities(input, reviewAuthority);
    if (!reviewCheck.ok) return reviewCheck;
    const issueCheck = validateIssueAuthority(input, gitCheck, {
      observe: () => observedIssue,
    });
    if (!issueCheck.ok) return issueCheck;
    const canonicalManifest = stableCanonical(input);
    return {
      ok: true,
      input,
      validation,
      canonicalManifest,
      manifestDigest: sha(canonicalManifest),
    };
  } catch {
    return rejected("seal-git-preflight-unavailable");
  }
}

/**
 * live authorityを一度だけtyped observationへ束縛し、隔離ledgerのseal成功後だけ
 * strict revision runnerへ進める。digestやseal inputをcallerから受け取らない。
 */
export async function executeSealedLineageRecovery(
  request: SealedLineageRecoveryExecutionRequest,
): Promise<SealedLineageRecoveryExecutionResult> {
  let custodyObservation:
    | { readonly facts: CustodyPullRequestFacts; readonly decision: CustodyDecision }
    | undefined;
  const reviewCustody: SealedLineageLiveReviewCustodyPort = {
    observe: async () => {
      custodyObservation ??= await request.dryRun.reviewCustody.observe();
      return custodyObservation;
    },
  };
  const dryRun = await assembleSealedLineageMigrationDryRun({
    ...request.dryRun,
    reviewCustody,
  });
  if (!dryRun.ok) return { ok: false, stage: "dry-run", ruleId: dryRun.ruleId };
  const observed = await reviewCustody.observe();
  let ledger: ReturnType<SealedLineageRecoveryExecutionRequest["openLedger"]>;
  try {
    ledger = request.openLedger();
  } catch {
    return { ok: false, stage: "seal", ruleId: "seal-ledger-unavailable" };
  }
  let seal: SealedLineageMigrationResult;
  try {
    seal = new SealedLineageLocalMigration(ledger.db, {
      git: request.dryRun.git,
      reviewAuthority: new CustodyDecisionSealedLineageReviewAuthorityPort(
        observed.facts,
        observed.decision,
      ),
      issueAuthority: request.dryRun.issueAuthority,
    }).migrate(dryRun.input);
  } catch {
    seal = rejected("seal-execution-failed");
  } finally {
    try {
      ledger.close();
    } catch {
      seal = rejected("seal-ledger-close-failed");
    }
  }
  if (!seal.ok) return { ok: false, stage: "seal", ruleId: seal.ruleId };
  let revision: ReturnType<SealedLineageRecoveryExecutionRequest["runPlanRevision"]>;
  try {
    revision = request.runPlanRevision({ seal, manifestDigest: dryRun.manifestDigest });
  } catch {
    revision = { ok: false, ruleId: "plan-revision-execution-failed" };
  }
  return revision.ok
    ? {
        ok: true,
        manifestDigest: dryRun.manifestDigest,
        seal,
        revisionOutput: revision.output,
      }
    : { ok: false, stage: "plan-revise", ruleId: revision.ruleId };
}

export type SealedLineageMigrationResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly successorAssetId: string;
      readonly successorRevision: 1;
    }
  | { readonly ok: false; readonly ruleId: string };

/**
 * 復元不能なtracked historyを推測でDB row化せずsealし、現HEADをsuccessor rev1へ移す。
 * remote comment/outboxは別portであり、このlocal writer transactionには含めない。
 */
export class SealedLineageLocalMigration {
  private readonly db: HarnessDb;
  private readonly fault?: { after(boundary: SealedLineageBoundary): void };
  private readonly git?: SealedLineageGitPreflightPort;
  private readonly reviewAuthority?: SealedLineageReviewAuthorityPort;
  private readonly issueAuthority?: SealedLineageIssueAuthorityPort;

  constructor(db: HarnessDb, options: SealedLineageMigrationOptions = {}) {
    this.db = db;
    this.fault = options.fault;
    this.git = options.git;
    this.reviewAuthority = options.reviewAuthority;
    this.issueAuthority = options.issueAuthority;
    if (!migratePlanLedger(db).ok) throw new Error("plan-ledger-unavailable");
  }

  migrate(input: SealedLineageMigrationInput): SealedLineageMigrationResult {
    const checked = validate(input);
    if (!checked.ok) return checked;
    // Replay is bound only to the durable receipt and rows.  It must remain
    // available after the source branch moves or an authority port expires.
    const replay = this.replay(input, checked.commandDigest);
    if (replay) return replay;
    const preflight = validateGitPreflight(input, this.git);
    if (!preflight.ok) return preflight;
    const authority = validateAuthorities(input, this.reviewAuthority);
    if (!authority.ok) return authority;
    const issueAuthority = validateIssueAuthority(input, preflight, this.issueAuthority);
    if (!issueAuthority.ok) return issueAuthority;
    const finalGitCheck = validateFinalGitCustody(input, this.git);
    if (!finalGitCheck.ok) return finalGitCheck;
    const transaction = new ImmediateLedgerTransaction(this.db);
    return transaction.run(() => {
      const replay = this.replay(input, checked.commandDigest);
      if (replay) return { commit: false, value: replay };
      const conflict = this.preflight(input);
      if (conflict) return { commit: false, value: conflict };
      this.appendSuccessor(input, checked);
      return {
        commit: true,
        value: {
          ok: true as const,
          replayed: false,
          successorAssetId: input.successorAssetId,
          successorRevision: 1 as const,
        },
      };
    });
  }

  private replay(
    input: SealedLineageMigrationInput,
    commandDigest: string,
  ): SealedLineageMigrationResult | undefined {
    const receipt = this.db
      .prepare("SELECT * FROM append_command_receipts WHERE command_id = ?")
      .get(input.commandId);
    if (!receipt) return undefined;
    if (!secureEqual(String(receipt.command_payload_digest), commandDigest))
      return rejected("sealed-lineage-command-conflict");
    const seal = this.db
      .prepare("SELECT * FROM sealed_plan_lineages WHERE command_id = ?")
      .get(input.commandId);
    const certificate = this.db
      .prepare("SELECT * FROM plan_lineage_migration_certificates WHERE command_id = ?")
      .get(input.commandId);
    const alias = this.db
      .prepare("SELECT * FROM plan_aliases WHERE alias = ? AND valid_to_revision IS NULL")
      .get(input.planId);
    const revision = this.db
      .prepare("SELECT * FROM plan_revisions WHERE asset_id = ? AND revision = 1")
      .get(input.successorAssetId);
    if (
      !seal ||
      !certificate ||
      !alias ||
      !revision ||
      String(alias.asset_id) !== input.successorAssetId ||
      String(seal.lineage_digest) !==
        ledgerRowDigest(without(seal, "lineage_digest"), "lineage_digest") ||
      String(certificate.record_digest) !==
        ledgerRowDigest(without(certificate, "record_digest"), "record_digest")
    )
      return rejected("sealed-lineage-replay-binding-invalid");
    return {
      ok: true,
      replayed: true,
      successorAssetId: input.successorAssetId,
      successorRevision: 1,
    };
  }

  private preflight(input: SealedLineageMigrationInput): SealedLineageMigrationResult | undefined {
    if (
      this.db
        .prepare("SELECT 1 FROM plan_assets WHERE asset_id IN (?, ?)")
        .get(input.historicalAssetId, input.successorAssetId) ||
      this.db.prepare("SELECT 1 FROM plan_aliases WHERE alias = ?").get(input.planId) ||
      this.db
        .prepare("SELECT 1 FROM plan_alias_events WHERE asset_id = ?")
        .get(input.historicalAssetId)
    )
      return rejected("sealed-lineage-partial-state");
    return undefined;
  }

  private appendSuccessor(
    input: SealedLineageMigrationInput,
    checked: Extract<ReturnType<typeof validate>, { ok: true }>,
  ): void {
    this.db
      .prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)")
      .run(input.successorAssetId, input.occurredAt, input.sourceCommit, "ut-tdd-plan-rebase-v1");
    this.fault?.after("asset");
    this.db
      .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        input.successorAssetId,
        1,
        input.canonicalPayloadJson,
        input.canonicalPayloadDigest,
        input.bodyDigest,
        input.sourcePath,
        input.sourceCommit,
        input.actor,
        "seal historical lineage and establish successor genesis",
        input.occurredAt,
      );
    this.fault?.after("revision");

    const aliasEvent = {
      alias_event_id: `alias:${input.commandId}:1`,
      asset_id: input.successorAssetId,
      sequence: 1,
      command_id: input.commandId,
      command_payload_digest: checked.commandDigest,
      event_kind: "assigned",
      alias: input.planId,
      revision: 1,
      reason: "sealed lineage successor",
      occurred_at: input.occurredAt,
    };
    const aliasDigest = ledgerRowDigest(aliasEvent, "event_digest");
    this.db
      .prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(aliasEvent), aliasDigest);
    this.db
      .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        `alias-current:${input.successorAssetId}`,
        input.successorAssetId,
        input.planId,
        1,
        null,
        aliasDigest,
      );
    this.fault?.after("alias");

    const admission = {
      admission_event_id: `admission:${input.commandId}`,
      command_id: input.commandId,
      command_payload_digest: checked.commandDigest,
      event_kind: "admitted",
      plan_asset_id: input.successorAssetId,
      plan_revision: 1,
      plan_id: input.planId,
      source_path: input.sourcePath,
      content_digest: checked.contentDigest,
      route_tuple_digest: checked.routeDigest,
      certificate_id: `genesis-rebase:${input.commandId}`,
      certificate_digest: input.certificateDigest,
      occurred_at: input.occurredAt,
    };
    const admissionDigest = ledgerRowDigest(admission, "event_digest");
    this.db
      .prepare(
        "INSERT INTO plan_admission_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...Object.values(admission), admissionDigest);
    this.db
      .prepare("INSERT INTO plan_admission_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        admission.certificate_id,
        admission.admission_event_id,
        input.commandId,
        checked.commandDigest,
        input.successorAssetId,
        1,
        input.planId,
        input.sourcePath,
        checked.contentDigest,
        checked.routeDigest,
        input.certificateDigest,
        input.occurredAt,
      );
    this.fault?.after("admission");

    const custody = {
      command_id: input.commandId,
      issue_number: input.issue.number,
      episode_id: input.issue.episodeId,
      drive_model: "recovery",
      issue_preimage_digest: input.issue.preimageDigest,
      plan_asset_id: input.successorAssetId,
      plan_revision: 1,
      custody_state: "committed",
      recorded_at: input.occurredAt,
    };
    this.db
      .prepare("INSERT INTO genesis_issue_custody VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(custody), ledgerRowDigest(custody, "custody_digest"));
    this.fault?.after("custody");

    const seal = {
      command_id: input.commandId,
      command_payload_digest: checked.commandDigest,
      plan_id: input.planId,
      historical_asset_id: input.historicalAssetId,
      historical_terminal_revision: input.historicalTerminalRevision,
      historical_tail_digest: input.historicalTailDigest,
      historical_projection_path: input.historicalProjectionPath,
      historical_projection_blob_oid: input.historicalProjectionBlobOid,
      historical_projection_content_digest: input.historicalProjectionContentDigest,
      disposition: "historical_sealed_unrehydratable",
      successor_asset_id: input.successorAssetId,
      successor_revision: 1,
      source_authority_digest: input.sourceAuthorityDigest,
      reviewed_implementation_authority_digest: input.reviewedImplementationAuthorityDigest,
      trusted_status: input.trustedStatus,
      certificate_digest: input.certificateDigest,
      occurred_at: input.occurredAt,
    };
    this.db
      .prepare(
        "INSERT INTO sealed_plan_lineages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...Object.values(seal), ledgerRowDigest(seal, "lineage_digest"));
    this.fault?.after("seal");

    const certificate = {
      certificate_digest: input.certificateDigest,
      command_id: input.commandId,
      command_payload_digest: checked.commandDigest,
      certificate_json: canonical({
        historicalAssetId: input.historicalAssetId,
        historicalTerminalRevision: input.historicalTerminalRevision,
        historicalTailDigest: input.historicalTailDigest,
        planId: input.planId,
        reviewedImplementationAuthorityDigest: input.reviewedImplementationAuthorityDigest,
        sourceAuthorityDigest: input.sourceAuthorityDigest,
        successorAssetId: input.successorAssetId,
        successorRevision: 1,
      }),
      source_authority_digest: input.sourceAuthorityDigest,
      reviewed_implementation_authority_digest: input.reviewedImplementationAuthorityDigest,
      recorded_at: input.occurredAt,
    };
    this.db
      .prepare("INSERT INTO plan_lineage_migration_certificates VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(certificate), ledgerRowDigest(certificate, "record_digest"));
    this.fault?.after("certificate");

    const receipt = {
      command_id: input.commandId,
      command_type: "plan.lineage-seal",
      subject_kind: "plan_revision",
      subject_key: `${input.successorAssetId}:1`,
      plan_asset_id: input.successorAssetId,
      plan_revision: 1,
      command_payload_digest: checked.commandDigest,
      result_kind: "lineage_migration_certificate",
      result_ref: input.certificateDigest,
      recorded_at: input.occurredAt,
    };
    this.db
      .prepare("INSERT INTO append_command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(receipt), ledgerRowDigest(receipt, "receipt_digest"));
    this.fault?.after("receipt");
  }
}

function validate(input: SealedLineageMigrationInput):
  | {
      ok: true;
      commandDigest: string;
      contentDigest: string;
      routeDigest: string;
    }
  | { ok: false; ruleId: string } {
  if (!hasExactMigrationInputShape(input)) return rejected("sealed-lineage-input-invalid");
  const digests = [
    input.historicalTailDigest,
    input.historicalProjectionContentDigest,
    input.canonicalPayloadDigest,
    input.bodyDigest,
    input.certificateDigest,
    input.sourceAuthorityDigest,
    input.reviewedImplementationAuthorityDigest,
    input.issue.preimageDigest,
  ];
  if (
    !input.commandId ||
    !input.repositoryIdentity ||
    !input.planId ||
    input.successorAssetId !== deriveSuccessorAssetId(input.repositoryIdentity, input.planId) ||
    input.historicalAssetId === input.successorAssetId ||
    !Number.isSafeInteger(input.historicalTerminalRevision) ||
    input.historicalTerminalRevision < 1 ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.sourceCommit) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.sourceBlobOid) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.historicalProjectionBlobOid) ||
    digests.some((value) => !/^[0-9a-f]{64}$/.test(value)) ||
    sha(input.canonicalPayloadJson) !== input.canonicalPayloadDigest ||
    input.trustedStatus !== "draft"
  )
    return rejected("sealed-lineage-input-invalid");
  return {
    ok: true,
    commandDigest: sha(canonical(input)),
    contentDigest: sha(`${input.canonicalPayloadDigest}:${input.bodyDigest}`),
    routeDigest: sha(canonical({ mode: "recovery", signal: "regression_dev" })),
  };
}

const MIGRATION_INPUT_KEYS = [
  "actor",
  "bodyDigest",
  "canonicalPayloadDigest",
  "canonicalPayloadJson",
  "certificateDigest",
  "commandId",
  "historicalAssetId",
  "historicalProjectionBlobOid",
  "historicalProjectionContentDigest",
  "historicalProjectionPath",
  "historicalTailDigest",
  "historicalTerminalRevision",
  "issue",
  "occurredAt",
  "planId",
  "repositoryIdentity",
  "reviewedImplementationAuthorityDigest",
  "sourceAuthorityDigest",
  "sourceBlobOid",
  "sourceCommit",
  "sourcePath",
  "successorAssetId",
  "trustedStatus",
] as const;

const MIGRATION_ISSUE_KEYS = ["episodeId", "number", "preimageDigest"] as const;

function hasExactMigrationInputShape(input: SealedLineageMigrationInput): boolean {
  if (!input || typeof input !== "object" || !input.issue || typeof input.issue !== "object")
    return false;
  const inputKeys = Object.keys(input).sort();
  const issueKeys = Object.keys(input.issue).sort();
  return (
    inputKeys.length === MIGRATION_INPUT_KEYS.length &&
    inputKeys.every((key, index) => key === MIGRATION_INPUT_KEYS[index]) &&
    issueKeys.length === MIGRATION_ISSUE_KEYS.length &&
    issueKeys.every((key, index) => key === MIGRATION_ISSUE_KEYS[index])
  );
}

function validateGitPreflight(
  input: SealedLineageMigrationInput,
  git: SealedLineageGitPreflightPort | undefined,
): { ok: true; issueNumber: number; episodeId: string } | { ok: false; ruleId: string } {
  if (!git) return rejected("seal-git-preflight-unavailable");
  let headBefore: string;
  try {
    headBefore = git.readHeadCommit();
  } catch {
    return rejected("seal-source-commit-unreachable");
  }
  let reachable = false;
  try {
    reachable = git.isReachableFromTrackedRemote(input.sourceCommit);
  } catch {
    reachable = false;
  }
  if (headBefore !== input.sourceCommit || !reachable)
    return rejected("seal-source-commit-unreachable");

  const canonicalSourcePath = `docs/plans/${input.planId}.md`;
  if (input.sourcePath !== canonicalSourcePath) return rejected("seal-source-path-noncanonical");
  let sourceBlob: SealedLineageGitBlob | undefined;
  try {
    sourceBlob = git.readBlob(input.sourceCommit, input.sourcePath);
  } catch {
    sourceBlob = undefined;
  }
  if (!sourceBlob) return rejected("seal-source-path-absent");
  if (sourceBlob.blobOid !== input.sourceBlobOid) return rejected("seal-source-blob-mismatch");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBlob.bytes);
  } catch {
    return rejected("seal-source-payload-drift");
  }
  const parsed = parseLegacyPlanSource(source);
  if (
    !parsed ||
    stableCanonical(parsed.frontmatter) !== input.canonicalPayloadJson ||
    sha(input.canonicalPayloadJson) !== input.canonicalPayloadDigest ||
    sha(parsed.body) !== input.bodyDigest
  )
    return rejected("seal-source-payload-drift");
  const admissionReceipt = plainRecord(parsed.frontmatter.admission_receipt);
  const issue = plainRecord(admissionReceipt?.issue);
  if (
    !issue ||
    !Number.isSafeInteger(issue.issue_id) ||
    typeof issue.episode_id !== "string" ||
    Number(issue.issue_id) !== input.issue.number ||
    issue.episode_id !== input.issue.episodeId
  )
    return rejected("seal-issue-authority-invalid");

  const projectionPath = "docs/governance/plan-admission-receipts.json";
  if (input.historicalProjectionPath !== projectionPath)
    return rejected("seal-projection-path-noncanonical");
  let projectionBlob: SealedLineageGitBlob | undefined;
  try {
    projectionBlob = git.readBlob(input.sourceCommit, input.historicalProjectionPath);
  } catch {
    projectionBlob = undefined;
  }
  if (
    !projectionBlob ||
    projectionBlob.blobOid !== input.historicalProjectionBlobOid ||
    shaBytes(projectionBlob.bytes) !== input.historicalProjectionContentDigest
  )
    return rejected("seal-projection-custody-mismatch");
  if (!projectionHasTerminal(projectionBlob.bytes, input))
    return rejected("seal-projection-terminal-mismatch");

  let headAfter: string;
  try {
    headAfter = git.readHeadCommit();
  } catch {
    return rejected("seal-source-head-toctou");
  }
  return headAfter === headBefore
    ? { ok: true, issueNumber: Number(issue.issue_id), episodeId: issue.episode_id }
    : rejected("seal-source-head-toctou");
}

function validateIssueAuthority(
  input: SealedLineageMigrationInput,
  source: { readonly issueNumber: number; readonly episodeId: string },
  authority: SealedLineageIssueAuthorityPort | undefined,
): { ok: true } | { ok: false; ruleId: string } {
  if (!authority) return rejected("seal-issue-authority-invalid");
  let observed: SealedLineageIssueAuthorityObservation | undefined;
  try {
    observed = authority.observe(input);
  } catch {
    observed = undefined;
  }
  if (
    !observed ||
    observed.number !== source.issueNumber ||
    input.issue.number !== source.issueNumber ||
    input.issue.episodeId !== source.episodeId ||
    shaBytes(Buffer.from(observed.rawBody, "utf8")) !== input.issue.preimageDigest
  )
    return rejected("seal-issue-authority-invalid");
  return { ok: true };
}

function validateFinalGitCustody(
  input: SealedLineageMigrationInput,
  git: SealedLineageGitPreflightPort | undefined,
): { ok: true } | { ok: false; ruleId: string } {
  if (!git) return rejected("seal-source-head-toctou");
  try {
    if (git.readHeadCommit() !== input.sourceCommit) return rejected("seal-source-head-toctou");
  } catch {
    return rejected("seal-source-head-toctou");
  }
  try {
    return git.isReachableFromTrackedRemote(input.sourceCommit)
      ? { ok: true }
      : rejected("seal-source-commit-unreachable");
  } catch {
    return rejected("seal-source-commit-unreachable");
  }
}

function deriveSuccessorAssetId(repositoryIdentity: string, planId: string): string {
  return `plan:rebase:${framedDigest("ut-tdd-plan-rebase-v1", [repositoryIdentity, planId])}`;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateAuthorities(
  input: SealedLineageMigrationInput,
  reviewAuthority: SealedLineageReviewAuthorityPort | undefined,
): { ok: true } | { ok: false; ruleId: string } {
  const expectedSource = deriveSourceAuthorityDigest(input);
  if (expectedSource !== input.sourceAuthorityDigest)
    return rejected("seal-source-authority-invalid");
  if (!reviewAuthority) return rejected("seal-review-authority-invalid");
  let observation: SealedLineageReviewAuthorityObservation | undefined;
  try {
    observation = reviewAuthority.observe(input);
  } catch {
    observation = undefined;
  }
  if (
    !observation ||
    !Number.isSafeInteger(observation.pullRequestNumber) ||
    observation.pullRequestNumber < 1 ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(observation.headSha) ||
    !observation.baseRef ||
    (observation.custodyState !== "custody_admitted" &&
      observation.custodyState !== "custody_rejected") ||
    !isCanonicalCustodyReasons(observation.custodyReasons) ||
    (observation.custodyState === "custody_admitted" && observation.custodyReasons.length !== 0) ||
    (observation.custodyState === "custody_rejected" &&
      (observation.custodyReasons.length !== 1 ||
        observation.custodyReasons[0] !== "unverified_family"))
  )
    return rejected("seal-review-authority-invalid");
  const expectedReview = deriveReviewAuthorityDigest(input, observation);
  if (expectedReview !== input.reviewedImplementationAuthorityDigest)
    return rejected("seal-review-authority-invalid");
  const expectedCertificate = deriveCertificateDigest(input);
  return expectedCertificate === input.certificateDigest
    ? { ok: true }
    : rejected("seal-certificate-digest-mismatch");
}

function deriveSourceAuthorityDigest(input: SealedLineageMigrationInput): string {
  return framedDigest("ut-tdd-seal-source-authority-v1", [
    input.repositoryIdentity,
    input.planId,
    input.sourcePath,
    input.sourceCommit,
    input.sourceBlobOid,
    input.canonicalPayloadDigest,
    input.bodyDigest,
    input.historicalProjectionPath,
    input.historicalProjectionBlobOid,
    input.historicalProjectionContentDigest,
    input.historicalAssetId,
    String(input.historicalTerminalRevision),
    input.historicalTailDigest,
  ]);
}

function deriveReviewAuthorityDigest(
  input: SealedLineageMigrationInput,
  observation: SealedLineageReviewAuthorityObservation,
): string {
  return framedDigest("ut-tdd-seal-review-authority-v1", [
    input.repositoryIdentity,
    input.planId,
    String(observation.pullRequestNumber),
    observation.baseRef,
    observation.headSha,
    observation.custodyState,
    observation.custodyReasons.join(","),
  ]);
}

function deriveCertificateDigest(input: SealedLineageMigrationInput): string {
  return sha(
    canonical({
      historicalAssetId: input.historicalAssetId,
      historicalTerminalRevision: input.historicalTerminalRevision,
      historicalTailDigest: input.historicalTailDigest,
      planId: input.planId,
      reviewedImplementationAuthorityDigest: input.reviewedImplementationAuthorityDigest,
      sourceAuthorityDigest: input.sourceAuthorityDigest,
      successorAssetId: input.successorAssetId,
      successorRevision: 1,
    }),
  );
}

const custodyReasonOrder: readonly CustodyFailureReason[] = [
  "missing",
  "signature_unverified",
  "signer_mismatch",
  "identity_mismatch",
  "receipt_corrupt",
  "head_raced",
  "provider_failed",
  "verdict_flagged",
  "unverified_family",
  "audit_unavailable",
];

function isCanonicalCustodyReasons(reasons: unknown): reasons is readonly CustodyFailureReason[] {
  if (!Array.isArray(reasons)) return false;
  let previous = -1;
  for (const reason of reasons) {
    if (typeof reason !== "string" || reason.includes(",")) return false;
    const index = custodyReasonOrder.indexOf(reason as CustodyFailureReason);
    if (index < 0 || index <= previous) return false;
    previous = index;
  }
  return true;
}

function readProjectionTerminal(
  bytes: Uint8Array,
  planId: string,
): { assetId: string; revision: number; recordDigest: string } | undefined {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
    records?: readonly Record<string, unknown>[];
  };
  if (!Array.isArray(value.records)) return undefined;
  const candidates = value.records.filter((record) => {
    const binding = plainRecord(record.binding);
    return (
      binding?.plan_id === planId &&
      Number.isSafeInteger(record.sequence) &&
      Number(record.sequence) > 0
    );
  });
  if (candidates.length === 0) return undefined;
  const maxSequence = Math.max(...candidates.map((record) => Number(record.sequence)));
  const terminal = candidates.filter((record) => Number(record.sequence) === maxSequence);
  if (terminal.length !== 1) return undefined;
  const binding = plainRecord(terminal[0]?.binding);
  const assetId = binding?.asset_id;
  const revision = binding?.revision;
  const recordDigest = stripDigestPrefix(String(terminal[0]?.record_digest));
  if (
    typeof assetId !== "string" ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    !/^[0-9a-f]{64}$/.test(recordDigest)
  )
    return undefined;
  return { assetId, revision: Number(revision), recordDigest };
}

function projectionHasTerminal(bytes: Uint8Array, input: SealedLineageMigrationInput): boolean {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      records?: readonly Record<string, unknown>[];
    };
    if (!Array.isArray(value.records)) return false;
    const records = value.records.filter((record) => {
      const binding = record.binding;
      return (
        binding &&
        typeof binding === "object" &&
        (binding as Record<string, unknown>).plan_id === input.planId &&
        Number.isSafeInteger(record.sequence) &&
        Number(record.sequence) > 0
      );
    });
    const maxSequence = Math.max(...records.map((record) => Number(record.sequence)));
    const terminalCandidates = records.filter((record) => Number(record.sequence) === maxSequence);
    if (terminalCandidates.length !== 1) return false;
    const terminal = terminalCandidates[0];
    if (!terminal?.binding || typeof terminal.binding !== "object") return false;
    const binding = terminal.binding as Record<string, unknown>;
    return (
      binding.asset_id === input.historicalAssetId &&
      Number.isSafeInteger(binding.revision) &&
      binding.revision === input.historicalTerminalRevision &&
      stripDigestPrefix(String(terminal.record_digest)) === input.historicalTailDigest
    );
  } catch {
    return false;
  }
}

function framedDigest(label: string, values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of [label, ...values]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength, 0);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

function stableCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableCanonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function shaBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripDigestPrefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function rejected(ruleId: string): { ok: false; ruleId: string } {
  return { ok: false, ruleId };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function without(row: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== field));
}
