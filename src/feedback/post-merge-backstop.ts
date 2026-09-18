import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeReviewDispatch,
  type PrObservation,
  type ReviewReceipt,
  type ReviewRequest,
} from "./review-dispatch.ts";
import type { MergeExecutionReceipt } from "./review-merge-gate.ts";

/** `git log -1 --format=%cI $(git merge-base HEAD origin/main)` の UTC 値。 */
export const D2D_CUTOFF_BASELINE = "2026-08-14T01:20:05.000Z";
export const MAX_MERGED_PR_PAGES = 50;
export const MERGED_PR_PAGE_SIZE = 100;
export const POST_MERGE_COMMAND_TIMEOUT_MS = 10_000;
export const POST_MERGE_GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type PostMergeBackstopReason = "bypass_merge" | "merged_without_verdict";

export interface MergedPullRequest {
  pr: number;
  headSha: string;
  mergeCommitSha: string;
  mergedAt: string;
}

export interface PostMergeBackstopFinding extends MergedPullRequest {
  reason: PostMergeBackstopReason;
}

export interface PostMergeBackstopResult {
  ok: boolean;
  detections: PostMergeBackstopFinding[];
  pagesScanned: number;
  unavailableReason?: string;
}

export interface PostMergeBackstopDependencies {
  repoRoot?: string;
  now?: string;
  fetchMergedPrPage?: (page: number, perPage: number) => unknown;
  execFileSync?: typeof execFileSync;
}

type JsonRecord = Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function isPr(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isAuthorizedEntry(value: unknown): value is MergeExecutionReceipt["authorizedEntry"] {
  return (
    isRecord(value) &&
    typeof value.memoryId === "string" &&
    value.memoryId.length > 0 &&
    typeof value.reviewRevision === "string" &&
    value.reviewRevision.length > 0 &&
    (value.reviewerFamily === "claude" || value.reviewerFamily === "codex")
  );
}

function parseSuccessfulMergeReceipt(value: unknown): MergeExecutionReceipt | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.receiptKind !== "merge_result" ||
    value.decision !== "merge" ||
    value.reason !== "merge_ready" ||
    !isPr(value.pr) ||
    !isSha(value.headSha) ||
    (value.verdict !== "PASS" && value.verdict !== "PASS-WEAK") ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    !isAuthorizedEntry(value.authorizedEntry)
  ) {
    return undefined;
  }
  return value as unknown as MergeExecutionReceipt;
}

function parseMergedPullRequest(value: unknown): MergedPullRequest | null | undefined {
  if (!isRecord(value)) return undefined;
  const pr = value.number;
  const mergedAt = Object.hasOwn(value, "merged_at") ? value.merged_at : value.mergedAt;
  if (mergedAt === null) return null;
  const mergeCommitSha = Object.hasOwn(value, "merge_commit_sha")
    ? value.merge_commit_sha
    : value.mergeCommitSha;
  const headValue = isRecord(value.head) ? value.head.sha : value.headSha;
  if (!isPr(pr) || typeof mergedAt !== "string" || !Number.isFinite(Date.parse(mergedAt))) {
    return undefined;
  }
  if (!isSha(mergeCommitSha) || !isSha(headValue)) return undefined;
  return {
    pr,
    headSha: headValue.toLowerCase(),
    mergeCommitSha: mergeCommitSha.toLowerCase(),
    mergedAt: new Date(mergedAt).toISOString(),
  };
}

function repositorySlug(repoRoot: string, run: typeof execFileSync): string {
  const remote = String(
    run("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: POST_MERGE_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }),
  ).trim();
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error("origin remote is not a GitHub repository");
  return `${match[1]}/${match[2]}`;
}

function defaultFetchMergedPrPage(
  repoRoot: string,
  run: typeof execFileSync,
): (page: number, perPage: number) => unknown {
  const slug = repositorySlug(repoRoot, run);
  return (page, perPage) => {
    const endpoint =
      `repos/${slug}/pulls?state=closed&base=main&sort=created&direction=asc` +
      `&per_page=${perPage}&page=${page}`;
    const output = run("gh", ["api", endpoint], {
      encoding: "utf8",
      timeout: POST_MERGE_COMMAND_TIMEOUT_MS,
      maxBuffer: POST_MERGE_GH_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return JSON.parse(String(output));
  };
}

function readJsonFiles<T>(repoRoot: string, category: "requests" | "receipts"): T[] {
  const directory = join(repoRoot, ".ut-tdd", "review", category);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as T);
}

function readReviewInputs(repoRoot: string): {
  requests: ReviewRequest[];
  receipts: ReviewReceipt[];
} {
  return {
    requests: readJsonFiles<ReviewRequest>(repoRoot, "requests"),
    receipts: readJsonFiles<ReviewReceipt>(repoRoot, "receipts"),
  };
}

function readMergeReceipts(repoRoot: string): MergeExecutionReceipt[] {
  const path = join(repoRoot, ".ut-tdd", "logs", "review-merge-gate.jsonl");
  if (!existsSync(path)) return [];
  const receipts: MergeExecutionReceipt[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const receipt = parseSuccessfulMergeReceipt(JSON.parse(line));
      if (receipt) receipts.push(receipt);
    } catch {
      // A malformed receipt cannot prove wrapper custody; it is not a reason to hide a bypass.
    }
  }
  return receipts;
}

function unavailable(
  detections: PostMergeBackstopFinding[],
  pagesScanned: number,
  reason: string,
): PostMergeBackstopResult {
  return { ok: false, detections, pagesScanned, unavailableReason: reason };
}

function hasWrapperReceipt(pr: MergedPullRequest, receipts: MergeExecutionReceipt[]): boolean {
  return receipts.some(
    (receipt) =>
      receipt.pr === pr.pr &&
      typeof receipt.headSha === "string" &&
      receipt.headSha.toLowerCase() === pr.headSha,
  );
}

function hasMergedWithoutVerdict(
  pr: MergedPullRequest,
  inputs: { requests: ReviewRequest[]; receipts: ReviewReceipt[] },
  now: string,
): boolean {
  const observation: PrObservation = {
    pr: pr.pr,
    headSha: pr.headSha,
    state: "MERGED",
    checksGreen: true,
  };
  const result = analyzeReviewDispatch({
    requests: inputs.requests,
    receipts: inputs.receipts,
    prs: [observation],
    now,
  });
  return result.entries.some(
    (entry) =>
      entry.pr === pr.pr &&
      entry.exactHead === pr.headSha &&
      entry.reasons.includes("merged_without_verdict"),
  );
}

function parsePage(value: unknown): unknown[] | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(value) ? value : undefined;
}

function detectionKey(finding: PostMergeBackstopFinding): string {
  return `${finding.reason}:${finding.pr}:${finding.headSha}`;
}

export function scanPostMergeBackstop(
  dependencies: PostMergeBackstopDependencies = {},
): PostMergeBackstopResult {
  const repoRoot = dependencies.repoRoot ?? process.cwd();
  const run = dependencies.execFileSync ?? execFileSync;
  const detections = new Map<string, PostMergeBackstopFinding>();
  const seenPages = new Set<string>();
  let fetchPage: (page: number, perPage: number) => unknown;
  let inputs: { requests: ReviewRequest[]; receipts: ReviewReceipt[] };
  let mergeReceipts: MergeExecutionReceipt[];
  try {
    fetchPage = dependencies.fetchMergedPrPage ?? defaultFetchMergedPrPage(repoRoot, run);
    inputs = readReviewInputs(repoRoot);
    mergeReceipts = readMergeReceipts(repoRoot);
  } catch (error) {
    return unavailable([], 0, `setup_failed:${errorMessage(error)}`);
  }
  const now = dependencies.now ?? new Date().toISOString();

  for (let page = 1; page <= MAX_MERGED_PR_PAGES; page += 1) {
    let rawPage: unknown;
    try {
      rawPage = fetchPage(page, MERGED_PR_PAGE_SIZE);
    } catch (error) {
      return unavailable(
        [...detections.values()].sort(compareFindings),
        page - 1,
        `page_${page}_fetch_failed:${errorMessage(error)}`,
      );
    }
    let signature: string | undefined;
    try {
      signature = JSON.stringify(rawPage);
    } catch (error) {
      return unavailable(
        [...detections.values()].sort(compareFindings),
        page - 1,
        `page_${page}_malformed:${errorMessage(error)}`,
      );
    }
    if (signature == null) {
      return unavailable(
        [...detections.values()].sort(compareFindings),
        page - 1,
        `page_${page}_malformed:unserializable_response`,
      );
    }
    if (seenPages.has(signature)) {
      return unavailable(
        [...detections.values()].sort(compareFindings),
        page - 1,
        `pagination_repeated_page:${page}`,
      );
    }
    seenPages.add(signature);

    const pageItems = parsePage(rawPage);
    if (!pageItems) {
      return unavailable(
        [...detections.values()].sort(compareFindings),
        page - 1,
        `page_${page}_malformed:expected_array`,
      );
    }
    if (pageItems.length === 0) {
      return {
        ok: true,
        detections: [...detections.values()].sort(compareFindings),
        pagesScanned: page,
      };
    }
    for (const item of pageItems) {
      const merged = parseMergedPullRequest(item);
      if (merged === null) continue;
      if (!merged) {
        return unavailable(
          [...detections.values()].sort(compareFindings),
          page,
          `page_${page}_malformed:required_field_missing_or_invalid`,
        );
      }
      if (Date.parse(merged.mergedAt) < Date.parse(D2D_CUTOFF_BASELINE)) continue;
      if (!hasWrapperReceipt(merged, mergeReceipts)) {
        const finding: PostMergeBackstopFinding = { ...merged, reason: "bypass_merge" };
        detections.set(detectionKey(finding), finding);
      }
      let mergedWithoutVerdict: boolean;
      try {
        mergedWithoutVerdict = hasMergedWithoutVerdict(merged, inputs, now);
      } catch (error) {
        return unavailable(
          [...detections.values()].sort(compareFindings),
          page,
          `page_${page}_d1_analysis_failed:${errorMessage(error)}`,
        );
      }
      if (mergedWithoutVerdict) {
        const finding: PostMergeBackstopFinding = {
          ...merged,
          reason: "merged_without_verdict",
        };
        detections.set(detectionKey(finding), finding);
      }
    }
    if (pageItems.length < MERGED_PR_PAGE_SIZE) {
      return {
        ok: true,
        detections: [...detections.values()].sort(compareFindings),
        pagesScanned: page,
      };
    }
    if (page === MAX_MERGED_PR_PAGES) {
      return unavailable(
        [...detections.values()].sort(compareFindings),
        page,
        `pagination_max_pages_reached:${MAX_MERGED_PR_PAGES}`,
      );
    }
  }
  return unavailable(
    [...detections.values()].sort(compareFindings),
    MAX_MERGED_PR_PAGES,
    `pagination_max_pages_reached:${MAX_MERGED_PR_PAGES}`,
  );
}

function compareFindings(left: PostMergeBackstopFinding, right: PostMergeBackstopFinding): number {
  return left.pr - right.pr || left.reason.localeCompare(right.reason);
}

function formatPrs(findings: PostMergeBackstopFinding[], reason: PostMergeBackstopReason): string {
  const prs = findings.filter((finding) => finding.reason === reason).map((finding) => finding.pr);
  return prs.length > 0
    ? `count=${prs.length} PRs=${prs.map((pr) => `#${pr}`).join(",")}`
    : "count=0";
}

export function formatPostMergeBackstop(result: PostMergeBackstopResult): string {
  const summary = [
    formatPrs(result.detections, "bypass_merge"),
    formatPrs(result.detections, "merged_without_verdict"),
  ];
  if (!result.ok) {
    return `post-merge backstop: detection unavailable (${result.unavailableReason ?? "unknown"}); ${summary.join("; ")}`;
  }
  return `post-merge backstop: bypass_merge ${summary[0]}; merged_without_verdict ${summary[1]}`;
}
