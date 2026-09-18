import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderJudgmentEvidencePort } from "../src/feedback/ports/provider-judgment-evidence.ts";
import { composeProviderJudgment } from "../src/feedback/provider-judgment-composition.ts";
import {
  canonicalizeReviewRequest,
  projectReviewVerdict,
  type ReviewAttestation,
  type ReviewAttestationRequest,
} from "../src/feedback/review-attestation.ts";
import type { ReviewReceipt } from "../src/feedback/review-dispatch.ts";
import {
  appendReviewCustodyAudit,
  beginReviewAttempt,
  type ReviewCustodyAuditEvent,
  readReviewCustodyAudit,
  reviewIdentityDigest,
  reviewVerdictPath,
} from "../src/feedback/review-verdict-custody.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// Fault injection for the custody ordering oracles (-009 / -016 / -017 / -022(b)).
// Every mock passes through to the real implementation unless a test arms it.
const faults: {
  failAuditAppendOnce: boolean;
  linkError: string | undefined;
  unlinkError: string | undefined;
  mutateArtifactAfterWrite: boolean;
} = {
  failAuditAppendOnce: false,
  linkError: undefined,
  unlinkError: undefined,
  mutateArtifactAfterWrite: false,
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const linkSync: typeof actual.linkSync = (existing, target) => {
    if (faults.linkError) {
      const error = new Error(`injected ${faults.linkError}`) as NodeJS.ErrnoException;
      error.code = faults.linkError;
      throw error;
    }
    return actual.linkSync(existing, target);
  };
  const unlinkSync: typeof actual.unlinkSync = (path) => {
    if (faults.unlinkError) {
      const error = new Error(`injected ${faults.unlinkError}`) as NodeJS.ErrnoException;
      error.code = faults.unlinkError;
      throw error;
    }
    return actual.unlinkSync(path);
  };
  return { ...actual, linkSync, unlinkSync, default: { ...actual, linkSync, unlinkSync } };
});

vi.mock("../src/feedback/review-verdict-custody.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/feedback/review-verdict-custody.ts")>();
  return {
    ...actual,
    appendReviewCustodyAudit: (repoRoot: string, event: ReviewCustodyAuditEvent) => {
      if (faults.failAuditAppendOnce) {
        faults.failAuditAppendOnce = false;
        throw new Error("injected audit append failure");
      }
      return actual.appendReviewCustodyAudit(repoRoot, event);
    },
  };
});

vi.mock("../src/feedback/adapters/provider-judgment-evidence.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/feedback/adapters/provider-judgment-evidence.ts")>();
  class FaultyAdapter extends actual.FileProviderJudgmentEvidenceAdapter {
    readonly #judgmentsRoot: string;
    constructor(
      options: ConstructorParameters<typeof actual.FileProviderJudgmentEvidenceAdapter>[0],
    ) {
      super(options);
      this.#judgmentsRoot = options.judgmentsRoot;
    }
    override async write(
      judgment: Parameters<ProviderJudgmentEvidencePort["write"]>[0],
    ): ReturnType<ProviderJudgmentEvidencePort["write"]> {
      const result = await super.write(judgment);
      if (faults.mutateArtifactAfterWrite && result.status === "written") {
        // -009: the producer reports success, then the artifact bytes change under it.
        const path = join(this.#judgmentsRoot, `${judgment.judgmentDigest}.json`);
        fs.writeFileSync(path, Buffer.concat([fs.readFileSync(path), Buffer.from(" ")]));
      }
      return result;
    }
  }
  return { ...actual, FileProviderJudgmentEvidenceAdapter: FaultyAdapter };
});

const HEAD = "a".repeat(40);
const REQUEST = {
  memoryId: "memory-composition",
  pr: 570,
  exactHead: HEAD,
  reviewRevision: "",
  authorFamily: "codex" as const,
  requestedAt: "2026-09-14T12:00:00.000Z",
  invocationNonce: "nonce-composition",
};

const roots: string[] = [];

afterEach(() => {
  faults.failAuditAppendOnce = false;
  faults.linkError = undefined;
  faults.mutateArtifactAfterWrite = false;
  for (const root of roots.splice(0)) removeTestTree(root);
});

describe("provider judgment composition", () => {
  it("CANDIDATE-U-D3BCOMP-001/002: accepts only the request digest and rejects missing custody", async () => {
    const fixture = createFixture();
    const before = snapshotWrites(fixture.root);
    const extra = await composeProviderJudgment({
      repoRoot: fixture.root,
      requestDigest: fixture.requestDigest,
      attempt: 1,
      provider: "claude",
    } as never);
    expect(extra).toEqual({ ok: false, reason: "identity_mismatch" });

    const missing = await composeProviderJudgment({
      repoRoot: fixture.root,
      requestDigest: "f".repeat(64),
      attempt: 1,
    });
    expect(missing).toEqual({ ok: false, reason: "request_unavailable" });

    // -002: file name and recomputed reviewRequestDigest disagree.
    const renamed = join(fixture.root, ".ut-tdd", "review", "requests", `${"e".repeat(64)}.json`);
    fs.copyFileSync(
      join(fixture.root, ".ut-tdd", "review", "requests", `${fixture.requestDigest}.json`),
      renamed,
    );
    const mismatch = await composeProviderJudgment({
      repoRoot: fixture.root,
      requestDigest: "e".repeat(64),
      attempt: 1,
    });
    expect(mismatch).toEqual({ ok: false, reason: "request_unavailable" });
    fs.rmSync(renamed);
    expect(snapshotWrites(fixture.root)).toEqual(before);
  });

  it("CANDIDATE-U-D3BCOMP-003: rejects each receipt identity axis independently", async () => {
    for (const axis of ["head", "reviewRevision", "pr"] as const) {
      const fixture = createFixture({ receiptMutation: axis });
      const before = snapshotWrites(fixture.root);
      const result = await composeProviderJudgment({
        repoRoot: fixture.root,
        requestDigest: fixture.requestDigest,
        attempt: 1,
      });
      expect(result).toEqual({ ok: false, reason: "identity_mismatch" });
      expect(snapshotWrites(fixture.root)).toEqual(before);
    }
  });

  it("CANDIDATE-U-D3BCOMP-010: derives a replayable judgment only from custody (bytes and ref unchanged on replay)", async () => {
    const fixture = createFixture();
    const first = await composeProviderJudgment({
      repoRoot: fixture.root,
      requestDigest: fixture.requestDigest,
      attempt: 1,
    });
    expect(first).toMatchObject({
      ok: true,
      providerEvidenceRef: expect.stringMatching(/^d3b:[a-f0-9]{64}$/),
      replay: false,
    });
    if (!first.ok) throw new Error(first.reason);
    const artifact = readFileSync(first.artifactPath);
    const after = snapshotWrites(fixture.root);
    const second = await composeProviderJudgment({
      repoRoot: fixture.root,
      requestDigest: fixture.requestDigest,
      attempt: 1,
    });
    expect(second).toMatchObject({
      ok: true,
      replay: true,
      providerEvidenceRef: first.providerEvidenceRef,
      judgmentDigest: first.judgmentDigest,
    });
    if (!second.ok) throw new Error(second.reason);
    expect(readFileSync(second.artifactPath)).toEqual(artifact);
    expect(snapshotWrites(fixture.root)).toEqual(after);
  });

  it("CANDIDATE-U-D3BCOMP-004/005: rejects missing or ambiguous invocation facts", async () => {
    const fixture = createFixture({ event: false });
    const before = snapshotWrites(fixture.root);
    await expect(
      composeProviderJudgment({
        repoRoot: fixture.root,
        requestDigest: fixture.requestDigest,
        attempt: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "invocation_fact_unavailable" });
    appendReviewCustodyAudit(fixture.root, fixture.event);
    appendReviewCustodyAudit(fixture.root, { ...fixture.event, provider: "codex" });
    const result = await composeProviderJudgment({
      repoRoot: fixture.root,
      requestDigest: fixture.requestDigest,
      attempt: 1,
    });
    expect(result).toEqual({ ok: false, reason: "invocation_fact_ambiguous" });
    expect(snapshotWrites(fixture.root)).toEqual(before);
  });

  it("CANDIDATE-U-D3BCOMP-006: (a) superseded attempt and (b) receiptFileDigest mismatch are typed denials", async () => {
    const superseded = createFixture();
    appendReviewCustodyAudit(superseded.root, {
      kind: "superseded_attempt",
      requestDigest: superseded.requestDigest,
      attempt: 2,
      exactHead: HEAD,
      verdictPath: superseded.event.verdictPath,
      recordedAt: REQUEST.requestedAt,
      reason: "retry",
      provider: "claude",
      model: "claude-test",
      supersededAttempt: 1,
      oldAttemptDigest: "verdict_absent",
    });
    const beforeA = snapshotWrites(superseded.root);
    await expect(
      composeProviderJudgment({
        repoRoot: superseded.root,
        requestDigest: superseded.requestDigest,
        attempt: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "evidence_superseded" });
    expect(snapshotWrites(superseded.root)).toEqual(beforeA);

    const mismatch = createFixture({
      event: false,
      eventMutation: { receiptFileDigest: "0".repeat(64) },
    });
    const beforeB = snapshotWrites(mismatch.root);
    await expect(
      composeProviderJudgment({
        repoRoot: mismatch.root,
        requestDigest: mismatch.requestDigest,
        attempt: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "receipt_mutated" });
    expect(snapshotWrites(mismatch.root)).toEqual(beforeB);
  });

  it("CANDIDATE-U-D3BCOMP-005/006: rejects invalid provider/model event facts and same-family review", async () => {
    for (const mutation of [
      { provider: "codex" as const, model: "claude-test", reason: "same_family_reviewer" },
      { provider: "claude" as const, model: "", reason: "invocation_fact_schema_invalid" },
    ]) {
      const fixture = createFixture({ event: false, eventMutation: mutation });
      const before = snapshotWrites(fixture.root);
      const result = await composeProviderJudgment({
        repoRoot: fixture.root,
        requestDigest: fixture.requestDigest,
        attempt: 1,
      });
      expect(result).toEqual({ ok: false, reason: mutation.reason });
      expect(snapshotWrites(fixture.root)).toEqual(before);
    }
  });

  it("CANDIDATE-U-D3BCOMP-015/019(c): receipt byte mutation, CRLF, key reorder and trailing-LF removal are receipt_mutated", async () => {
    const original = createFixture();
    const receiptPath = join(
      original.root,
      ".ut-tdd",
      "review",
      "receipts",
      `${original.requestDigest}.json`,
    );
    const bytes = readFileSync(receiptPath);
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    for (const mutant of [
      Buffer.from(`${bytes.toString("utf8")} `),
      Buffer.from(bytes.toString("utf8").replace(/\n/g, "\r\n")),
      Buffer.from(`${JSON.stringify(reordered, null, 2)}\n`),
      bytes.subarray(0, bytes.length - 1),
    ]) {
      writeFileSync(receiptPath, mutant);
      const before = snapshotWrites(original.root);
      await expect(
        composeProviderJudgment({
          repoRoot: original.root,
          requestDigest: original.requestDigest,
          attempt: 1,
        }),
      ).resolves.toEqual({ ok: false, reason: "receipt_mutated" });
      expect(snapshotWrites(original.root)).toEqual(before);
    }
  });

  it("CANDIDATE-U-D3BCOMP-019(a)(b)/021: receiptDigest field, request-digest-as-receiptFileDigest and identity drift are typed denials", async () => {
    const withReceiptDigest = createFixture({ event: false });
    appendReviewCustodyAudit(withReceiptDigest.root, {
      ...withReceiptDigest.event,
      receiptDigest: withReceiptDigest.requestDigest,
    });
    const beforeA = snapshotWrites(withReceiptDigest.root);
    expect(
      await composeProviderJudgment({
        repoRoot: withReceiptDigest.root,
        requestDigest: withReceiptDigest.requestDigest,
        attempt: 1,
      }),
    ).toEqual({ ok: false, reason: "invocation_fact_schema_invalid" });
    expect(snapshotWrites(withReceiptDigest.root)).toEqual(beforeA);

    const requestDigestAsFile = createFixture({ event: false });
    appendReviewCustodyAudit(requestDigestAsFile.root, {
      ...requestDigestAsFile.event,
      receiptFileDigest: requestDigestAsFile.requestDigest,
    });
    // §3.2 互換節 / -019(b): the request digest as receiptFileDigest is a schema
    // violation, denied before any byte comparison.
    const beforeB = snapshotWrites(requestDigestAsFile.root);
    expect(
      await composeProviderJudgment({
        repoRoot: requestDigestAsFile.root,
        requestDigest: requestDigestAsFile.requestDigest,
        attempt: 1,
      }),
    ).toEqual({ ok: false, reason: "invocation_fact_schema_invalid" });
    expect(snapshotWrites(requestDigestAsFile.root)).toEqual(beforeB);

    const missingField = createFixture({ event: false });
    const { verdictDigest: _dropped, ...withoutVerdictDigest } = missingField.event;
    appendReviewCustodyAudit(missingField.root, withoutVerdictDigest as ReviewCustodyAuditEvent);
    const beforeC = snapshotWrites(missingField.root);
    expect(
      await composeProviderJudgment({
        repoRoot: missingField.root,
        requestDigest: missingField.requestDigest,
        attempt: 1,
      }),
    ).toEqual({ ok: false, reason: "invocation_fact_schema_invalid" });
    expect(snapshotWrites(missingField.root)).toEqual(beforeC);

    const driftedHead = createFixture({ event: false });
    appendReviewCustodyAudit(driftedHead.root, { ...driftedHead.event, exactHead: "b".repeat(40) });
    const beforeD = snapshotWrites(driftedHead.root);
    expect(
      await composeProviderJudgment({
        repoRoot: driftedHead.root,
        requestDigest: driftedHead.requestDigest,
        attempt: 1,
      }),
    ).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(snapshotWrites(driftedHead.root)).toEqual(beforeD);

    // -021(c) attempt drift: the event's attempt disagrees with the verdictPath it names.
    const driftedAttempt = createFixture({ event: false });
    appendReviewCustodyAudit(driftedAttempt.root, { ...driftedAttempt.event, attempt: 2 });
    const beforeE = snapshotWrites(driftedAttempt.root);
    expect(
      await composeProviderJudgment({
        repoRoot: driftedAttempt.root,
        requestDigest: driftedAttempt.requestDigest,
        attempt: 1,
      }),
    ).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(snapshotWrites(driftedAttempt.root)).toEqual(beforeE);
  });

  it("CANDIDATE-U-D3BCOMP-007: duplicate or malformed findings are evidence_schema_invalid; ascending order is derived, not required", async () => {
    for (const findings of [["same", "same"], [" padded"]]) {
      const fixture = createFixture({ receiptVerdict: "FLAG", receiptFindings: findings });
      const before = snapshotWrites(fixture.root);
      await expect(
        composeProviderJudgment({
          repoRoot: fixture.root,
          requestDigest: fixture.requestDigest,
          attempt: 1,
        }),
      ).resolves.toEqual({ ok: false, reason: "evidence_schema_invalid" });
      expect(snapshotWrites(fixture.root)).toEqual(before);
    }
    const unordered = createFixture({ receiptVerdict: "FLAG", receiptFindings: ["zulu", "alpha"] });
    const composed = await composeProviderJudgment({
      repoRoot: unordered.root,
      requestDigest: unordered.requestDigest,
      attempt: 1,
    });
    expect(composed).toMatchObject({ ok: true });
    if (!composed.ok) throw new Error(composed.reason);
    const payload = JSON.parse(readFileSync(composed.artifactPath, "utf8")) as {
      blocking_findings: string[];
    };
    expect(payload.blocking_findings).toEqual(["alpha", "zulu"]);
  });

  it("CANDIDATE-U-D3BCOMP-008: verdict / findings inconsistency passes the producer's judgment_schema_invalid through", async () => {
    for (const options of [
      { receiptVerdict: "PASS" as const, receiptFindings: ["blocking"] },
      { receiptVerdict: "FLAG" as const, receiptFindings: [] },
    ]) {
      const fixture = createFixture(options);
      const before = snapshotWrites(fixture.root);
      const result = await composeProviderJudgment({
        repoRoot: fixture.root,
        requestDigest: fixture.requestDigest,
        attempt: 1,
      });
      expect(result).toEqual({ ok: false, reason: "judgment_schema_invalid" });
      expect(listJudgments(fixture.root)).toEqual([]);
      expect(snapshotWrites(fixture.root)).toEqual(before);
    }
  });

  it("CANDIDATE-U-D3BCOMP-009: an artifact mutated after the producer reports success is rejected and removed", async () => {
    const fixture = createFixture();
    faults.mutateArtifactAfterWrite = true;
    const before = snapshotWrites(fixture.root);
    const result = await composeProviderJudgment({
      repoRoot: fixture.root,
      requestDigest: fixture.requestDigest,
      attempt: 1,
    });
    expect(result).toEqual({ ok: false, reason: "artifact_verification_failed" });
    expect(listJudgments(fixture.root)).toEqual([]);
    expect(snapshotWrites(fixture.root)).toEqual(before);
  });
});

describe("PLAN-L7-534 §3.2 custody ordering (attempt_completed → hardlink receipt)", () => {
  it("CANDIDATE-U-D3BCOMP-016: audit append failure leaves no receipt or temp and records a retryable failure", () => {
    const { root, request, digest } = custodyFixture();
    const first = beginReviewAttempt({
      repoRoot: root,
      request,
      provider: "claude",
      model: "claude-opus-5",
    });
    if (!first.ok) throw new Error(first.reason);
    writeFileSync(first.path, verdictText(request, 1), "utf8");
    faults.failAuditAppendOnce = true;
    const result = projectReviewVerdict({
      repoRoot: root,
      request,
      attestation: attestation(request, 1, 0),
      verdictFile: first.path,
    });
    expect(result).toEqual({ ok: false, reason: "receipt_write_failed" });
    expect(existsSync(receiptPathOf(root, digest))).toBe(false);
    expect(tempsOf(root, digest)).toEqual([]);
    const failures = readReviewCustodyAudit(root).filter(
      (event) => event.kind === "attempt_execution_failed" && event.attempt === 1,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("receipt_audit_append_failed");
    expect(
      beginReviewAttempt({ repoRoot: root, request, provider: "claude", model: "claude-opus-5" }),
    ).toMatchObject({ ok: true, attempt: 2 });
  });

  it("CANDIDATE-U-D3BCOMP-022(b): each non-EEXIST link errno reaches linkSync and is receipt_link_failed with exactly one event and no receipt", () => {
    for (const code of ["EPERM", "EXDEV"]) {
      const { root, request, digest } = custodyFixture();
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      faults.linkError = code;
      const result = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0),
        verdictFile: first.path,
      });
      faults.linkError = undefined;
      expect(result).toEqual({ ok: false, reason: "receipt_link_failed" });
      expect(existsSync(receiptPathOf(root, digest))).toBe(false);
      expect(tempsOf(root, digest)).toEqual([]);
      expect(
        readReviewCustodyAudit(root).filter(
          (event) => event.kind === "attempt_completed" && event.attempt === 1,
        ),
      ).toHaveLength(1);
    }
  });

  it("CANDIDATE-U-D3BCOMP-017: the crash window (event, no receipt) is never re-linked, is non-terminal, and compose denies receipt_unavailable", async () => {
    const { root, request, digest } = custodyFixture();
    const first = beginReviewAttempt({
      repoRoot: root,
      request,
      provider: "claude",
      model: "claude-opus-5",
    });
    if (!first.ok) throw new Error(first.reason);
    writeFileSync(first.path, verdictText(request, 1), "utf8");
    faults.linkError = "EPERM";
    expect(
      projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0),
        verdictFile: first.path,
      }),
    ).toEqual({ ok: false, reason: "receipt_link_failed" });
    faults.linkError = undefined;
    // Fault cleared: re-projecting the same attempt must not re-link, must not
    // append a second invocation fact and must not create a receipt.
    expect(
      projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0),
        verdictFile: first.path,
      }),
    ).toEqual({ ok: false, reason: "receipt_link_failed" });
    expect(existsSync(receiptPathOf(root, digest))).toBe(false);
    expect(tempsOf(root, digest)).toEqual([]);
    const completed = readReviewCustodyAudit(root).filter(
      (event) => event.kind === "attempt_completed" && event.attempt === 1,
    );
    expect(completed).toHaveLength(1);
    await expect(
      composeProviderJudgment({ repoRoot: root, requestDigest: digest, attempt: 1 }),
    ).resolves.toEqual({ ok: false, reason: "receipt_unavailable" });
    // Non-terminal: the next attempt starts and supersedes attempt 1; attempt 1 is never re-linked.
    const second = beginReviewAttempt({
      repoRoot: root,
      request,
      provider: "claude",
      model: "claude-opus-5",
    });
    expect(second).toMatchObject({ ok: true, attempt: 2 });
    if (!second.ok) throw new Error(second.reason);
    writeFileSync(second.path, verdictText(request, 2), "utf8");
    const done = projectReviewVerdict({
      repoRoot: root,
      request,
      attestation: attestation(request, 2, 0),
      verdictFile: second.path,
    });
    expect(done.ok).toBe(true);
    const events = readReviewCustodyAudit(root);
    const secondFacts = events.filter((e) => e.kind === "attempt_completed" && e.attempt === 2);
    expect(secondFacts).toHaveLength(1);
    expect(secondFacts[0].receiptFileDigest).toBe(sha(readFileSync(receiptPathOf(root, digest))));
    await expect(
      composeProviderJudgment({ repoRoot: root, requestDigest: digest, attempt: 1 }),
    ).resolves.toEqual({ ok: false, reason: "evidence_superseded" });
  });

  it("CANDIDATE-U-D3BCOMP-018: a leftover temp file is ignored and removed when the next attempt starts", () => {
    const { root, request, digest } = custodyFixture();
    const directory = join(root, ".ut-tdd", "review", "receipts");
    mkdirSync(directory, { recursive: true });
    const temp = join(directory, `.${digest}.json.tmp-999-leftover`);
    writeFileSync(temp, `${JSON.stringify({ verdict: "FLAG", forged: true })}\n`);
    const first = beginReviewAttempt({
      repoRoot: root,
      request,
      provider: "claude",
      model: "claude-opus-5",
    });
    expect(first).toMatchObject({ ok: true, attempt: 1 });
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(receiptPathOf(root, digest))).toBe(false);
    if (!first.ok) throw new Error(first.reason);
    writeFileSync(first.path, verdictText(request, 1), "utf8");
    const done = projectReviewVerdict({
      repoRoot: root,
      request,
      attestation: attestation(request, 1, 0),
      verdictFile: first.path,
    });
    expect(done.ok).toBe(true);
    const receipt = readFileSync(receiptPathOf(root, digest));
    expect(receipt.toString("utf8")).not.toContain("forged");
    const completed = readReviewCustodyAudit(root).filter((e) => e.kind === "attempt_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].receiptFileDigest).toBe(sha(receipt));
  });

  it("CANDIDATE-U-D3BCOMP-020/022(a): orphan receipt — same bytes complete idempotently, different bytes conflict without overwrite, matching event is terminal", () => {
    // (a) orphan receipt whose bytes equal what the next attempt regenerates.
    const same = custodyFixture();
    const probe = beginReviewAttempt({
      repoRoot: same.root,
      request: same.request,
      provider: "claude",
      model: "claude-opus-5",
    });
    if (!probe.ok) throw new Error(probe.reason);
    writeFileSync(probe.path, verdictText(same.request, 1), "utf8");
    const completed = projectReviewVerdict({
      repoRoot: same.root,
      request: same.request,
      attestation: attestation(same.request, 1, 0),
      verdictFile: probe.path,
    });
    if (!completed.ok) throw new Error(completed.reason);
    const receiptBytes = readFileSync(receiptPathOf(same.root, same.digest));
    // Turn it into an orphan: drop the audit trail (receipt-without-fact left by an older path).
    fs.rmSync(join(same.root, ".git", "ut-tdd-runtime"), { recursive: true, force: true });
    fs.rmSync(join(same.root, ".ut-tdd", "review", "verdicts"), { recursive: true, force: true });
    const retry = beginReviewAttempt({
      repoRoot: same.root,
      request: same.request,
      provider: "claude",
      model: "claude-opus-5",
    });
    expect(retry).toMatchObject({ ok: true, attempt: 1 });
    if (!retry.ok) throw new Error(retry.reason);
    writeFileSync(retry.path, verdictText(same.request, 1), "utf8");
    const idempotent = projectReviewVerdict({
      repoRoot: same.root,
      request: same.request,
      attestation: attestation(same.request, 1, 0),
      verdictFile: retry.path,
    });
    expect(idempotent.ok).toBe(true);
    expect(readFileSync(receiptPathOf(same.root, same.digest))).toEqual(receiptBytes);
    expect(
      readdirSync(join(same.root, ".ut-tdd", "review", "receipts")).filter((n) =>
        n.endsWith(".json"),
      ),
    ).toHaveLength(1);
    const facts = readReviewCustodyAudit(same.root).filter((e) => e.kind === "attempt_completed");
    expect(facts).toHaveLength(1);
    expect(facts[0].receiptFileDigest).toBe(sha(receiptBytes));
    // (c) with a matching event the receipt is terminal.
    expect(
      beginReviewAttempt({
        repoRoot: same.root,
        request: same.request,
        provider: "claude",
        model: "claude-opus-5",
      }),
    ).toEqual({ ok: false, reason: "review_receipt_already_exists" });

    // (b) orphan receipt with foreign bytes: the attempt starts, the link loses to EEXIST,
    // bytes differ, and the existing file is left untouched with a typed conflict.
    const differing = custodyFixture();
    const directory = join(differing.root, ".ut-tdd", "review", "receipts");
    mkdirSync(directory, { recursive: true });
    const foreign = Buffer.from(`${JSON.stringify({ foreign: true })}\n`);
    writeFileSync(receiptPathOf(differing.root, differing.digest), foreign);
    const start = beginReviewAttempt({
      repoRoot: differing.root,
      request: differing.request,
      provider: "claude",
      model: "claude-opus-5",
    });
    expect(start).toMatchObject({ ok: true, attempt: 1 });
    if (!start.ok) throw new Error(start.reason);
    writeFileSync(start.path, verdictText(differing.request, 1), "utf8");
    const conflict = projectReviewVerdict({
      repoRoot: differing.root,
      request: differing.request,
      attestation: attestation(differing.request, 1, 0),
      verdictFile: start.path,
    });
    expect(conflict).toEqual({ ok: false, reason: "verdict_identity_conflict" });
    expect(readFileSync(receiptPathOf(differing.root, differing.digest))).toEqual(foreign);
    expect(tempsOf(differing.root, differing.digest)).toEqual([]);
    expect(
      readReviewCustodyAudit(differing.root).filter((e) => e.kind === "attempt_outcome_conflict"),
    ).toHaveLength(1);
  });

  it("CANDIDATE-U-D3BCOMP-021: a digest-matching but malformed or identity-drifted attempt_completed is not terminal", () => {
    for (const mutate of [
      (event: ReviewCustodyAuditEvent): ReviewCustodyAuditEvent => {
        const { verdictDigest: _dropped, ...rest } = event;
        return rest as ReviewCustodyAuditEvent;
      },
      (event: ReviewCustodyAuditEvent): ReviewCustodyAuditEvent => ({
        ...event,
        receiptDigest: event.requestDigest,
      }),
      (event: ReviewCustodyAuditEvent): ReviewCustodyAuditEvent => ({
        ...event,
        exactHead: "b".repeat(40),
      }),
      // -021(c) attempt drift: attempt field disagrees with the verdictPath it names.
      (event: ReviewCustodyAuditEvent): ReviewCustodyAuditEvent => ({
        ...event,
        attempt: 2,
      }),
    ]) {
      const { root, request, digest } = custodyFixture();
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      const done = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0),
        verdictFile: first.path,
      });
      if (!done.ok) throw new Error(done.reason);
      // Rewrite the single attempt_completed event into its malformed twin (digest still matches).
      const auditPath = join(
        root,
        ".git",
        "ut-tdd-runtime",
        "review-custody",
        "review-custody.jsonl",
      );
      const lines = readFileSync(auditPath, "utf8").split(/\r?\n/).filter(Boolean);
      const rewritten = lines.map((line) => {
        const event = JSON.parse(line) as ReviewCustodyAuditEvent;
        return event.kind === "attempt_completed" ? JSON.stringify(mutate(event)) : line;
      });
      writeFileSync(auditPath, `${rewritten.join("\n")}\n`);
      const next = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      expect(next).toMatchObject({ ok: true, attempt: 2 });
      expect(readFileSync(receiptPathOf(root, digest)).length).toBeGreaterThan(0);
    }
  });

  it("CANDIDATE-U-D3BCOMP-022(c): a failing best-effort temp unlink after a successful link is still ok with one receipt and one event", () => {
    const { root, request, digest } = custodyFixture();
    const first = beginReviewAttempt({
      repoRoot: root,
      request,
      provider: "claude",
      model: "claude-opus-5",
    });
    if (!first.ok) throw new Error(first.reason);
    writeFileSync(first.path, verdictText(request, 1), "utf8");
    faults.unlinkError = "EPERM";
    let result: ReturnType<typeof projectReviewVerdict>;
    try {
      result = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0),
        verdictFile: first.path,
      });
    } finally {
      faults.unlinkError = undefined;
    }
    expect(result).toMatchObject({ ok: true, digest });
    expect(readFileSync(receiptPathOf(root, digest)).length).toBeGreaterThan(0);
    // The temp survives the failed unlink (best-effort), but the receipt is linked.
    expect(tempsOf(root, digest)).toHaveLength(1);
    expect(
      readReviewCustodyAudit(root).filter(
        (event) => event.kind === "attempt_completed" && event.attempt === 1,
      ),
    ).toHaveLength(1);
    // The linked receipt is terminal: no further attempt may start.
    expect(
      beginReviewAttempt({ repoRoot: root, request, provider: "claude", model: "claude-opus-5" }),
    ).toMatchObject({ ok: false });
  });
});

// ---- fixtures -------------------------------------------------------------

function createFixture(
  options: {
    event?: boolean;
    eventMutation?: Partial<
      Pick<ReviewCustodyAuditEvent, "provider" | "model" | "receiptFileDigest">
    >;
    receiptMutation?: "head" | "reviewRevision" | "pr";
    receiptVerdict?: ReviewReceipt["verdict"];
    receiptFindings?: string[];
  } = {},
): {
  root: string;
  requestDigest: string;
  event: ReviewCustodyAuditEvent;
} {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-d3b-composition-"));
  roots.push(root);
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.invalid"]);
  runGit(root, ["config", "user.name", "test"]);
  runGit(root, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  writeFileSync(
    join(root, "ut-tdd.project.json"),
    `${JSON.stringify({ schema_version: "ut-tdd.project/v1", repository_identity: "acme/widget" }, null, 2)}\n`,
  );
  runGit(root, ["add", "ut-tdd.project.json"]);
  runGit(root, ["commit", "-m", "fixture"]);
  const requestDigest = reviewIdentityDigest(REQUEST);
  const request = { ...REQUEST, reviewRevision: `rv1-${requestDigest}` };
  const requestDir = join(root, ".ut-tdd", "review", "requests");
  const receiptDir = join(root, ".ut-tdd", "review", "receipts");
  mkdirSync(requestDir, { recursive: true });
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(requestDir, `${requestDigest}.json`), `${JSON.stringify(request, null, 2)}\n`);
  const receipt: ReviewReceipt = {
    memoryId: request.memoryId,
    pr: options.receiptMutation === "pr" ? request.pr + 1 : request.pr,
    head: options.receiptMutation === "head" ? "b".repeat(40) : request.exactHead,
    reviewRevision:
      options.receiptMutation === "reviewRevision"
        ? `rv1-${"e".repeat(64)}`
        : request.reviewRevision,
    reviewerFamily: "claude",
    kind: "verdict",
    verdict: options.receiptVerdict ?? "PASS",
    blockingFindings: options.receiptFindings ?? [],
    at: request.requestedAt,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptPath = join(receiptDir, `${requestDigest}.json`);
  writeFileSync(receiptPath, receiptBytes);
  const verdictPath = reviewVerdictPath(root, requestDigest, 1);
  mkdirSync(join(root, ".ut-tdd", "review", "verdicts", requestDigest, "attempts", "attempt-1"), {
    recursive: true,
  });
  writeFileSync(verdictPath, "verdict: PASS\n");
  const event: ReviewCustodyAuditEvent = {
    kind: "attempt_completed",
    requestDigest,
    attempt: 1,
    exactHead: request.exactHead,
    verdictPath,
    recordedAt: request.requestedAt,
    reason: "review_completed",
    provider: options.eventMutation?.provider ?? "claude",
    model: options.eventMutation?.model ?? "claude-test",
    exitCode: 0,
    receiptFileDigest: options.eventMutation?.receiptFileDigest ?? sha(receiptBytes),
    verdictDigest: sha(readFileSync(verdictPath)),
  };
  if (options.event !== false || options.eventMutation) appendReviewCustodyAudit(root, event);
  return { root, requestDigest, event };
}

/** Real custody path: request via canonicalizeReviewRequest, receipt via projectReviewVerdict. */
function custodyFixture(): { root: string; request: ReviewAttestationRequest; digest: string } {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-d3b-custody-"));
  roots.push(root);
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.invalid"]);
  runGit(root, ["config", "user.name", "test"]);
  runGit(root, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  writeFileSync(
    join(root, "ut-tdd.project.json"),
    `${JSON.stringify({ schema_version: "ut-tdd.project/v1", repository_identity: "acme/widget" }, null, 2)}\n`,
  );
  runGit(root, ["add", "ut-tdd.project.json"]);
  runGit(root, ["commit", "-m", "fixture"]);
  const request = canonicalizeReviewRequest({
    memoryId: "memory:d3b-custody",
    pr: 570,
    exactHead: HEAD,
    reviewRevision: "legacy-revision",
    authorFamily: "codex",
    requestedAt: "2026-09-14T12:00:00.000Z",
  });
  const digest = reviewIdentityDigest(request);
  const requestDir = join(root, ".ut-tdd", "review", "requests");
  mkdirSync(requestDir, { recursive: true });
  writeFileSync(join(requestDir, `${digest}.json`), `${JSON.stringify(request, null, 2)}\n`);
  return { root, request, digest };
}

function attestation(
  request: ReviewAttestationRequest,
  attempt: number,
  exitCode: number,
  model = "claude-opus-5",
): ReviewAttestation {
  return {
    provider: "claude",
    role: "blind-reviewer",
    model,
    pr: request.pr,
    head: request.exactHead,
    reviewRevision: request.reviewRevision,
    startedAt: "2026-09-14T12:00:00.000Z",
    completedAt: "2026-09-14T12:01:00.000Z",
    exitCode,
    attempt,
    invocationNonce: request.invocationNonce,
  };
}

function verdictText(
  request: ReviewAttestationRequest,
  attempt: number,
  model = "claude-opus-5",
): string {
  return [
    "schema_version: ut-tdd.review-verdict/v1",
    `request_digest: ${reviewIdentityDigest(request)}`,
    `attempt: ${attempt}`,
    `pr: ${request.pr}`,
    `exact_head: ${request.exactHead}`,
    `review_revision: ${request.reviewRevision}`,
    "reviewer_provider: claude",
    `reviewer_model: ${model}`,
    `invocation_nonce: ${request.invocationNonce}`,
    "VERDICT: PASS",
  ].join("\n");
}

function receiptPathOf(root: string, digest: string): string {
  return join(root, ".ut-tdd", "review", "receipts", `${digest}.json`);
}

function tempsOf(root: string, digest: string): string[] {
  const directory = join(root, ".ut-tdd", "review", "receipts");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.startsWith(`.${digest}.json.tmp-`));
}

function listJudgments(root: string): string[] {
  const directory = join(root, ".ut-tdd", "review", "judgments");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json"));
}

/** Byte digests of every file under evidence / judgments / receipts (write-zero oracle). */
function snapshotWrites(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const category of ["evidence", "judgments", "receipts"]) {
    const base = join(root, ".ut-tdd", "review", category);
    if (!existsSync(base)) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else out[path.slice(root.length)] = sha(readFileSync(path));
      }
    };
    walk(base);
  }
  return out;
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
