import { createHash } from "node:crypto";
import { checkCrossAgentModelPair } from "../schema/index.ts";

export const REQUIRED_GITHUB_CHECK = "harness-check";

export interface ReviewReceiptSource {
  planId: string;
  planRevision: string;
  headSha: string;
  reviewKind: string;
  verdict: string;
  reviewedAt: string;
  testsGreenAt: string;
  workerModel: string;
  reviewerModel: string;
  source: string;
  lane: "claim-blind" | "spec-blind";
  attackTrials: number;
  citations: string[];
}

export interface MergeClosureReceipt {
  version: 1;
  status: "verified";
  planId: string;
  planRevision: string;
  prNumber: string;
  headSha: string;
  mergeSha: string;
  requiredCheck: typeof REQUIRED_GITHUB_CHECK;
  prCheckId: string;
  mainCheckId: string;
  reviewReceiptDigests: {
    claimBlind: string;
    specBlind: string;
  };
  issueClosed: boolean;
  receiptDigest: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function reviewReceiptDigest(source: ReviewReceiptSource): string {
  return digest(source);
}

export function combinedReviewReceiptDigest(digests: {
  claimBlind: string;
  specBlind: string;
}): string {
  return digest(digests);
}

export function validCrossReviewSource(source: ReviewReceiptSource): boolean {
  const testsGreenAt = Date.parse(source.testsGreenAt);
  const reviewedAt = Date.parse(source.reviewedAt);
  return (
    source.reviewKind === "cross_agent" &&
    ["claim-blind", "spec-blind"].includes(source.lane) &&
    ["PASS", "PASS-WEAK"].includes(source.verdict.trim().toUpperCase()) &&
    Boolean(source.headSha && source.workerModel && source.reviewerModel && source.source) &&
    checkCrossAgentModelPair(source.workerModel, source.reviewerModel).ok &&
    Number.isFinite(testsGreenAt) &&
    Number.isFinite(reviewedAt) &&
    testsGreenAt <= reviewedAt &&
    Number.isInteger(source.attackTrials) &&
    source.attackTrials >= (source.verdict.trim().toUpperCase() === "PASS-WEAK" ? 3 : 1) &&
    source.citations.length > 0
  );
}

export function encodeMergeClosureReceipt(
  receipt: Omit<MergeClosureReceipt, "receiptDigest">,
): string {
  return JSON.stringify({ ...receipt, receiptDigest: digest(receipt) });
}

export function decodeMergeClosureReceipt(value: string): MergeClosureReceipt | undefined {
  try {
    const parsed = JSON.parse(value) as MergeClosureReceipt;
    const { receiptDigest: actual, ...unsigned } = parsed;
    if (
      parsed.version !== 1 ||
      parsed.status !== "verified" ||
      parsed.requiredCheck !== REQUIRED_GITHUB_CHECK ||
      !parsed.planId ||
      !parsed.planRevision ||
      !parsed.prNumber ||
      !parsed.headSha ||
      !/^[0-9a-f]{7,40}$/i.test(parsed.mergeSha) ||
      !parsed.prCheckId ||
      !parsed.mainCheckId ||
      !/^[0-9a-f]{64}$/i.test(parsed.reviewReceiptDigests?.claimBlind ?? "") ||
      !/^[0-9a-f]{64}$/i.test(parsed.reviewReceiptDigests?.specBlind ?? "") ||
      parsed.issueClosed !== true ||
      actual !== digest(unsigned)
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
