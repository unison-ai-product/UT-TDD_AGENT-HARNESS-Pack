/**
 * D3d の workflow 側 entrypoint (PLAN-L7-465 §D3c freeze「発行・検証境界」)。
 *
 * `.github/workflows/review-attestation.yml` から `issue` / `admit` として呼ばれる。
 * ここは I/O (gh API 呼び出し・ファイル読み書き・env 解決) だけを持ち、判定は
 * `review-custody.ts` の domain に置く。CLI surface (`src/cli.ts`) は D2 の所有なので
 * 触らない。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createGhAttestationVerifier } from "./adapters/gh-attestation-verifier.ts";
import {
  admitReviewCustody,
  buildReviewCustodyReceipt,
  type CustodyDecision,
  type CustodyPullRequestFacts,
  type CustodyReceiptDraft,
  type CustodyWorkflowRunFacts,
  DEFAULT_CUSTODY_VERIFICATION_ATTEMPTS,
  verifyObservationStability,
} from "./review-custody.ts";
import type { ReviewRequestIdentity } from "./review-custody-canonical.ts";

export const CUSTODY_ISSUER = "https://token.actions.githubusercontent.com";

export interface RunnerEnvironment {
  readonly get: (name: string) => string | undefined;
  readonly runGh: (args: readonly string[]) => { status: number | null; stdout: string };
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly log: (line: string) => void;
}

export type RunnerOutcome = { readonly exitCode: number; readonly summary: string };
export interface LiveCustodyObservation {
  readonly facts: CustodyPullRequestFacts;
  readonly decision: CustodyDecision;
}

function requireText(input: { env: RunnerEnvironment; name: string }): string {
  const value = input.env.get(input.name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`missing required environment value: ${input.name}`);
  }
  return value.trim();
}

function requireInteger(input: { env: RunnerEnvironment; name: string }): number {
  const parsed = Number(requireText(input));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`environment value must be a positive integer: ${input.name}`);
  }
  return parsed;
}

function pick(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  return (source as Record<string, unknown>)[key];
}

function readPullRequestFacts(input: {
  env: RunnerEnvironment;
  repository: string;
  prNumber: number;
}): CustodyPullRequestFacts {
  const result = input.env.runGh([
    "api",
    `repos/${input.repository}/pulls/${input.prNumber}`,
    "--header",
    "Cache-Control: no-cache",
  ]);
  if (result.status !== 0) {
    throw new Error(`gh api read failed for pull request ${input.prNumber}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  const base = pick(parsed, "base");
  const head = pick(parsed, "head");
  const merged = pick(parsed, "merged") === true;
  const rawState = pick(parsed, "state");
  const mergeCommitSha = pick(parsed, "merge_commit_sha");
  const mergedAt = pick(parsed, "merged_at");
  const state: CustodyPullRequestFacts["state"] = merged
    ? "MERGED"
    : rawState === "open"
      ? "OPEN"
      : "CLOSED";
  return {
    repository: String(pick(pick(head, "repo"), "full_name") ?? ""),
    prNumber: Number(pick(parsed, "number")),
    baseRef: String(pick(base, "ref") ?? ""),
    headSha: String(pick(head, "sha") ?? ""),
    state,
    mergeSha: merged && typeof mergeCommitSha === "string" ? mergeCommitSha : null,
    mergedAt: merged && typeof mergedAt === "string" ? mergedAt : null,
  };
}

function requestIdentity(input: {
  env: RunnerEnvironment;
  prNumber: number;
  headSha: string;
}): ReviewRequestIdentity {
  const authorFamily = requireText({ env: input.env, name: "UT_TDD_CUSTODY_AUTHOR_FAMILY" });
  if (authorFamily !== "claude" && authorFamily !== "codex") {
    throw new Error("UT_TDD_CUSTODY_AUTHOR_FAMILY must be claude or codex");
  }
  return {
    schemaVersion: "review-request/v1",
    memoryId: requireText({ env: input.env, name: "UT_TDD_CUSTODY_MEMORY_ID" }),
    pr: input.prNumber,
    exactHead: input.headSha,
    authorFamily,
  };
}

function draftFromEnvironment(input: {
  env: RunnerEnvironment;
  facts: CustodyPullRequestFacts;
}): CustodyReceiptDraft {
  const { env, facts } = input;
  const reviewerFamily = requireText({ env, name: "UT_TDD_CUSTODY_REVIEWER_FAMILY" });
  const authorFamily = requireText({ env, name: "UT_TDD_CUSTODY_AUTHOR_FAMILY" });
  const verdict = requireText({ env, name: "UT_TDD_CUSTODY_VERDICT" });
  if (reviewerFamily !== "claude" && reviewerFamily !== "codex") {
    throw new Error("UT_TDD_CUSTODY_REVIEWER_FAMILY must be claude or codex");
  }
  if (authorFamily !== "claude" && authorFamily !== "codex") {
    throw new Error("UT_TDD_CUSTODY_AUTHOR_FAMILY must be claude or codex");
  }
  if (verdict !== "PASS" && verdict !== "PASS-WEAK" && verdict !== "FLAG") {
    throw new Error("UT_TDD_CUSTODY_VERDICT must be PASS, PASS-WEAK, or FLAG");
  }
  const receiptKind = facts.state === "MERGED" ? "post_merge_closure" : "pre_merge_review";
  const mergeMethod =
    receiptKind === "post_merge_closure" ? requireMergeMethod({ env }) : undefined;
  return {
    receiptKind,
    repository: facts.repository,
    prNumber: facts.prNumber,
    baseRef: facts.baseRef,
    headSha: facts.headSha,
    mergeSha: receiptKind === "post_merge_closure" ? (facts.mergeSha ?? undefined) : undefined,
    mergeMethod,
    mergedAt: receiptKind === "post_merge_closure" ? (facts.mergedAt ?? undefined) : undefined,
    planId: requireText({ env, name: "UT_TDD_CUSTODY_PLAN_ID" }),
    planRevision: requireText({ env, name: "UT_TDD_CUSTODY_PLAN_REVISION" }),
    requestIdentity: requestIdentity({ env, prNumber: facts.prNumber, headSha: facts.headSha }),
    judgmentDigest: requireText({ env, name: "UT_TDD_CUSTODY_JUDGMENT_DIGEST" }),
    workflowRef: requireText({ env, name: "GITHUB_WORKFLOW_REF" }),
    workflowSha: requireText({ env, name: "GITHUB_SHA" }),
    runId: requireText({ env, name: "GITHUB_RUN_ID" }),
    runAttempt: requireInteger({ env, name: "GITHUB_RUN_ATTEMPT" }),
    issuer: CUSTODY_ISSUER,
    providerEvidenceRef: requireText({ env, name: "UT_TDD_CUSTODY_PROVIDER_EVIDENCE_REF" }),
    reviewerFamily,
    authorFamily,
    verdict,
    blockingFindingCount: Number(env.get("UT_TDD_CUSTODY_BLOCKING_FINDINGS") ?? "0"),
  };
}

function requireMergeMethod(input: { env: RunnerEnvironment }): "merge" | "squash" | "rebase" {
  const value = requireText({ env: input.env, name: "UT_TDD_CUSTODY_MERGE_METHOD" });
  if (value !== "merge" && value !== "squash" && value !== "rebase") {
    throw new Error("UT_TDD_CUSTODY_MERGE_METHOD must be merge, squash, or rebase");
  }
  return value;
}

function runFacts(input: {
  env: RunnerEnvironment;
  facts: CustodyPullRequestFacts;
}): CustodyWorkflowRunFacts {
  const { env, facts } = input;
  return {
    repository: requireText({ env, name: "GITHUB_REPOSITORY" }),
    runId: requireText({ env, name: "GITHUB_RUN_ID" }),
    runAttempt: requireInteger({ env, name: "GITHUB_RUN_ATTEMPT" }),
    workflowRef: requireText({ env, name: "GITHUB_WORKFLOW_REF" }),
    workflowSha: requireText({ env, name: "GITHUB_SHA" }),
    headSha: facts.headSha,
    status: "completed",
    conclusion: "success",
  };
}

function observeStable(input: {
  env: RunnerEnvironment;
  repository: string;
  prNumber: number;
}): CustodyPullRequestFacts {
  const first = readPullRequestFacts(input);
  const second = readPullRequestFacts(input);
  const stability = verifyObservationStability({
    eventPayload: first,
    apiRead1: first,
    apiRead2: second,
  });
  if (!stability.ok) throw new Error(`pull request facts raced: ${stability.detail}`);
  return stability.facts;
}

/** receipt を発行して artifact path へ書く。 */
export function issueCustodyReceipt(env: RunnerEnvironment): RunnerOutcome {
  const repository = requireText({ env, name: "GITHUB_REPOSITORY" });
  const prNumber = requireInteger({ env, name: "UT_TDD_CUSTODY_PR" });
  const facts = observeStable({ env, repository, prNumber });
  const built = buildReviewCustodyReceipt({
    draft: draftFromEnvironment({ env, facts }),
    attempts: DEFAULT_CUSTODY_VERIFICATION_ATTEMPTS,
  });
  if (!built.ok) {
    env.log(`review-custody issue - violation ${built.reason} (${built.detail})`);
    return { exitCode: 1, summary: built.reason };
  }
  env.writeFile(requireText({ env, name: "UT_TDD_CUSTODY_RECEIPT_PATH" }), built.text);
  env.log(`review-custody issue - OK (artifactDigest=${built.artifactDigest})`);
  return { exitCode: 0, summary: built.artifactDigest };
}

/**
 * 発行済み receipt を実 GitHub facts + attestation と突き合わせる。
 *
 * 承認済み `VerifiedProviderIdentity` の発行側は本 repo に存在しないため、機械 custody が
 * すべて green でも終端は `unverified_family` になる。それ以外の reason は live 障害として
 * exit 1 にする (判定不能を成功へ丸めない)。
 */
export async function admitCustodyReceipt(env: RunnerEnvironment): Promise<RunnerOutcome> {
  const { decision } = await observeAndAdmitCustodyReceipt(env);
  if (decision.state === "custody_admitted") {
    env.log(`review-custody admit - OK (custody_admitted, run=${decision.runId})`);
    return { exitCode: 0, summary: "custody_admitted" };
  }
  const reasons = [...decision.reasons];
  if (reasons.length === 1 && reasons[0] === "unverified_family") {
    env.log(
      "review-custody admit - OK (mechanical custody verified; terminal state unverified_family, provider family authority is not approved yet)",
    );
    return { exitCode: 0, summary: "unverified_family" };
  }
  env.log(`review-custody admit - violation ${reasons.join(",")} (${decision.details.join(",")})`);
  return { exitCode: 1, summary: reasons.join(",") };
}

/** stable live factsとdomain custody decisionをsummary文字列へ潰さず返す。 */
export async function observeAndAdmitCustodyReceipt(
  env: RunnerEnvironment,
): Promise<LiveCustodyObservation> {
  const repository = requireText({ env, name: "GITHUB_REPOSITORY" });
  const prNumber = requireInteger({ env, name: "UT_TDD_CUSTODY_PR" });
  const receiptPath = requireText({ env, name: "UT_TDD_CUSTODY_RECEIPT_PATH" });
  const receiptText = env.readFile(receiptPath);
  const facts = observeStable({ env, repository, prNumber });
  const decision = await admitReviewCustody({
    receiptText,
    receiptPath,
    expected: {
      repository: facts.repository,
      prNumber: facts.prNumber,
      baseRef: facts.baseRef,
      headSha: facts.headSha,
      receiptKind: facts.state === "MERGED" ? "post_merge_closure" : "pre_merge_review",
      mergeMethod: facts.state === "MERGED" ? requireMergeMethod({ env }) : undefined,
      planId: requireText({ env, name: "UT_TDD_CUSTODY_PLAN_ID" }),
      planRevision: requireText({ env, name: "UT_TDD_CUSTODY_PLAN_REVISION" }),
      requestIdentity: requestIdentity({ env, prNumber: facts.prNumber, headSha: facts.headSha }),
      judgmentDigest: requireText({ env, name: "UT_TDD_CUSTODY_JUDGMENT_DIGEST" }),
      workflowRef: requireText({ env, name: "GITHUB_WORKFLOW_REF" }),
      issuer: CUSTODY_ISSUER,
    },
    observations: {
      eventPayload: facts,
      apiRead1: facts,
      apiRead2: facts,
      run: runFacts({ env, facts }),
    },
    authority: {
      attestationVerifier: createGhAttestationVerifier(),
      providerIdentity: null,
    },
  });
  return { facts, decision };
}

function processEnvironment(): RunnerEnvironment {
  return {
    get: (name) => process.env[name],
    runGh: (args) => {
      const result = spawnSync("gh", [...args], { encoding: "utf8", windowsHide: true });
      if (result.error) return { status: null, stdout: "" };
      return { status: result.status, stdout: result.stdout ?? "" };
    },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

export async function runReviewCustodyRunner(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const env = processEnvironment();
  if (command === "issue") return issueCustodyReceipt(env).exitCode;
  if (command === "admit") return (await admitCustodyReceipt(env)).exitCode;
  env.log("review-custody - violation unknown_command (expected issue or admit)");
  return 2;
}

if (process.argv[1]?.endsWith("review-custody-runner.ts") === true) {
  runReviewCustodyRunner(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // raw stack は出さない (絶対 path / token の巻き込みを断つ)。
      const message = error instanceof Error ? error.message : "unknown runner failure";
      process.stdout.write(`review-custody - violation runner_failed (${message})\n`);
      process.exitCode = 1;
    },
  );
}
