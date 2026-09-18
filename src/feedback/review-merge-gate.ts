import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveRepositoryRoot } from "./repository-root.ts";
import {
  analyzeReviewDispatch,
  type PrObservation,
  type ReviewDispatchEntry,
  type ReviewReceipt,
  type ReviewRequest,
  type ReviewVerdict,
} from "./review-dispatch.ts";
import { canonicalJson } from "./review-verdict-custody.ts";

export interface MergeGateFacts extends PrObservation {
  /** 評価対象として取得した HEAD。adapter 内の二重観測がずれたら fail-close する。 */
  evaluatedHeadSha: string;
}

export interface GhPrMergePorts {
  getPullRequest: (pr: number) => MergeGateFacts;
  mergePullRequest: (pr: number, headSha: string) => void;
}

export interface AuthorizedReviewEntry {
  memoryId: string;
  reviewRevision: string;
  reviewerFamily: "claude" | "codex";
}

export interface MergeGateDecision {
  ok: boolean;
  pr: number;
  headSha: string | null;
  verdict: ReviewVerdict | null;
  state: string | null;
  reasons: string[];
  authorizedEntry: AuthorizedReviewEntry | null;
}

export interface MergeExecutionReceipt {
  receiptKind: "merge_result";
  pr: number;
  headSha: string | null;
  verdict: ReviewVerdict | null;
  decision: "merge" | "deny" | "merge_failed";
  reason: string;
  timestamp: string;
  authorizedEntry: AuthorizedReviewEntry | null;
}

interface MergeIntentReceipt {
  receiptKind: "merge_intent";
  pr: number;
  headSha: string;
  verdict: ReviewVerdict;
  decision: "merge";
  reason: "merge_ready";
  timestamp: string;
  authorizedEntry: AuthorizedReviewEntry;
}

type MergeReceipt = MergeExecutionReceipt | MergeIntentReceipt;

export interface PrMergeResult {
  ok: boolean;
  pr: number;
  headSha: string | null;
  verdict: ReviewVerdict | null;
  decision: MergeExecutionReceipt["decision"];
  reason: string;
  receiptPath: string | null;
}

const REVIEW_LOG_PATH = join(".ut-tdd", "logs", "review-merge-gate.jsonl");
const REVIEW_INPUT_CATEGORIES = ["requests", "receipts"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Review requests/receipts are runtime evidence, not worktree-local source.
 * A linked worktree may receive the request while the merge command runs from
 * another linked worktree, so the gate must inspect every worktree belonging
 * to the same Git common directory. Non-Git fixture roots retain the old
 * single-root behavior.
 */
function reviewInputRoots(repoRoot: string): string[] {
  // Callers normalize the Git root at the public boundary before loading
  // linked-worktree evidence. Keeping this helper single-purpose prevents a
  // second idempotent root resolution from masquerading as a separate guard.
  const roots = new Map<string, string>();
  const add = (candidate: string): void => {
    if (!existsSync(candidate)) return;
    const resolved = resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!roots.has(key)) roots.set(key, resolved);
  };
  add(repoRoot);
  // Vitest uses non-Git temporary roots for isolated fixtures. A real
  // checkout must not silently fall back to a worktree-local evidence set if
  // Git cannot enumerate its linked worktrees.
  if (!existsSync(join(repoRoot, ".git"))) return [...roots.values()];
  try {
    const output = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of String(output).split(/\r?\n/)) {
      if (line.startsWith("worktree ")) add(line.slice("worktree ".length));
    }
  } catch {
    throw new Error("review_input_worktree_enumeration_failed");
  }
  return [...roots.values()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function readReviewFiles<T>(
  roots: readonly string[],
  category: (typeof REVIEW_INPUT_CATEGORIES)[number],
): T[] {
  const values = new Map<string, T>();
  for (const root of roots) {
    const directory = join(root, ".ut-tdd", "review", category);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()) {
      const value = JSON.parse(readFileSync(join(directory, name), "utf8")) as T;
      values.set(canonicalJson(value), value);
    }
  }
  return [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

function loadReviewInputs(repoRoot: string): {
  requests: ReviewRequest[];
  receipts: ReviewReceipt[];
} {
  const roots = reviewInputRoots(repoRoot);
  return {
    requests: readReviewFiles<ReviewRequest>(roots, "requests"),
    receipts: readReviewFiles<ReviewReceipt>(roots, "receipts"),
  };
}

/**
 * D2-B の一次防壁。D1 の `merge_ready` 以外はすべて deny とする。
 * `headSha` は最初の gh 観測値、`evaluatedHeadSha` は判定直前の第二観測値であり、
 * 観測間の HEAD 差替えを fail-close する。
 */
export function evaluateMergeGate(input: {
  pr: number;
  requests: ReviewRequest[];
  receipts: ReviewReceipt[];
  facts: MergeGateFacts;
  now: string;
}): MergeGateDecision {
  const headSha = input.facts.headSha;
  if (input.facts.pr !== input.pr) {
    return {
      ok: false,
      pr: input.pr,
      headSha,
      verdict: null,
      state: null,
      reasons: ["pr_mismatch"],
      authorizedEntry: null,
    };
  }
  if (headSha !== input.facts.evaluatedHeadSha) {
    return {
      ok: false,
      pr: input.pr,
      headSha,
      verdict: null,
      state: "breach",
      reasons: ["head_mismatch"],
      authorizedEntry: null,
    };
  }

  const result = analyzeReviewDispatch({
    requests: input.requests.filter((request) => request.pr === input.pr),
    receipts: input.receipts.filter((receipt) => receipt.pr === input.pr),
    prs: [input.facts],
    now: input.now,
  });
  const entriesForHead = result.entries.filter(
    (candidate) => candidate.pr === input.pr && candidate.exactHead === headSha,
  );
  const entry = entriesForHead[0];
  const denyingEntries = entriesForHead.filter(
    (candidate) => candidate.state !== "merge_ready" || candidate.verdict === "FLAG",
  );
  const denyingEntry = denyingEntries.length === 1 ? denyingEntries[0] : undefined;
  const authorizedEntryFrom = (
    candidate: ReviewDispatchEntry | undefined,
  ): AuthorizedReviewEntry | null =>
    candidate?.reviewerFamily
      ? {
          memoryId: candidate.memoryId,
          reviewRevision: candidate.reviewRevision,
          reviewerFamily: candidate.reviewerFamily,
        }
      : null;
  // D1 の result/diagnostics は監査用に全履歴を保持する。D2-B は exact current HEAD の
  // typed entryに加え、identity形式が異なるorphan receipt / PR observationだけを投影する。
  const receiptIdentity = `@${input.pr}@${headSha}@`;
  const observationIdentity = `:${input.pr}@${headSha}`;
  const reasons = result.diagnostics.filter(
    (diagnostic) =>
      diagnostic.includes(receiptIdentity) || diagnostic.endsWith(observationIdentity),
  );
  if (entriesForHead.length === 0) {
    reasons.push("no_request_for_current_head");
    return {
      ok: false,
      pr: input.pr,
      headSha,
      verdict: null,
      state: "breach",
      reasons,
      authorizedEntry: null,
    };
  }
  if (entriesForHead.some((candidate) => candidate.verdict == null)) {
    reasons.push("pending_request_for_head");
  }
  for (const candidate of entriesForHead) {
    if (candidate.verdict == null) reasons.push("verdict_missing");
    reasons.push(
      ...candidate.reasons,
      ...candidate.blocking.map((finding) => `blocking_finding:${finding}`),
    );
    if (candidate.state !== "merge_ready") reasons.push(`state:${candidate.state}`);
  }
  const denied =
    reasons.length > 0 || entriesForHead.some((candidate) => candidate.state !== "merge_ready");
  const authorizedEntry = denied ? authorizedEntryFrom(denyingEntry) : authorizedEntryFrom(entry);
  const verdict = denied ? (denyingEntry?.verdict ?? null) : (entry?.verdict ?? null);
  if (denied) {
    return {
      ok: false,
      pr: input.pr,
      headSha,
      verdict,
      state: entry.state,
      reasons: [...new Set(reasons)].sort(),
      authorizedEntry,
    };
  }
  return {
    ok: true,
    pr: input.pr,
    headSha,
    verdict,
    state: entry.state,
    reasons: [],
    authorizedEntry,
  };
}

function writeReceipt(repoRoot: string, receipt: MergeReceipt): string {
  const directory = join(repoRoot, ".ut-tdd", "logs");
  mkdirSync(directory, { recursive: true });
  const path = join(repoRoot, REVIEW_LOG_PATH);
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf8");
  return path;
}

function makeResult(input: {
  result: Omit<PrMergeResult, "receiptPath">;
  repoRoot: string;
  timestamp: string;
  authorizedEntry?: AuthorizedReviewEntry | null;
}): PrMergeResult {
  const { result, repoRoot, timestamp, authorizedEntry = null } = input;
  const receipt: MergeExecutionReceipt = {
    receiptKind: "merge_result",
    pr: result.pr,
    headSha: result.headSha,
    verdict: result.verdict,
    decision: result.decision,
    reason: result.reason,
    timestamp,
    authorizedEntry,
  };
  try {
    const receiptPath = writeReceipt(repoRoot, receipt);
    return { ...result, receiptPath };
  } catch (error) {
    const reason = `result_receipt_write_failed:${errorMessage(error)}`;
    process.stderr.write(`review merge: ${reason}\n`);
    return { ...result, ok: false, reason: `${result.reason},${reason}`, receiptPath: null };
  }
}

export function runPrMerge(input: {
  repoRoot: string;
  pr: number;
  ports: GhPrMergePorts;
  now?: () => string;
}): PrMergeResult {
  const timestamp = input.now?.() ?? new Date().toISOString();
  let repoRoot = input.repoRoot;
  try {
    repoRoot = resolveRepositoryRoot(input.repoRoot);
  } catch (error) {
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: null,
        verdict: null,
        decision: "deny",
        reason: `review_input_failed:${errorMessage(error)}`,
      },
      repoRoot: input.repoRoot,
      timestamp,
    });
  }
  if (!Number.isInteger(input.pr) || input.pr <= 0) {
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: null,
        verdict: null,
        decision: "deny",
        reason: "invalid_pr",
      },
      repoRoot,
      timestamp,
    });
  }

  let facts: MergeGateFacts;
  try {
    facts = input.ports.getPullRequest(input.pr);
  } catch (error) {
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: null,
        verdict: null,
        decision: "deny",
        reason: `gh_fetch_failed:${errorMessage(error)}`,
      },
      repoRoot,
      timestamp,
    });
  }

  let decision: MergeGateDecision;
  try {
    const reviewInputs = loadReviewInputs(repoRoot);
    decision = evaluateMergeGate({ ...reviewInputs, pr: input.pr, facts, now: timestamp });
  } catch (error) {
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: facts.headSha,
        verdict: null,
        decision: "deny",
        reason: `review_input_failed:${errorMessage(error)}`,
      },
      repoRoot,
      timestamp,
    });
  }
  if (!decision.ok) {
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: decision.headSha,
        verdict: decision.verdict,
        decision: "deny",
        reason: decision.reasons.join(",") || "merge_not_ready",
      },
      repoRoot,
      timestamp,
      authorizedEntry: decision.authorizedEntry,
    });
  }

  if (decision.headSha === null || decision.verdict === null || decision.authorizedEntry === null) {
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: decision.headSha,
        verdict: decision.verdict,
        decision: "deny",
        reason: "merge_authorization_incomplete",
      },
      repoRoot,
      timestamp,
    });
  }

  try {
    writeReceipt(repoRoot, {
      receiptKind: "merge_intent",
      pr: input.pr,
      headSha: decision.headSha,
      verdict: decision.verdict,
      decision: "merge",
      reason: "merge_ready",
      timestamp,
      authorizedEntry: decision.authorizedEntry,
    });
  } catch (error) {
    const reason = `intent_receipt_write_failed:${errorMessage(error)}`;
    process.stderr.write(`review merge: ${reason}\n`);
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: decision.headSha,
        verdict: decision.verdict,
        decision: "deny",
        reason,
      },
      repoRoot,
      timestamp,
    });
  }

  try {
    input.ports.mergePullRequest(input.pr, decision.headSha);
  } catch (error) {
    return makeResult({
      result: {
        ok: false,
        pr: input.pr,
        headSha: decision.headSha,
        verdict: decision.verdict,
        decision: "merge_failed",
        reason: `gh_merge_failed:${errorMessage(error)}`,
      },
      repoRoot,
      timestamp,
      authorizedEntry: decision.authorizedEntry,
    });
  }
  return makeResult({
    result: {
      ok: true,
      pr: input.pr,
      headSha: decision.headSha,
      verdict: decision.verdict,
      decision: "merge",
      reason: "merge_ready",
    },
    repoRoot,
    timestamp,
    authorizedEntry: decision.authorizedEntry,
  });
}

interface GhPrView {
  headRefOid?: unknown;
  state?: unknown;
  statusCheckRollup?: unknown;
}

type ExecFileSync = typeof execFileSync;

function readGhView(pr: number, runGh: ExecFileSync): Omit<MergeGateFacts, "evaluatedHeadSha"> {
  const raw = runGh(
    "gh",
    ["pr", "view", String(pr), "--json", "headRefOid,state,statusCheckRollup"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(raw) as GhPrView;
  if (
    typeof parsed.headRefOid !== "string" ||
    !["OPEN", "MERGED", "CLOSED"].includes(parsed.state as string) ||
    !Array.isArray(parsed.statusCheckRollup)
  ) {
    throw new Error("gh PR facts invalid");
  }
  const checksGreen =
    parsed.statusCheckRollup.length > 0 &&
    parsed.statusCheckRollup.every(
      (check) =>
        check !== null &&
        typeof check === "object" &&
        (check as { conclusion?: unknown }).conclusion === "SUCCESS",
    );
  const headSha = parsed.headRefOid;
  const state = parsed.state as MergeGateFacts["state"];
  return { pr, headSha, state, checksGreen };
}

function readGhFacts(pr: number, runGh: ExecFileSync = execFileSync): MergeGateFacts {
  const observed = readGhView(pr, runGh);
  const evaluated = readGhView(pr, runGh);
  return {
    ...observed,
    state: evaluated.state,
    checksGreen: evaluated.checksGreen,
    evaluatedHeadSha: evaluated.headSha,
  };
}

export function createGhPrMergePorts(
  dependencies: { execFileSync?: ExecFileSync } = {},
): GhPrMergePorts {
  const runGh = dependencies.execFileSync ?? execFileSync;
  return {
    getPullRequest: (pr) => readGhFacts(pr, runGh),
    mergePullRequest: (pr, headSha) => {
      runGh("gh", ["pr", "merge", String(pr), "--merge", "--match-head-commit", headSha], {
        stdio: "inherit",
      });
    },
  };
}

export const reviewMergeReceiptPath = REVIEW_LOG_PATH;
