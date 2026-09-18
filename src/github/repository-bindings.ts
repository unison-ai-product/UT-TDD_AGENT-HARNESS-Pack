import {
  combinedReviewReceiptDigest,
  encodeMergeClosureReceipt,
  REQUIRED_GITHUB_CHECK,
} from "../kernel/github-closure-receipt.ts";
import { stableId } from "../stable-id.ts";
import {
  type GithubBindingInput,
  recordGithubBinding,
} from "../state-db/github-forward-projection.ts";
import {
  canonicalPlanRevision,
  verifiedReviewLaneDigests,
} from "../state-db/github-review-lane-provenance.ts";
import type { HarnessDb } from "../state-db/index.ts";
import { runSqliteTransaction } from "../state-db/sqlite-transaction.ts";
import { validatePrTraceBody } from "./pr-trace.ts";
import type { GhCommandPort } from "./project-v2.ts";
import { NodeGhCommandPort } from "./project-v2.ts";

export interface RepositoryBindingSyncResult {
  inspectedPullRequests: number;
  tracedPullRequests: number;
  skipped: Array<{ number: string; reason: string }>;
  bindingIds: string[];
}

const ACCEPTED_PLAN_STATUSES = new Set([
  "confirmed",
  "completed",
  "accepted",
  "merged",
  "closed",
  "documented",
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function ciState(checks: unknown[]): NonNullable<GithubBindingInput["state"]> {
  if (checks.length === 0) return "未実行";
  const states = checks.map((value) => {
    const check = object(value);
    return text(check.conclusion || check.state || check.status).toUpperCase();
  });
  if (
    states.some((state) =>
      ["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(state),
    )
  )
    return "失敗";
  if (states.some((state) => ["CANCELLED", "CANCELED", "SKIPPED"].includes(state))) return "取消";
  if (states.every((state) => ["SUCCESS", "NEUTRAL"].includes(state))) return "成功";
  return "実行中";
}

function requiredCheck(checks: unknown[]): { state: string; id: string } {
  const matches = checks
    .map(object)
    .filter((check) => text(check.name || check.context).toLowerCase() === REQUIRED_GITHUB_CHECK);
  if (matches.length !== 1) return { state: "未実行", id: "" };
  const check = matches[0] ?? {};
  const state = text(check.conclusion || check.state || check.status).toUpperCase();
  return {
    state: state === "SUCCESS" ? "成功" : state === "NEUTRAL" ? "失敗" : ciState(matches),
    id: text(check.databaseId || check.id || check.node_id || check.url),
  };
}

function reviewState(reviews: unknown[]): NonNullable<GithubBindingInput["state"]> {
  const states = reviews.map((value) => text(object(value).state).toUpperCase());
  if (states.includes("CHANGES_REQUESTED")) return "要修正";
  if (states.includes("APPROVED")) return "承認";
  return states.length > 0 ? "依頼中" : "未依頼";
}

function projectItemId(input: {
  db: HarnessDb;
  repositoryId: string;
  planId: string;
  revision: string;
}): string | undefined {
  const row = input.db
    .prepare(
      `SELECT project_item_id FROM github_project_item_projection
        WHERE repository_id = ? AND plan_id = ? AND plan_revision = ?`,
    )
    .get(input.repositoryId, input.planId, input.revision);
  return text(row?.project_item_id);
}

export function resolveCurrentPlanRevision(db: HarnessDb, planId: string): string {
  const row = db
    .prepare(
      `SELECT plan_revision
         FROM schedule_entries
        WHERE plan_id = ? AND NULLIF(plan_revision, '') IS NOT NULL
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(planId);
  return text(row?.plan_revision);
}

function planAccepted(db: HarnessDb, planId: string): boolean {
  const row = db
    .prepare("SELECT status FROM schedule_entries WHERE plan_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(planId);
  return ACCEPTED_PLAN_STATUSES.has(text(row?.status));
}

function recordMergeClosure(input: {
  db: HarnessDb;
  repositoryId: string;
  planId: string;
  planRevision: string;
  projectItemId: string;
  prNumber: string;
  objectUrl: string;
  headSha: string;
  mergeSha: string;
  state: string;
  observedAt?: string;
}): string | undefined {
  const objectId = `pr:${input.prNumber}:merge:${input.mergeSha}`;
  const existing = input.db
    .prepare(
      `SELECT plan_id, plan_revision FROM github_object_bindings
        WHERE repository_id = ? AND object_kind = 'merge' AND object_id = ?`,
    )
    .get(input.repositoryId, objectId);
  if (existing && text(existing.plan_id) !== input.planId)
    throw new Error(`GitHub merge identity conflict: ${objectId}`);
  const bindingId = stableId("github-binding", `${input.repositoryId}:merge:${objectId}`);
  input.db
    .prepare(
      `INSERT INTO github_object_bindings (
         binding_id, repository_id, plan_id, plan_revision, project_item_id,
         object_kind, object_id, object_url, head_sha, state, observed_at
       ) VALUES (?, ?, ?, ?, ?, 'merge', ?, ?, ?, ?, ?)
       ON CONFLICT(repository_id, object_kind, object_id) DO UPDATE SET
         plan_id=excluded.plan_id, plan_revision=excluded.plan_revision,
         project_item_id=excluded.project_item_id, object_url=excluded.object_url,
         head_sha=excluded.head_sha, state=excluded.state, observed_at=excluded.observed_at
       WHERE excluded.observed_at >= github_object_bindings.observed_at`,
    )
    .run(
      bindingId,
      input.repositoryId,
      input.planId,
      input.planRevision,
      input.projectItemId,
      objectId,
      input.objectUrl,
      input.headSha,
      input.state,
      input.observedAt ?? new Date().toISOString(),
    );
  const changes = input.db.prepare("SELECT changes() AS count").get();
  return Number(changes?.count ?? 0) > 0 ? bindingId : undefined;
}

export function syncRepositoryBindings(input: {
  db: HarnessDb;
  repositoryId: string;
  gh?: GhCommandPort;
  now?: string;
  repoRoot?: string;
}): RepositoryBindingSyncResult {
  const gh = input.gh ?? new NodeGhCommandPort();
  const payload = gh.json([
    "pr",
    "list",
    "--repo",
    input.repositoryId,
    "--state",
    "all",
    "--limit",
    "1000",
    "--json",
    "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,mergeCommit,body,statusCheckRollup,reviews",
  ]);
  const pullRequests = list(payload);
  if (pullRequests.length >= 1000)
    throw new Error("GitHub PR listing may be truncated at the provider limit (1000)");
  const result: RepositoryBindingSyncResult = {
    inspectedPullRequests: pullRequests.length,
    tracedPullRequests: 0,
    skipped: [],
    bindingIds: [],
  };
  const pendingWrites: Array<() => string | undefined> = [];
  for (const value of pullRequests) {
    const pullRequest = object(value);
    const number = text(pullRequest.number);
    const body = text(pullRequest.body);
    const trace = validatePrTraceBody(body);
    const planId = trace.ok ? (trace.fields.plan_id ?? "") : "";
    if (!planId) {
      result.skipped.push({ number, reason: trace.findings[0]?.code ?? "plan-id-unresolved" });
      continue;
    }
    const revision = trace.fields.plan_revision ?? "";
    if (!revision) {
      result.skipped.push({ number, reason: "plan-revision-missing" });
      continue;
    }
    const expectedRevision = resolveCurrentPlanRevision(input.db, planId);
    const sourceRevision = canonicalPlanRevision(input.repoRoot ?? process.cwd(), planId);
    if (!expectedRevision) {
      result.skipped.push({ number, reason: "plan-projection-unavailable" });
      continue;
    }
    if (!sourceRevision) {
      result.skipped.push({ number, reason: "plan-source-unavailable" });
      continue;
    }
    if (sourceRevision !== expectedRevision) {
      result.skipped.push({ number, reason: "stale-plan-projection" });
      continue;
    }
    if (revision !== expectedRevision) {
      result.skipped.push({ number, reason: "stale-plan-revision" });
      continue;
    }
    const headSha = text(pullRequest.headRefOid) || trace.fields.subject_head || "";
    if (trace.ok && trace.fields.subject_head && headSha !== trace.fields.subject_head) {
      result.skipped.push({ number, reason: "subject-head-mismatch" });
      continue;
    }
    let baseComparison: Record<string, unknown>;
    try {
      baseComparison = object(
        gh.json([
          "api",
          `repos/${input.repositoryId}/compare/${trace.fields.base_sha}...${headSha}`,
        ]),
      );
    } catch {
      result.skipped.push({ number, reason: "base-sha-unverified" });
      continue;
    }
    if (!["ahead", "identical"].includes(text(baseComparison.status).toLowerCase())) {
      result.skipped.push({ number, reason: "base-sha-unverified" });
      continue;
    }
    const common = {
      repositoryId: input.repositoryId,
      planId,
      planRevision: revision,
      projectItemId: projectItemId({
        db: input.db,
        repositoryId: input.repositoryId,
        planId,
        revision,
      }),
      headSha,
      observedAt: input.now,
    };
    const prRequiredCheck = requiredCheck(list(pullRequest.statusCheckRollup));
    const remoteReviewState = reviewState(list(pullRequest.reviews));
    const reviewDigests = verifiedReviewLaneDigests(input.db, {
      repoRoot: input.repoRoot ?? process.cwd(),
      planId,
      planRevision: revision,
      headSha,
    });
    const expectedReviewDigest = reviewDigests ? combinedReviewReceiptDigest(reviewDigests) : "";
    const reviewReceiptMatches =
      Boolean(trace.fields.review_receipt_digest) &&
      trace.fields.review_receipt_digest === expectedReviewDigest;
    const acceptedReviewState = reviewReceiptMatches
      ? "承認"
      : remoteReviewState === "要修正"
        ? "要修正"
        : "依頼中";
    const bindings: GithubBindingInput[] = [
      {
        ...common,
        objectKind: "branch",
        objectId: text(pullRequest.headRefName),
        state: text(pullRequest.state).toLowerCase(),
      },
      {
        ...common,
        objectKind: "pull_request",
        objectId: number,
        objectUrl: text(pullRequest.url),
        state: text(pullRequest.state).toLowerCase(),
      },
      {
        ...common,
        objectKind: "check_run",
        objectId: `pr:${number}:check:${prRequiredCheck.id || "missing"}`,
        state: prRequiredCheck.state,
      },
      {
        ...common,
        objectKind: "review",
        objectId: `pr:${number}:reviews:${headSha}`,
        state: acceptedReviewState,
      },
    ];
    if (trace.fields.issue_number) {
      bindings.push({
        ...common,
        objectKind: "issue",
        objectId: trace.fields.issue_number,
        objectUrl: `https://github.com/${input.repositoryId}/issues/${trace.fields.issue_number}`,
        state: "linked",
      });
    }
    if (pullRequest.mergedAt) {
      const mergeSha = text(object(pullRequest.mergeCommit).oid);
      const mergesToMain = text(pullRequest.baseRefName) === "main";
      const mainChecks =
        mergeSha && mergesToMain
          ? object(gh.json(["api", `repos/${input.repositoryId}/commits/${mergeSha}/check-runs`]))
          : {};
      const mainRequiredCheck = requiredCheck(list(mainChecks.check_runs));
      if (mergesToMain)
        bindings.push({
          ...common,
          objectKind: "check_run",
          objectId: `main:${mergeSha}:check:${mainRequiredCheck.id || "missing"}`,
          state: mainRequiredCheck.state,
        });
      const issueClosed = trace.fields.issue_number
        ? text(
            object(
              gh.json([
                "issue",
                "view",
                trace.fields.issue_number,
                "--repo",
                input.repositoryId,
                "--json",
                "state",
              ]),
            ).state,
          ).toUpperCase() === "CLOSED"
        : false;
      if (!common.projectItemId) {
        result.skipped.push({ number, reason: "project-item-required" });
      } else if (
        reviewDigests &&
        mergeSha &&
        mergesToMain &&
        prRequiredCheck.state === "成功" &&
        prRequiredCheck.id &&
        mainRequiredCheck.state === "成功" &&
        mainRequiredCheck.id &&
        reviewReceiptMatches &&
        issueClosed &&
        planAccepted(input.db, planId)
      ) {
        const closure = {
          db: input.db,
          ...common,
          projectItemId: common.projectItemId,
          prNumber: number,
          objectUrl: text(pullRequest.url),
          mergeSha,
          state: encodeMergeClosureReceipt({
            version: 1,
            status: "verified",
            planId,
            planRevision: revision,
            prNumber: number,
            headSha,
            mergeSha,
            requiredCheck: REQUIRED_GITHUB_CHECK,
            prCheckId: prRequiredCheck.id,
            mainCheckId: mainRequiredCheck.id,
            reviewReceiptDigests: reviewDigests,
            issueClosed,
          }),
        };
        pendingWrites.push(() => recordMergeClosure(closure));
      } else {
        if (mergeSha) {
          const closure = {
            db: input.db,
            ...common,
            projectItemId: common.projectItemId ?? "",
            prNumber: number,
            objectUrl: text(pullRequest.url),
            mergeSha,
            state: "invalidated:closure-incomplete",
          };
          pendingWrites.push(() => recordMergeClosure(closure));
        }
        result.skipped.push({ number, reason: "merge-closure-incomplete" });
      }
    }
    for (const binding of bindings) {
      if (!binding.objectId) continue;
      pendingWrites.push(() => recordGithubBinding(input.db, binding));
    }
    result.tracedPullRequests += 1;
  }
  runSqliteTransaction(input.db, () => {
    for (const write of pendingWrites) {
      const bindingId = write();
      if (bindingId) result.bindingIds.push(bindingId);
    }
  });
  return result;
}
