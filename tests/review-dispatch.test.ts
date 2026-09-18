import { describe, expect, it } from "vitest";
import {
  analyzeReviewDispatch,
  DEFAULT_REVIEW_DISPATCH_SLA,
  type PrObservation,
  type ReviewDispatchEntry,
  type ReviewReceipt,
  type ReviewRequest,
  reviewDispatchMessages,
} from "../src/feedback/review-dispatch.ts";

const REQUESTED_AT = "2026-07-31T00:00:00.000Z";

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    memoryId: "memory-001",
    pr: 201,
    exactHead: "a".repeat(40),
    reviewRevision: "revision-001",
    authorFamily: "claude",
    requestedAt: REQUESTED_AT,
    ...overrides,
  };
}

function receipt(
  kind: ReviewReceipt["kind"],
  overrides: Partial<ReviewReceipt> = {},
): ReviewReceipt {
  return {
    memoryId: "memory-001",
    pr: 201,
    head: "a".repeat(40),
    reviewRevision: "revision-001",
    reviewerFamily: "codex",
    kind,
    at: "2026-07-31T00:01:00.000Z",
    ...overrides,
  };
}

function completeSequence(overrides: Partial<ReviewReceipt> = {}): ReviewReceipt[] {
  return [
    receipt("acknowledged", { at: "2026-07-31T00:01:00.000Z", ...overrides }),
    receipt("in_review", { at: "2026-07-31T00:02:00.000Z", ...overrides }),
    receipt("verdict", {
      at: "2026-07-31T00:03:00.000Z",
      verdict: "PASS",
      ...overrides,
    }),
  ];
}

function pr(overrides: Partial<PrObservation> = {}): PrObservation {
  return {
    pr: 201,
    headSha: "a".repeat(40),
    state: "OPEN",
    checksGreen: true,
    ...overrides,
  };
}

function entry(result: { entries: ReviewDispatchEntry[] }): ReviewDispatchEntry {
  expect(result.entries).toHaveLength(1);
  return result.entries[0];
}

describe("review dispatch analyzer (U-RVDISP)", () => {
  it("U-RVDISP-032: timezone明示ISOを決定的に受理し、TZ無しはSLAごとfail-closeする", () => {
    const canonical = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(canonical.ok).toBe(true);
    expect(entry(canonical).ageMinutes).toBe(10);

    const githubSeconds = analyzeReviewDispatch({
      requests: [request({ requestedAt: "2026-07-31T00:00:00Z" })],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T09:10:00+09:00",
    });
    expect(githubSeconds.ok).toBe(true);
    expect(entry(githubSeconds).ageMinutes).toBe(10);
    expect(entry(githubSeconds).breaches).toEqual([]);

    const zoneLessRequest = analyzeReviewDispatch({
      requests: [request({ requestedAt: "2026-07-31T00:00:00" })],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(zoneLessRequest).reasons).toContain("invalid_timestamp");
    expect(entry(zoneLessRequest).ageMinutes).toBeNull();
    expect(entry(zoneLessRequest).breaches).toEqual(["verdict"]);
    expect(zoneLessRequest.ok).toBe(false);

    const impossibleDate = analyzeReviewDispatch({
      requests: [request({ requestedAt: "2026-02-30T00:00:00Z" })],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T00:10:00Z",
    });
    expect(entry(impossibleDate).reasons).toContain("invalid_timestamp");
    expect(impossibleDate.ok).toBe(false);
  });

  it("U-RVDISP-033: 同一instantの秒/millis/offset表現はrequest/receipt replayで競合しない", () => {
    const result = analyzeReviewDispatch({
      requests: [
        request({ requestedAt: "2026-07-31T00:00:00Z" }),
        request({ requestedAt: "2026-07-31T09:00:00.000+09:00" }),
      ],
      receipts: [
        receipt("acknowledged", { at: "2026-07-31T00:01:00Z" }),
        receipt("acknowledged", { at: "2026-07-31T09:01:00.000+09:00" }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("acknowledged");
    expect(entry(result).reasons).not.toContain("duplicate_request_conflict");
    expect(entry(result).reasons).not.toContain("duplicate_receipt_conflict");
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-001: 受領前は requested、SLA 内なら breach 無し", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("requested");
    expect(entry(result).breaches).toEqual([]);
    expect(entry(result).ageMinutes).toBe(10);
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-002: verdict SLAだけを検知し、境界ちょうどは breach にしない", () => {
    const input = { requests: [request()], receipts: [], prs: [pr()] };

    expect(
      entry(analyzeReviewDispatch({ ...input, now: "2026-07-31T00:15:00.000Z" })).breaches,
    ).toEqual([]);
    const ackLate = analyzeReviewDispatch({ ...input, now: "2026-07-31T00:16:00.000Z" });
    expect(entry(ackLate).breaches).toEqual([]);
    expect(ackLate.ok).toBe(true);
    expect(
      entry(analyzeReviewDispatch({ ...input, now: "2026-07-31T00:30:00.000Z" })).breaches,
    ).toEqual([]);
    expect(
      entry(analyzeReviewDispatch({ ...input, now: "2026-07-31T00:31:00.000Z" })).breaches,
    ).toEqual([]);
    expect(
      entry(analyzeReviewDispatch({ ...input, now: "2026-07-31T01:00:00.000Z" })).breaches,
    ).toEqual([]);
    expect(
      entry(analyzeReviewDispatch({ ...input, now: "2026-07-31T01:01:00.000Z" })).breaches,
    ).toEqual(["verdict"]);
  });

  it("U-RVDISP-003: acknowledged receipt は状態だけを進め、未開始SLAを発生させない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("acknowledged")],
      prs: [pr()],
      now: "2026-07-31T00:31:00.000Z",
    });

    expect(entry(result).state).toBe("acknowledged");
    expect(entry(result).breaches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-004: in_review から PASS verdict へ遷移する", () => {
    const reviewing = analyzeReviewDispatch({
      requests: [request()],
      receipts: [
        receipt("acknowledged", { at: "2026-07-31T00:01:00.000Z" }),
        receipt("in_review", { at: "2026-07-31T00:02:00.000Z" }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(reviewing).state).toBe("in_review");

    const verdict = analyzeReviewDispatch({
      requests: [request()],
      receipts: completeSequence(),
      prs: [pr({ checksGreen: false })],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(verdict).state).toBe("verdict");
  });

  it("U-RVDISP-005: merge_ready は PASS・HEAD 一致・green・OPEN の全条件を要する", () => {
    const base = {
      requests: [request()],
      receipts: completeSequence(),
      now: "2026-07-31T00:10:00.000Z",
    };

    expect(entry(analyzeReviewDispatch({ ...base, prs: [pr()] })).state).toBe("merge_ready");
    expect(
      entry(analyzeReviewDispatch({ ...base, prs: [pr({ checksGreen: false })] })).state,
    ).not.toBe("merge_ready");
    expect(
      entry(analyzeReviewDispatch({ ...base, prs: [pr({ state: "MERGED" })] })).state,
    ).not.toBe("merge_ready");
    const stale = analyzeReviewDispatch({
      ...base,
      prs: [pr({ headSha: "b".repeat(40) })],
    });
    expect(entry(stale).state).toBe("stale_head");
    expect(stale.ok).toBe(true);
  });

  it("U-RVDISP-006: PASS-WEAK は merge_ready 対象、FLAG は blocking を残す", () => {
    const base = { requests: [request()], prs: [pr()], now: "2026-07-31T00:10:00.000Z" };

    expect(
      entry(
        analyzeReviewDispatch({
          ...base,
          receipts: completeSequence().map((item) =>
            item.kind === "verdict" ? { ...item, verdict: "PASS-WEAK" } : item,
          ),
        }),
      ).state,
    ).toBe("merge_ready");

    const flagged = analyzeReviewDispatch({
      ...base,
      receipts: [
        ...completeSequence().slice(0, 2),
        receipt("verdict", {
          verdict: "FLAG",
          blockingFindings: ["missing independent reviewer"],
          at: "2026-07-31T00:03:00.000Z",
        }),
      ],
    });
    expect(entry(flagged).state).toBe("verdict");
    expect(entry(flagged).blocking).toEqual(["missing independent reviewer"]);
    expect(flagged.ok).toBe(false);
  });

  it("U-RVDISP-007: 同一 family の自己承認 verdict は採用しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ authorFamily: "claude" })],
      receipts: [
        receipt("acknowledged", { reviewerFamily: "claude" }),
        receipt("in_review", { reviewerFamily: "claude" }),
        receipt("verdict", { reviewerFamily: "claude", verdict: "PASS" }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("requested");
    expect(entry(result).reasons).toContain("same_family_reviewer");
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-008: current PR の exact HEAD 不一致は stale_head として採用しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: completeSequence(),
      prs: [pr({ headSha: "b".repeat(40) })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("stale_head");
    expect(entry(result).progressDiagnostics).toContain("request_superseded");
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-009: verdict 無しで MERGED された PR を手順違反として検出する", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr({ state: "MERGED" })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).reasons).toContain("merged_without_verdict");
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-010: 重複 request を畳み込み、entries を入力順に依存せず整列する", () => {
    const requests = [
      request({ memoryId: "memory-b", pr: 20, exactHead: "b".repeat(40) }),
      request({ memoryId: "memory-a", pr: 10, exactHead: "c".repeat(40) }),
      request({ memoryId: "memory-a", pr: 10, exactHead: "a".repeat(40) }),
      request({ memoryId: "memory-a", pr: 10, exactHead: "c".repeat(40) }),
    ];
    const input = {
      receipts: [],
      prs: [],
      now: "2026-07-31T00:10:00.000Z",
    };

    const forward = analyzeReviewDispatch({ ...input, requests });
    const reversed = analyzeReviewDispatch({ ...input, requests: [...requests].reverse() });
    expect(forward.entries).toHaveLength(3);
    expect(forward.entries.map((item: ReviewDispatchEntry) => [item.pr, item.exactHead])).toEqual([
      [10, "a".repeat(40)],
      [10, "c".repeat(40)],
      [20, "b".repeat(40)],
    ]);
    expect(JSON.stringify(forward.entries)).toBe(JSON.stringify(reversed.entries));
  });

  it("U-RVDISP-011: SLA は注入で上書きでき、既定契約は verdict 60 分", () => {
    expect(DEFAULT_REVIEW_DISPATCH_SLA).toEqual({
      verdictMinutes: 60,
    });

    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T00:04:00.000Z",
      sla: { verdictMinutes: 3 },
    });
    expect(entry(result).breaches).toEqual(["verdict"]);
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-012: 対応 request の無い孤児 receipt は状態を作らない", () => {
    const result = analyzeReviewDispatch({
      requests: [],
      receipts: [receipt("verdict", { verdict: "PASS" })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(result.entries).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-013: identity は PR を含み、同じ memory/head の別 PR を分離する", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ pr: 201 }), request({ pr: 202 })],
      receipts: completeSequence(),
      prs: [pr({ pr: 201 }), pr({ pr: 202 })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((item) => [item.pr, item.state])).toEqual([
      [201, "merge_ready"],
      [202, "requested"],
    ]);
  });

  it("U-RVDISP-014: reviewRevision が異なる receipt は相互適用しない", () => {
    const result = analyzeReviewDispatch({
      requests: [
        request({ reviewRevision: "revision-001" }),
        request({ reviewRevision: "revision-002" }),
      ],
      receipts: completeSequence(),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((item) => [item.reviewRevision, item.state])).toEqual([
      ["revision-001", "merge_ready"],
      ["revision-002", "requested"],
    ]);
  });

  it("U-RVDISP-015: old HEAD の receipt は new request を汚染しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ exactHead: "b".repeat(40), reviewRevision: "revision-002" })],
      receipts: completeSequence({ head: "a".repeat(40), reviewRevision: "revision-001" }),
      prs: [pr({ headSha: "b".repeat(40) })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("requested");
    expect(entry(result).reasons).not.toContain("head_mismatch");
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-016: missing ack/start は診断するが有効verdictを妨げない", () => {
    const missingAck = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("in_review"), receipt("verdict", { verdict: "PASS" })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(missingAck).state).toBe("merge_ready");
    expect(entry(missingAck).progressDiagnostics).toEqual(["missing_acknowledged"]);
    expect(missingAck.ok).toBe(true);

    const reversed = analyzeReviewDispatch({
      requests: [request()],
      receipts: [
        receipt("acknowledged", { at: "2026-07-31T00:03:00.000Z" }),
        receipt("in_review", { at: "2026-07-31T00:02:00.000Z" }),
        receipt("verdict", { at: "2026-07-31T00:04:00.000Z", verdict: "PASS" }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(reversed).state).toBe("merge_ready");
    expect(reversed.ok).toBe(true);
  });

  it("U-RVDISP-017: malformed timestamp/head/SLA/receipt fields は fail closed", () => {
    const malformedTimestamp = analyzeReviewDispatch({
      requests: [request({ requestedAt: "not-a-date" })],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(malformedTimestamp).reasons).toContain("invalid_timestamp");
    expect(malformedTimestamp.ok).toBe(false);

    const futureTimestamp = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("acknowledged", { at: "2026-07-31T00:11:00.000Z" })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(futureTimestamp).reasons).toContain("future_timestamp");
    expect(futureTimestamp.ok).toBe(false);

    const malformedReceipt = analyzeReviewDispatch({
      requests: [request({ memoryId: "", reviewRevision: "" })],
      receipts: [receipt("verdict", { verdict: "PASS", head: "not-a-head" })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
      sla: { verdictMinutes: 0 },
    });
    expect(entry(malformedReceipt).reasons).toEqual(
      expect.arrayContaining(["empty_identity", "empty_review_revision", "invalid_sla"]),
    );
    expect(malformedReceipt.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining("orphan_receipt:invalid_head:")]),
    );
    expect(malformedReceipt.ok).toBe(false);

    const invalidVerdictFields = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("acknowledged", { verdict: "PASS" })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(invalidVerdictFields).reasons).toContain("unexpected_verdict_fields");
    expect(invalidVerdictFields.ok).toBe(false);

    const missingVerdict = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("verdict")],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(missingVerdict).reasons).toContain("missing_verdict");
    expect(missingVerdict.ok).toBe(false);

    const invalidFlag = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("verdict", { verdict: "FLAG" })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(invalidFlag).reasons).toContain("flag_without_blocking_findings");
    expect(invalidFlag.ok).toBe(false);

    const invalidPass = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("verdict", { verdict: "PASS", blockingFindings: ["unexpected"] })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(invalidPass).reasons).toContain("blocking_findings_on_pass");
    expect(invalidPass.ok).toBe(false);
  });

  it("U-RVDISP-018: author family進捗は診断、verdictだけを承認から拒否する", () => {
    for (const kind of ["acknowledged", "in_review", "verdict"] as const) {
      const receipts = completeSequence().map((item) =>
        item.kind === kind ? { ...item, reviewerFamily: "claude" as const } : item,
      );
      const result = analyzeReviewDispatch({
        requests: [request({ authorFamily: "claude" })],
        receipts,
        prs: [pr()],
        now: "2026-07-31T00:10:00.000Z",
      });

      if (kind === "verdict") {
        expect(entry(result).reasons).toContain("same_family_reviewer");
        expect(entry(result).state).not.toBe("merge_ready");
        expect(result.ok).toBe(false);
      } else {
        expect(entry(result).progressDiagnostics).toContain("same_family_progress_receipt");
        expect(entry(result).state).toBe("merge_ready");
        expect(result.ok).toBe(true);
      }
    }
  });

  it("U-RVDISP-019: valid cross-family verdict は単独でもmerge_readyになる", () => {
    const cases: Array<{ receipts: ReviewReceipt[]; state: string }> = [
      { receipts: [receipt("acknowledged")], state: "acknowledged" },
      { receipts: completeSequence().slice(0, 2), state: "in_review" },
      { receipts: [receipt("verdict", { verdict: "PASS" })], state: "merge_ready" },
      { receipts: completeSequence(), state: "merge_ready" },
    ];

    for (const item of cases) {
      const result = analyzeReviewDispatch({
        requests: [request()],
        receipts: item.receipts,
        prs: [pr()],
        now: "2026-07-31T00:10:00.000Z",
      });
      expect(entry(result).state).toBe(item.state);
    }
  });

  it("U-RVDISP-020: identical receipt replay は冪等、同一 stage の矛盾は fail closed", () => {
    const sequence = completeSequence();
    const replayed = analyzeReviewDispatch({
      requests: [request()],
      receipts: [...sequence, ...sequence],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(replayed).state).toBe("merge_ready");
    expect(entry(replayed).reasons).toEqual([]);
    expect(replayed.ok).toBe(true);

    const conflicting = analyzeReviewDispatch({
      requests: [request()],
      receipts: [...sequence, receipt("acknowledged", { at: "2026-07-31T00:01:30.000Z" })],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(conflicting).reasons).toContain("duplicate_receipt_conflict");
    expect(entry(conflicting).state).not.toBe("merge_ready");
    expect(conflicting.ok).toBe(false);
  });

  it("U-RVDISP-021: identical request replay は冪等、同一 identity の矛盾は fail closed", () => {
    const duplicated = analyzeReviewDispatch({
      requests: [request(), request()],
      receipts: completeSequence(),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(duplicated.entries).toHaveLength(1);
    expect(entry(duplicated).state).toBe("merge_ready");
    expect(duplicated.ok).toBe(true);

    const replayedWithNewTimestamp = analyzeReviewDispatch({
      requests: [request(), request({ requestedAt: "2026-07-31T00:00:30.000Z" })],
      receipts: completeSequence(),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(replayedWithNewTimestamp.entries).toHaveLength(1);
    expect(entry(replayedWithNewTimestamp).state).toBe("merge_ready");
    expect(entry(replayedWithNewTimestamp).reasons).not.toContain("duplicate_request_conflict");
    expect(replayedWithNewTimestamp.ok).toBe(true);

    const conflicting = analyzeReviewDispatch({
      requests: [request(), request({ authorFamily: "codex" })],
      receipts: completeSequence(),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(conflicting.entries).toHaveLength(1);
    expect(entry(conflicting).reasons).toContain("duplicate_request_conflict");
    expect(entry(conflicting).state).not.toBe("merge_ready");
    expect(conflicting.ok).toBe(false);

    const earliestRequest = analyzeReviewDispatch({
      requests: [
        request({ requestedAt: "2026-07-31T00:30:00.000+01:00" }),
        request({ requestedAt: "2026-07-31T00:00:00.000Z" }),
      ],
      receipts: completeSequence(),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(earliestRequest).state).toBe("merge_ready");
    expect(entry(earliestRequest).ageMinutes).toBe(40);
    expect(earliestRequest.ok).toBe(true);

    const invalidTimestampReplay = analyzeReviewDispatch({
      requests: [request(), request({ requestedAt: "not-a-date" })],
      receipts: completeSequence(),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(invalidTimestampReplay).reasons).toContain("duplicate_request_conflict");
    expect(entry(invalidTimestampReplay).reasons).toContain("invalid_timestamp");
    expect(entry(invalidTimestampReplay).state).not.toBe("merge_ready");
    expect(invalidTimestampReplay.ok).toBe(false);

    const futureTimestampReplay = analyzeReviewDispatch({
      requests: [request(), request({ requestedAt: "2026-07-31T00:11:00.000Z" })],
      receipts: completeSequence(),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(entry(futureTimestampReplay).reasons).toContain("duplicate_request_conflict");
    expect(entry(futureTimestampReplay).state).not.toBe("merge_ready");
    expect(futureTimestampReplay.ok).toBe(false);
  });

  it("U-RVDISP-022: old HEAD receipt は reviewRevision が同じでも new request を汚染しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ exactHead: "b".repeat(40) })],
      receipts: completeSequence({ head: "a".repeat(40) }),
      prs: [pr({ headSha: "b".repeat(40) })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("requested");
    expect(entry(result).reasons).not.toContain("head_mismatch");
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-023: PR observation 欠落は retry が必要な未確定状態として fail closed", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: completeSequence(),
      prs: [],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("verdict");
    expect(entry(result).reasons).toContain("pr_observation_missing");
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-024: validation reason がある entry は merge_ready を名乗らない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [
        ...completeSequence(),
        receipt("acknowledged", { at: "2026-07-31T00:01:30.000Z" }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).reasons.length).toBeGreaterThan(0);
    expect(entry(result).state).not.toBe("merge_ready");
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-025: unrelated malformed artifact は正常 request を汚染せず診断へ分離する", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [
        ...completeSequence(),
        receipt("acknowledged", {
          memoryId: "orphan-memory",
          pr: 999,
          head: "not-a-head",
        }),
      ],
      prs: [pr(), pr({ pr: 999, headSha: "not-a-head" })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("merge_ready");
    expect(entry(result).reasons).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("orphan_receipt:invalid_head:"),
        expect.stringContaining("orphan_pr_observation:invalid_pr_observation:"),
      ]),
    );
  });

  it("U-RVDISP-026: matching malformed artifact は対応 request だけを fail closed にする", () => {
    const result = analyzeReviewDispatch({
      requests: [request(), request({ memoryId: "memory-002", pr: 202 })],
      receipts: [
        ...completeSequence(),
        receipt("acknowledged", { at: "not-a-date" }),
        ...completeSequence({ memoryId: "memory-002", pr: 202 }),
      ],
      prs: [pr(), pr({ pr: 202 })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].reasons).toContain("invalid_timestamp");
    expect(result.entries[0].state).not.toBe("merge_ready");
    expect(result.entries[1].state).toBe("merge_ready");
    expect(result.entries[1].reasons).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-027: conflicting PR observations は stale snapshot を優先せず fail closed", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: completeSequence(),
      prs: [pr(), pr({ headSha: "b".repeat(40) })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).reasons).toContain("duplicate_pr_observation_conflict");
    expect(entry(result).state).not.toBe("merge_ready");
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-028: identical PR observation replay は冪等", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: completeSequence(),
      prs: [pr(), pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("merge_ready");
    expect(entry(result).reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-029: receiptの時刻順は終端verdictの受理を妨げない", () => {
    const at = "2026-07-31T00:01:00.000Z";
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: completeSequence({ at }),
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("merge_ready");
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-030: uppercase HEAD は canonical identity として受理しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ exactHead: "A".repeat(40) })],
      receipts: [],
      prs: [],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).reasons).toContain("invalid_head");
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-031: well-formed orphan と exact HEAD 別reasonを診断で失わない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ exactHead: "a".repeat(40) }), request({ exactHead: "b".repeat(40) })],
      receipts: [
        receipt("acknowledged", {
          memoryId: "orphan-memory",
          pr: 999,
          reviewRevision: "orphan-revision",
        }),
      ],
      prs: [pr(), pr({ headSha: "b".repeat(40) }), pr({ pr: 999 })],
      now: "2026-07-31T01:01:00.000Z",
    });
    const messages = reviewDispatchMessages(result);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("orphan_receipt:unmatched_identity:"),
        expect.stringContaining("orphan_pr_observation:unmatched_pr:"),
      ]),
    );
    const slaMessages = messages.filter((message) => message.includes("SLA超過"));
    expect(slaMessages).toHaveLength(2);
    expect(new Set(slaMessages)).toHaveLength(2);
    expect(slaMessages.some((message) => message.includes("a".repeat(40)))).toBe(true);
    expect(slaMessages.some((message) => message.includes("b".repeat(40)))).toBe(true);
  });

  it("U-RVDISP-034: exact identityの非author PASS verdict単独でmerge_readyになる", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("verdict", { verdict: "PASS" })],
      prs: [pr()],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(entry(result).state).toBe("merge_ready");
    expect(entry(result).breaches).toEqual([]);
    expect(entry(result).reasons).toEqual([]);
    expect(entry(result).progressDiagnostics).toEqual([
      "missing_acknowledged",
      "missing_in_review",
    ]);
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-035: FLAG verdict単独はblockingを保持し未応答breachを出さない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [
        receipt("verdict", {
          verdict: "FLAG",
          blockingFindings: ["contract mismatch"],
        }),
      ],
      prs: [pr()],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(entry(result).state).toBe("verdict");
    expect(entry(result).blocking).toEqual(["contract mismatch"]);
    expect(entry(result).breaches).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-036: same-familyまたはold HEADのPASSは終端証拠にならない", () => {
    const sameFamily = analyzeReviewDispatch({
      requests: [request()],
      receipts: [receipt("verdict", { reviewerFamily: "claude", verdict: "PASS" })],
      prs: [pr()],
      now: "2026-07-31T01:01:00.000Z",
    });
    expect(entry(sameFamily).state).not.toBe("merge_ready");
    expect(entry(sameFamily).breaches).toEqual(["verdict"]);

    const oldHead = analyzeReviewDispatch({
      requests: [request({ exactHead: "b".repeat(40), reviewRevision: "revision-002" })],
      receipts: [receipt("verdict", { verdict: "PASS" })],
      prs: [pr({ headSha: "b".repeat(40) })],
      now: "2026-07-31T01:01:00.000Z",
    });
    expect(entry(oldHead).state).not.toBe("merge_ready");
    expect(entry(oldHead).breaches).toEqual(["verdict"]);
  });

  it("U-RVDISP-037: old HEAD ackはcurrent HEAD PASSを妨げない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ exactHead: "b".repeat(40), reviewRevision: "revision-002" })],
      receipts: [
        receipt("acknowledged"),
        receipt("verdict", {
          head: "b".repeat(40),
          reviewRevision: "revision-002",
          verdict: "PASS",
        }),
      ],
      prs: [pr({ headSha: "b".repeat(40) })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("merge_ready");
    expect(entry(result).breaches).toEqual([]);
  });

  it("U-RVDISP-038: 61分無verdictはverdict breachだけを返す", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr()],
      now: "2026-07-31T01:01:00.000Z",
    });
    expect(entry(result).breaches).toEqual(["verdict"]);
  });

  it("U-RVDISP-039: malformed・request以前・identity不一致verdictは61分時点で未応答", () => {
    const cases: ReviewReceipt[][] = [
      [receipt("verdict")],
      [receipt("verdict", { verdict: "PASS", at: "2026-07-30T23:59:00.000Z" })],
      [receipt("verdict", { verdict: "PASS", reviewRevision: "other-revision" })],
    ];
    for (const receipts of cases) {
      const result = analyzeReviewDispatch({
        requests: [request()],
        receipts,
        prs: [pr()],
        now: "2026-07-31T01:01:00.000Z",
      });
      expect(entry(result).state).not.toBe("merge_ready");
      expect(entry(result).breaches).toEqual(["verdict"]);
    }
  });

  it("U-RVDISP-040: invalid/future request timestampはageをnullにしfail-closeする", () => {
    for (const requestedAt of ["invalid", "2026-07-31T00:11:00.000Z"]) {
      const result = analyzeReviewDispatch({
        requests: [request({ requestedAt })],
        receipts: [receipt("verdict", { verdict: "PASS" })],
        prs: [pr()],
        now: "2026-07-31T00:10:00.000Z",
      });
      expect(entry(result).ageMinutes).toBeNull();
      expect(entry(result).state).not.toBe("merge_ready");
      expect(result.ok).toBe(false);
    }
  });

  it("U-RVDISP-041: request時刻が不正ならreceipt_before_requestを判定不能として受理しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ requestedAt: "invalid" })],
      receipts: [receipt("verdict", { verdict: "PASS" })],
      prs: [pr()],
      now: "2026-07-31T01:01:00.000Z",
    });
    expect(entry(result).state).not.toBe("merge_ready");
    expect(entry(result).breaches).toEqual(["verdict"]);
  });

  it("U-RVDISP-042: receiptsとprsのshuffleで結果は不変", () => {
    const receipts = completeSequence();
    const prs = [pr(), pr()];
    const base = analyzeReviewDispatch({
      requests: [request()],
      receipts,
      prs,
      now: "2026-07-31T00:10:00.000Z",
    });
    const shuffled = analyzeReviewDispatch({
      requests: [request()],
      receipts: [...receipts].reverse(),
      prs: [...prs].reverse(),
      now: "2026-07-31T00:10:00.000Z",
    });
    expect(shuffled).toEqual(base);
  });

  it("U-RVDISP-043: stale HEAD requestはsuperseded終端としてSLAと全体okを汚染しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr({ headSha: "b".repeat(40) })],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(entry(result).state).toBe("stale_head");
    expect(entry(result).breaches).toEqual([]);
    expect(entry(result).reasons).toEqual([]);
    expect(entry(result).progressDiagnostics).toContain("request_superseded");
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-044: unmerged CLOSED requestはcancel終端としてbreachを出さない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr({ state: "CLOSED" })],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(entry(result).breaches).toEqual([]);
    expect(entry(result).reasons).toEqual([]);
    expect(entry(result).progressDiagnostics).toContain("review_request_closed");
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-045: request無しMERGED observationはokをfail-closeする", () => {
    const result = analyzeReviewDispatch({
      requests: [],
      receipts: [],
      prs: [pr({ state: "MERGED" })],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toContain(
      `orphan_pr_observation:merged_without_request:201@${"a".repeat(40)}`,
    );
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-046: verdict無しMERGEDは手順違反だが未応答SLAを継続しない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr({ state: "MERGED" })],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(entry(result).breaches).toEqual([]);
    expect(entry(result).reasons).toContain("merged_without_verdict");
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-047: current HEAD verdict付きMERGEDはold requestを恒久redにしない", () => {
    const currentHead = "b".repeat(40);
    const result = analyzeReviewDispatch({
      requests: [
        request(),
        request({
          memoryId: "memory-002",
          exactHead: currentHead,
          reviewRevision: "revision-002",
        }),
      ],
      receipts: [
        receipt("verdict", {
          memoryId: "memory-002",
          head: currentHead,
          reviewRevision: "revision-002",
          verdict: "PASS",
        }),
      ],
      prs: [pr({ headSha: currentHead, state: "MERGED" })],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(result.entries.map((item) => [item.exactHead, item.state, item.reasons])).toEqual([
      ["a".repeat(40), "stale_head", []],
      [currentHead, "verdict", []],
    ]);
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-048: merge先HEADのrequestが無ければold requestがあってもfail-closeする", () => {
    const currentHead = "b".repeat(40);
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [],
      prs: [pr({ headSha: currentHead, state: "MERGED" })],
      now: "2026-07-31T01:01:00.000Z",
    });

    expect(entry(result).state).toBe("stale_head");
    expect(entry(result).reasons).toEqual([]);
    expect(result.diagnostics).toContain(
      `orphan_pr_observation:merged_head_without_request:201@${currentHead}`,
    );
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-049: author family receipt は cross-family verdict を握り潰さない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ authorFamily: "claude" })],
      receipts: [
        receipt("acknowledged", {
          reviewerFamily: "claude",
          at: "2026-07-31T00:01:00.000Z",
        }),
        receipt("acknowledged", {
          reviewerFamily: "codex",
          at: "2026-07-31T00:02:00.000Z",
        }),
        receipt("verdict", {
          reviewerFamily: "claude",
          verdict: "PASS",
          at: "2026-07-31T00:03:00.000Z",
        }),
        receipt("verdict", {
          reviewerFamily: "codex",
          verdict: "PASS",
          at: "2026-07-31T00:04:00.000Z",
        }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).state).toBe("merge_ready");
    expect(entry(result).reasons).not.toContain("same_family_reviewer");
    expect(entry(result).reasons).not.toContain("duplicate_receipt_conflict");
    expect(entry(result).progressDiagnostics).toContain("same_family_progress_receipt");
    expect(entry(result).progressDiagnostics).toContain("same_family_verdict_ignored");
    expect(entry(result).breaches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("U-RVDISP-050: request無しの不正MERGED observation は fail closed", () => {
    const result = analyzeReviewDispatch({
      requests: [],
      receipts: [],
      prs: [pr({ pr: 999, headSha: "not-a-head", state: "MERGED" })],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(result.diagnostics).toEqual([
      "orphan_pr_observation:invalid_merged_observation:999@not-a-head",
    ]);
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-051: 先行PASSと後発FLAGの競合ではblocking findingを失わない", () => {
    const result = analyzeReviewDispatch({
      requests: [request()],
      receipts: [
        receipt("verdict", {
          verdict: "PASS",
          at: "2026-07-31T00:03:00.000Z",
        }),
        receipt("verdict", {
          verdict: "FLAG",
          blockingFindings: ["late safety finding"],
          at: "2026-07-31T00:04:00.000Z",
        }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).reasons).toEqual(
      expect.arrayContaining(["duplicate_receipt_conflict", "flagged"]),
    );
    expect(entry(result).blocking).toEqual(["late safety finding"]);
    expect(entry(result).state).not.toBe("merge_ready");
    expect(
      reviewDispatchMessages(result).some((message) => message.includes("late safety finding")),
    ).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("U-RVDISP-052: request以前の同kind receiptは有効な後続receiptを隠さない", () => {
    const result = analyzeReviewDispatch({
      requests: [request({ requestedAt: "2026-07-31T00:02:00.000Z" })],
      receipts: [
        receipt("verdict", {
          verdict: "PASS",
          at: "2026-07-31T00:01:00.000Z",
        }),
        receipt("verdict", {
          verdict: "PASS",
          at: "2026-07-31T00:03:00.000Z",
        }),
      ],
      prs: [pr()],
      now: "2026-07-31T00:10:00.000Z",
    });

    expect(entry(result).reasons).toContain("receipt_before_request");
    expect(entry(result).reasons).not.toContain("duplicate_receipt_conflict");
    expect(entry(result).state).toBe("verdict");
    expect(entry(result).breaches).toEqual([]);
  });
});
