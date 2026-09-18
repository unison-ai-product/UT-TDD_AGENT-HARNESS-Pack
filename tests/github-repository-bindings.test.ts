import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrTraceBlock } from "../src/github/pr-trace.ts";
import type { GhCommandPort } from "../src/github/project-v2.ts";
import {
  resolveCurrentPlanRevision,
  syncRepositoryBindings,
} from "../src/github/repository-bindings.ts";
import {
  combinedReviewReceiptDigest,
  decodeMergeClosureReceipt,
  reviewReceiptDigest,
} from "../src/kernel/github-closure-receipt.ts";
import { canonicalPlanContentDigest } from "../src/plan-admission/diff-fence.ts";
import {
  TRACKED_RECEIPT_SCHEMA,
  trackedReceiptRecordDigest,
} from "../src/plan-admission/tracked-receipt-projection.ts";
import {
  isManualGithubObservationKind,
  readForwardSchedule,
} from "../src/state-db/github-forward-projection.ts";
import { resolvePlanRevisionIdentity } from "../src/state-db/github-review-lane-provenance.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";

class FakeGh implements GhCommandPort {
  readonly #payloads: unknown[];
  onJson?: () => void;
  compareStatus = "ahead";
  constructor(...payloads: unknown[]) {
    this.#payloads = payloads;
  }
  json(args: readonly string[] = []): unknown {
    this.onJson?.();
    if (args[0] === "api" && args[1]?.includes("/compare/")) {
      if (this.compareStatus === "error") throw new Error("compare failed");
      return { status: this.compareStatus };
    }
    return this.#payloads.shift() ?? {};
  }
  run(): void {
    throw new Error("unexpected mutation");
  }
}

function writeReviewPlan(
  repoRoot: string,
  sources: Array<{
    planId: string;
    planRevision: string;
    headSha: string;
    reviewKind: string;
    verdict: string;
    reviewedAt: string;
    testsGreenAt: string;
    workerModel: string;
    reviewerModel: string;
    lane: string;
    attackTrials: number;
    citations: string[];
  }>,
): void {
  const [first] = sources;
  if (!first) return;
  const plansDir = join(repoRoot, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const entries = sources
    .map(
      (source) => `  - reviewer: blind-reviewer
    review_kind: ${source.reviewKind}
    reviewed_at: ${source.reviewedAt}
    tests_green_at: ${source.testsGreenAt}
    verdict: ${source.verdict}
    worker_model: ${source.workerModel}
    reviewer_model: ${source.reviewerModel}
    lane: ${source.lane}
    plan_revision: ${source.planRevision}
    subject_head: ${source.headSha}
    attack_trials: ${source.attackTrials}
    citations:
${source.citations.map((citation) => `      - "${citation}"`).join("\n")}`,
    )
    .join("\n");
  const commandId = `command:test:${first.planId}`;
  const receiptId = `certificate:test-${first.planId.toLowerCase()}`;
  const receiptDigest = `sha256:${"a".repeat(64)}`;
  const decisionDigest = `sha256:${"b".repeat(64)}`;
  const planPath = `docs/plans/${first.planId}.md`;
  const render = (contentDigest: string) => `---
plan_id: ${first.planId}
admission_receipt:
  schema_version: v2
  receipt_id: ${receiptId}
  command_id: ${commandId}
  admitted_at: 2026-07-31T00:00:00.000Z
  source_digest: ${contentDigest}
  decision_digest: ${decisionDigest}
  receipt_digest: ${receiptDigest}
  binding:
    path: ${planPath}
    plan_id: ${first.planId}
    asset_id: plan:test-repository-binding
    revision: ${first.planRevision}
    content_digest: ${contentDigest}
  route:
    signal: forward
    mode: forward
review_evidence:
${entries}
---
`;
  const placeholder = `sha256:${"0".repeat(64)}`;
  const contentDigest = canonicalPlanContentDigest(render(placeholder));
  if (!contentDigest) throw new Error("test PLAN digest unavailable");
  writeFileSync(join(plansDir, `${first.planId}.md`), render(contentDigest), "utf8");
  const record = {
    sequence: 1,
    previousRecordDigest: null,
    commandId,
    receiptId,
    receiptDigest,
    decisionDigest,
    binding: {
      path: planPath,
      planId: first.planId,
      assetId: "plan:test-repository-binding",
      revision: Number(first.planRevision),
      contentDigest,
    },
  };
  const projection = {
    schema_version: TRACKED_RECEIPT_SCHEMA,
    records: [
      {
        sequence: record.sequence,
        previous_record_digest: record.previousRecordDigest,
        record_digest: trackedReceiptRecordDigest(record),
        command_id: record.commandId,
        receipt_id: record.receiptId,
        receipt_digest: record.receiptDigest,
        decision_digest: record.decisionDigest,
        binding: {
          path: record.binding.path,
          plan_id: record.binding.planId,
          asset_id: record.binding.assetId,
          revision: record.binding.revision,
          content_digest: record.binding.contentDigest,
        },
      },
    ],
  };
  const governanceDir = join(repoRoot, "docs", "governance");
  mkdirSync(governanceDir, { recursive: true });
  writeFileSync(
    join(governanceDir, "plan-admission-receipts.json"),
    `${JSON.stringify(projection, null, 2)}\n`,
    "utf8",
  );
}

function writeAdmittedTestPlan(repoRoot: string, planId: string, revision: string): void {
  writeReviewPlan(repoRoot, [
    {
      planId,
      planRevision: revision,
      headSha: "abcdef1",
      reviewKind: "cross_agent",
      verdict: "approve",
      reviewedAt: "2026-07-31T00:00:00Z",
      testsGreenAt: "2026-07-31T00:00:00Z",
      workerModel: "gpt-worker",
      reviewerModel: "claude-reviewer",
      lane: "claim-blind",
      attackTrials: 3,
      citations: [`docs/plans/${planId}.md:1`],
    },
  ]);
}

describe("GitHub repository facts binding", () => {
  it("U-GHPROJ-050: rejects a partial admission receipt instead of downgrading it to legacy", () => {
    const partial = `---\nplan_id: PLAN-L7-995-partial\nadmission_receipt:\n  binding:\n    revision: 1\n---\n`;
    expect(resolvePlanRevisionIdentity(partial, "PLAN-L7-995-partial")).toBeUndefined();
  });

  it("U-GHBIND-013: rejects a traced PR when its PLAN projection is unavailable", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-missing-plan-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const result = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: new FakeGh([
          {
            number: 213,
            baseRefName: "main",
            headRefOid: "abcdef1",
            body: renderPrTraceBlock({
              plan_id: "PLAN-L7-997-missing",
              plan_revision: "forged",
              route_mode: "add-feature",
              subject_head: "abcdef1",
              base_sha: "1234567",
              issue_number: "213",
            }),
          },
        ]),
      });
      expect(result.skipped).toEqual([{ number: "213", reason: "plan-projection-unavailable" }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHBIND-014/U-GHBIND-015: requires the canonical legacy PLAN source and exact token", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-legacy-plan-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const planId = "PLAN-L7-996-legacy";
      const source = `---\nplan_id: ${planId}\nlayer: L7\nstatus: active\n---\n\n# Legacy\n`;
      const revision = resolvePlanRevisionIdentity(source, planId)?.token;
      expect(revision).toMatch(/^legacy:sha256:/);
      db.prepare(
        "INSERT INTO schedule_entries (schedule_entry_id, plan_id, status, plan_revision, source_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("schedule:legacy", planId, "active", revision, "whole-source-hash");
      const pr = {
        number: 214,
        url: "https://github.com/owner/repo/pull/214",
        baseRefName: "main",
        headRefName: "feature/legacy",
        headRefOid: "abcdef2",
        state: "OPEN",
        body: renderPrTraceBlock({
          plan_id: planId,
          plan_revision: revision ?? "",
          route_mode: "add-feature",
          subject_head: "abcdef2",
          base_sha: "1234567",
          issue_number: "214",
        }),
        statusCheckRollup: [],
        reviews: [],
      };
      const missing = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: new FakeGh([pr]),
      });
      expect(missing.skipped).toEqual([{ number: "214", reason: "plan-source-unavailable" }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });

      const plansDir = join(repoRoot, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(join(plansDir, `${planId}.md`), source, "utf8");
      const accepted = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: new FakeGh([pr]),
      });
      expect(accepted.tracedPullRequests).toBe(1);
      expect(accepted.skipped).toEqual([]);
      const bindings = db
        .prepare(
          "SELECT object_kind, plan_revision FROM github_object_bindings ORDER BY object_kind",
        )
        .all();
      expect(bindings).toHaveLength(5);
      expect(bindings.every((binding) => binding.plan_revision === revision)).toBe(true);
      expect(bindings.map((binding) => binding.object_kind)).toEqual([
        "branch",
        "check_run",
        "issue",
        "pull_request",
        "review",
      ]);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHBIND-016〜019: verifies trace base SHA as an ancestor in the scoped repository", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-base-custody-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeAdmittedTestPlan(repoRoot, "PLAN-L7-436-domain", "1");
      db.prepare(
        "INSERT INTO schedule_entries (schedule_entry_id, plan_id, status, plan_revision, source_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("schedule:base", "PLAN-L7-436-domain", "active", "1", "source");
      const pullRequest = {
        number: 216,
        url: "https://github.com/owner/repo/pull/216",
        baseRefName: "main",
        headRefName: "feature/base-custody",
        headRefOid: "abcdef1",
        state: "OPEN",
        body: renderPrTraceBlock({
          plan_id: "PLAN-L7-436-domain",
          plan_revision: "1",
          route_mode: "forward",
          subject_head: "abcdef1",
          base_sha: "1234567",
          issue_number: "216",
        }),
        statusCheckRollup: [],
        reviews: [],
      };
      const rejectedGh = new FakeGh([pullRequest]);
      rejectedGh.compareStatus = "diverged";
      const rejected = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: rejectedGh,
      });
      expect(rejected.skipped).toContainEqual({ number: "216", reason: "base-sha-unverified" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });

      const accepted = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: new FakeGh([pullRequest]),
      });
      expect(accepted.skipped).toEqual([]);
      expect(accepted.tracedPullRequests).toBe(1);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHBIND-001/U-GHBIND-010: converges facts and reports only fresh writes", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-review-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO schedule_entries (
          schedule_entry_id, plan_id, status, plan_revision, source_hash
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run("schedule:436", "PLAN-L7-436-domain", "confirmed", "1", "whole-file-hash");
      db.prepare(
        `INSERT INTO github_project_item_projection (
          projection_id, repository_id, project_id, project_item_id, plan_id,
          plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "project:436",
        "owner/repo",
        "project:1",
        "item:436",
        "PLAN-L7-436-domain",
        "1",
        "",
        "abcdef1",
        "同期済",
        "2026-07-29T00:00:00Z",
      );
      const reviewSources = (["claim-blind", "spec-blind"] as const).map((lane) => ({
        planId: "PLAN-L7-436-domain",
        planRevision: "1",
        headSha: "abcdef1",
        reviewKind: "cross_agent",
        verdict: "PASS",
        reviewedAt: "2026-07-29T00:00:00Z",
        testsGreenAt: "2026-07-28T23:00:00Z",
        workerModel: "claude-sonnet-5",
        reviewerModel: "gpt-5.6-sol",
        source: "docs/plans/PLAN-L7-436-domain.md",
        lane,
        attackTrials: 3,
        citations: ["docs/plans/PLAN-L7-436-domain.md:1"],
      }));
      for (const source of reviewSources)
        db.prepare(
          `INSERT INTO github_review_lane_receipts (
            review_lane_receipt_id, plan_id, plan_revision, lane, subject_head,
            verdict, reviewed_at, tests_green_at, worker_model, reviewer_model,
            attack_trials, citations_json, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `review:436:${source.lane}`,
          source.planId,
          source.planRevision,
          source.lane,
          source.headSha,
          source.verdict,
          source.reviewedAt,
          source.testsGreenAt,
          source.workerModel,
          source.reviewerModel,
          source.attackTrials,
          JSON.stringify(source.citations),
          source.source,
        );
      const reviewDigests = {
        claimBlind: reviewReceiptDigest(reviewSources[0]),
        specBlind: reviewReceiptDigest(reviewSources[1]),
      };
      writeReviewPlan(repoRoot, reviewSources);
      const body = renderPrTraceBlock({
        plan_id: "PLAN-L7-436-domain",
        plan_revision: "1",
        route_mode: "add-feature",
        subject_head: "abcdef1",
        base_sha: "1234567",
        issue_number: "70",
        review_receipt_digest: combinedReviewReceiptDigest(reviewDigests),
      });
      const freshGh = (traceBody = body, prConclusion = "SUCCESS", mainConclusion = "SUCCESS") =>
        new FakeGh(
          [
            {
              number: 12,
              url: "https://github.com/owner/repo/pull/12",
              headRefName: "feature/domain",
              headRefOid: "abcdef1",
              state: "MERGED",
              baseRefName: "main",
              mergedAt: "2026-07-29T00:00:00Z",
              mergeCommit: { oid: "fedcba1" },
              body: traceBody,
              statusCheckRollup: [
                { name: "harness-check", databaseId: "pr-check-1", conclusion: prConclusion },
              ],
              reviews: [],
            },
          ],
          {
            check_runs: [{ name: "harness-check", id: "main-check-1", conclusion: mainConclusion }],
          },
          { state: "CLOSED" },
        );
      for (const [prConclusion, mainConclusion] of [
        ["NEUTRAL", "SUCCESS"],
        ["SKIPPED", "SUCCESS"],
        ["SUCCESS", "NEUTRAL"],
        ["SUCCESS", "SKIPPED"],
      ]) {
        syncRepositoryBindings({
          db,
          repositoryId: "owner/repo",
          repoRoot,
          gh: freshGh(body, prConclusion, mainConclusion),
        });
        expect(
          db.prepare("SELECT state FROM github_object_bindings WHERE object_kind = 'merge'").get(),
        ).toEqual({ state: "invalidated:closure-incomplete" });
        db.exec("DELETE FROM github_object_bindings");
      }
      const result = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: freshGh(),
        now: "2026-07-30T00:00:00Z",
      });
      expect(result).toMatchObject({
        inspectedPullRequests: 1,
        tracedPullRequests: 1,
        skipped: [],
      });
      const bindings = db
        .prepare("SELECT object_kind, state FROM github_object_bindings ORDER BY object_kind")
        .all();
      expect(bindings.filter((row) => row.object_kind !== "merge")).toEqual([
        { object_kind: "branch", state: "merged" },
        { object_kind: "check_run", state: "成功" },
        { object_kind: "check_run", state: "成功" },
        { object_kind: "issue", state: "linked" },
        { object_kind: "pull_request", state: "merged" },
        { object_kind: "review", state: "承認" },
      ]);
      expect(
        decodeMergeClosureReceipt(
          String(bindings.find((row) => row.object_kind === "merge")?.state),
        ),
      ).toMatchObject({
        planId: "PLAN-L7-436-domain",
        headSha: "abcdef1",
        mergeSha: "fedcba1",
        requiredCheck: "harness-check",
        prCheckId: "pr-check-1",
        mainCheckId: "main-check-1",
      });
      const staleReplay = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: freshGh(),
        now: "2026-07-29T00:00:00Z",
      });
      expect(staleReplay.bindingIds).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT DISTINCT observed_at FROM github_object_bindings WHERE object_kind <> 'project_item'",
          )
          .all(),
      ).toEqual([{ observed_at: "2026-07-30T00:00:00Z" }]);

      db.prepare("UPDATE schedule_entries SET plan_revision = ? WHERE plan_id = ?").run(
        "2",
        "PLAN-L7-436-domain",
      );
      db.prepare(
        "UPDATE github_project_item_projection SET plan_revision = ? WHERE plan_id = ?",
      ).run("2", "PLAN-L7-436-domain");
      const revisedSources = reviewSources.map((source) => ({
        ...source,
        planRevision: "2",
        reviewedAt: "2026-07-30T01:00:00Z",
        testsGreenAt: "2026-07-30T00:30:00Z",
      }));
      for (const source of revisedSources)
        db.prepare(
          `INSERT INTO github_review_lane_receipts (
            review_lane_receipt_id, plan_id, plan_revision, lane, subject_head,
            verdict, reviewed_at, tests_green_at, worker_model, reviewer_model,
            attack_trials, citations_json, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `review:436:2:${source.lane}`,
          source.planId,
          source.planRevision,
          source.lane,
          source.headSha,
          source.verdict,
          source.reviewedAt,
          source.testsGreenAt,
          source.workerModel,
          source.reviewerModel,
          source.attackTrials,
          JSON.stringify(source.citations),
          source.source,
        );
      writeReviewPlan(repoRoot, revisedSources);
      const revisedDigests = {
        claimBlind: reviewReceiptDigest(revisedSources[0]),
        specBlind: reviewReceiptDigest(revisedSources[1]),
      };
      const revisedBody = renderPrTraceBlock({
        plan_id: "PLAN-L7-436-domain",
        plan_revision: "2",
        route_mode: "add-feature",
        subject_head: "abcdef1",
        base_sha: "1234567",
        issue_number: "70",
        review_receipt_digest: combinedReviewReceiptDigest(revisedDigests),
      });
      expect(() =>
        syncRepositoryBindings({
          db,
          repositoryId: "owner/repo",
          repoRoot,
          gh: freshGh(revisedBody),
          now: "2026-07-30T02:00:00Z",
        }),
      ).not.toThrow();
      expect(
        db
          .prepare(
            "SELECT plan_revision FROM github_object_bindings WHERE object_kind = 'merge' LIMIT 1",
          )
          .get(),
      ).toEqual({ plan_revision: "2" });
      const revisedMerge = db
        .prepare("SELECT state FROM github_object_bindings WHERE object_kind = 'merge' LIMIT 1")
        .get();
      expect(decodeMergeClosureReceipt(String(revisedMerge?.state))).toMatchObject({
        status: "verified",
        planRevision: "2",
      });
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHBIND-002: skips untraced, revisionless, and stale-head PRs without writes", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO schedule_entries (schedule_entry_id, plan_id, status, source_hash)
         VALUES (?, ?, ?, ?)`,
      ).run("schedule:no-fallback", "PLAN-L7-436-domain", "confirmed", "1");
      const noRevision = renderPrTraceBlock({
        plan_id: "PLAN-L7-436-domain",
        route_mode: "add-feature",
        subject_head: "abcdef1",
        base_sha: "1234567",
        issue_number: "70",
      });
      const result = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        gh: new FakeGh([
          { number: 1, body: "" },
          { number: 2, body: noRevision, headRefOid: "abcdef1" },
          { number: 3, body: noRevision.replace("abcdef1", "bbbbbbb"), headRefOid: "abcdef1" },
        ]),
      });
      expect(result.skipped.map((row) => row.reason)).toEqual([
        "trace-block-missing",
        "plan-revision-missing",
        "plan-revision-missing",
      ]);
      expect(db.prepare("SELECT COUNT(*) count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("U-GHBIND-003: rejects incomplete checks, provider, lane, and HEAD custody", () => {
    for (const scenario of [
      "unrelated-check",
      "same-provider",
      "unknown-provider",
      "missing-lane",
      "missing-issue",
      "stale-head",
      "forged-source",
      "wrong-base",
    ] as const) {
      const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-review-"));
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        db.prepare(
          `INSERT INTO schedule_entries (
            schedule_entry_id, plan_id, status, plan_revision, source_hash
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run("schedule:closure", "PLAN-L7-436-domain", "confirmed", "1", "hash1");
        db.prepare(
          `INSERT INTO github_project_item_projection (
            projection_id, repository_id, project_id, project_item_id, plan_id,
            plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `project:closure:${scenario}`,
          "owner/repo",
          "project:1",
          `item:closure:${scenario}`,
          "PLAN-L7-436-domain",
          "1",
          "",
          "abcdef1",
          "同期済",
          "2026-07-29T00:00:00Z",
        );
        const evidenceHead = scenario === "stale-head" ? "bbbbbbb" : "abcdef1";
        const reviewSources = (["claim-blind", "spec-blind"] as const).map((lane) => ({
          planId: "PLAN-L7-436-domain",
          planRevision: "1",
          headSha: evidenceHead,
          reviewKind: "cross_agent",
          verdict: "PASS",
          reviewedAt: "2026-07-29T00:00:00Z",
          testsGreenAt: "2026-07-28T23:00:00Z",
          workerModel: scenario === "unknown-provider" ? "sol" : "gpt-5.6-terra",
          reviewerModel:
            scenario === "same-provider"
              ? "gpt-5.6-sol"
              : scenario === "unknown-provider"
                ? "luna"
                : "claude-opus-4-8",
          source: "docs/plans/PLAN-L7-436-domain.md",
          lane,
          attackTrials: 3,
          citations: ["docs/plans/PLAN-L7-436-domain.md:1"],
        }));
        for (const source of scenario === "missing-lane"
          ? reviewSources.slice(0, 1)
          : reviewSources)
          db.prepare(
            `INSERT INTO github_review_lane_receipts (
              review_lane_receipt_id, plan_id, plan_revision, lane, subject_head,
              verdict, reviewed_at, tests_green_at, worker_model, reviewer_model,
              attack_trials, citations_json, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            `review:closure:${source.lane}`,
            source.planId,
            source.planRevision,
            source.lane,
            source.headSha,
            source.verdict,
            source.reviewedAt,
            source.testsGreenAt,
            source.workerModel,
            source.reviewerModel,
            source.attackTrials,
            JSON.stringify(source.citations),
            source.source,
          );
        const reviewDigests = {
          claimBlind: reviewReceiptDigest(reviewSources[0]),
          specBlind: reviewReceiptDigest(reviewSources[1]),
        };
        if (scenario !== "forged-source")
          writeReviewPlan(
            repoRoot,
            scenario === "missing-lane" ? reviewSources.slice(0, 1) : reviewSources,
          );
        const bodyWithIssue = renderPrTraceBlock({
          plan_id: reviewSources[0].planId,
          plan_revision: reviewSources[0].planRevision,
          route_mode: "add-feature",
          subject_head: "abcdef1",
          base_sha: "1234567",
          issue_number: "70",
          review_receipt_digest: combinedReviewReceiptDigest(reviewDigests),
        });
        const body =
          scenario === "missing-issue"
            ? bodyWithIssue.replace("issue_number: 70\n", "")
            : bodyWithIssue;
        const checkName = scenario === "unrelated-check" ? "docs-only" : "harness-check";
        const result = syncRepositoryBindings({
          db,
          repositoryId: "owner/repo",
          repoRoot,
          gh: new FakeGh(
            [
              {
                number: 16,
                url: "https://github.com/owner/repo/pull/16",
                headRefName: "feature/closure",
                headRefOid: "abcdef1",
                state: "MERGED",
                baseRefName: scenario === "wrong-base" ? "feature/stack" : "main",
                mergedAt: "2026-07-29T00:00:00Z",
                mergeCommit: { oid: "fedcba1" },
                body,
                statusCheckRollup: [
                  { name: checkName, databaseId: "pr-check", conclusion: "SUCCESS" },
                ],
                reviews: [{ state: "APPROVED" }],
              },
            ],
            {
              check_runs: [{ name: "harness-check", id: "main-check", conclusion: "SUCCESS" }],
            },
          ),
        });
        expect(result.skipped).toContainEqual({
          number: "16",
          reason:
            scenario === "missing-issue"
              ? "missing-issue-number"
              : scenario === "forged-source"
                ? "plan-source-unavailable"
                : "merge-closure-incomplete",
        });
        const mergeBinding = db
          .prepare("SELECT state FROM github_object_bindings WHERE object_kind = 'merge' LIMIT 1")
          .get();
        expect(mergeBinding).toEqual(
          scenario === "missing-issue" || scenario === "forged-source"
            ? undefined
            : { state: "invalidated:closure-incomplete" },
        );
        if (scenario === "wrong-base")
          expect(
            db
              .prepare("SELECT object_id FROM github_object_bindings WHERE object_id LIKE 'main:%'")
              .all(),
          ).toEqual([]);
      } finally {
        db.close();
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("U-GHBIND-004: rejects untyped PLAN ID text outside a typed PR trace", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO schedule_entries (schedule_entry_id, plan_id, status, plan_revision, source_hash)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("schedule:fallback", "PLAN-L7-436-domain", "draft", "1", "hash1");
      const result = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        gh: new FakeGh([
          {
            number: 17,
            title: "PLAN-L7-436-domain: informal tracking title",
            headRefName: "feature/PLAN-L7-436-domain",
            headRefOid: "abcdef1",
            state: "OPEN",
            body: "This mentions PLAN-L7-436-domain but carries no typed trace.",
          },
        ]),
      });
      expect(result.skipped).toContainEqual({ number: "17", reason: "trace-block-missing" });
      expect(db.prepare("SELECT COUNT(*) count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("U-GHBIND-005: fails closed when a PR listing may be truncated at the provider limit", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      expect(() =>
        syncRepositoryBindings({
          db,
          repositoryId: "owner/repo",
          gh: new FakeGh(Array.from({ length: 1000 }, (_, index) => ({ number: index + 1 }))),
        }),
      ).toThrow(/truncat/i);
      expect(db.prepare("SELECT COUNT(*) count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("U-GHBIND-006: rolls back every binding when a later lifecycle write conflicts", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-review-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO schedule_entries (schedule_entry_id, plan_id, status, plan_revision, source_hash)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("schedule:rollback", "PLAN-L7-436-domain", "confirmed", "1", "hash1");
      db.prepare(
        `INSERT INTO github_project_item_projection (
          projection_id, repository_id, project_id, project_item_id, plan_id,
          plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "project:rollback",
        "owner/repo",
        "project:1",
        "item:436",
        "PLAN-L7-436-domain",
        "1",
        "",
        "abcdef1",
        "同期済",
        "2026-07-29T00:00:00Z",
      );
      db.prepare(
        `INSERT INTO github_object_bindings (
          binding_id, repository_id, plan_id, plan_revision, project_item_id,
          object_kind, object_id, object_url, head_sha, state, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "foreign-branch",
        "owner/repo",
        "PLAN-L7-999-foreign",
        "1",
        "",
        "branch",
        "feature/rollback",
        "",
        "oldhead",
        "open",
        "2026-07-28T00:00:00Z",
      );
      const sources = (["claim-blind", "spec-blind"] as const).map((lane) => ({
        planId: "PLAN-L7-436-domain",
        planRevision: "1",
        headSha: "abcdef1",
        reviewKind: "cross_agent",
        verdict: "PASS",
        reviewedAt: "2026-07-29T00:00:00Z",
        testsGreenAt: "2026-07-28T23:00:00Z",
        workerModel: "claude-sonnet-5",
        reviewerModel: "gpt-5.6-sol",
        source: "docs/plans/PLAN-L7-436-domain.md",
        lane,
        attackTrials: 3,
        citations: ["docs/plans/PLAN-L7-436-domain.md:1"],
      }));
      for (const source of sources)
        db.prepare(
          `INSERT INTO github_review_lane_receipts (
            review_lane_receipt_id, plan_id, plan_revision, lane, subject_head,
            verdict, reviewed_at, tests_green_at, worker_model, reviewer_model,
            attack_trials, citations_json, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `review:rollback:${source.lane}`,
          source.planId,
          source.planRevision,
          source.lane,
          source.headSha,
          source.verdict,
          source.reviewedAt,
          source.testsGreenAt,
          source.workerModel,
          source.reviewerModel,
          source.attackTrials,
          JSON.stringify(source.citations),
          source.source,
        );
      writeReviewPlan(repoRoot, sources);
      const receiptDigests = {
        claimBlind: reviewReceiptDigest(sources[0]),
        specBlind: reviewReceiptDigest(sources[1]),
      };
      const body = renderPrTraceBlock({
        plan_id: "PLAN-L7-436-domain",
        plan_revision: "1",
        route_mode: "add-feature",
        subject_head: "abcdef1",
        base_sha: "1234567",
        issue_number: "70",
        review_receipt_digest: combinedReviewReceiptDigest(receiptDigests),
      });
      expect(() =>
        syncRepositoryBindings({
          db,
          repositoryId: "owner/repo",
          repoRoot,
          gh: new FakeGh(
            [
              {
                number: 18,
                url: "https://github.com/owner/repo/pull/18",
                headRefName: "feature/rollback",
                headRefOid: "abcdef1",
                state: "MERGED",
                baseRefName: "main",
                mergedAt: "2026-07-29T00:00:00Z",
                mergeCommit: { oid: "fedcba1" },
                body,
                statusCheckRollup: [
                  { name: "harness-check", databaseId: "pr-check", conclusion: "SUCCESS" },
                ],
                reviews: [{ state: "APPROVED" }],
              },
            ],
            { check_runs: [{ name: "harness-check", id: "main-check", conclusion: "SUCCESS" }] },
          ),
        }),
      ).toThrow(/identity conflict/);
      expect(
        db.prepare("SELECT binding_id FROM github_object_bindings ORDER BY binding_id").all(),
      ).toEqual([{ binding_id: "foreign-branch" }]);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHBIND-007: refuses merge closure before a non-empty Project item binding exists", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-review-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO schedule_entries (schedule_entry_id, plan_id, status, plan_revision, source_hash)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("schedule:project-required", "PLAN-L7-436-domain", "confirmed", "1", "hash1");
      const sources = (["claim-blind", "spec-blind"] as const).map((lane) => ({
        planId: "PLAN-L7-436-domain",
        planRevision: "1",
        headSha: "abcdef1",
        reviewKind: "cross_agent",
        verdict: "PASS",
        reviewedAt: "2026-07-29T00:00:00Z",
        testsGreenAt: "2026-07-28T23:00:00Z",
        workerModel: "claude-sonnet-5",
        reviewerModel: "gpt-5.6-sol",
        source: "docs/plans/PLAN-L7-436-domain.md",
        lane,
        attackTrials: 3,
        citations: ["docs/plans/PLAN-L7-436-domain.md:1"],
      }));
      for (const source of sources)
        db.prepare(
          `INSERT INTO github_review_lane_receipts (review_lane_receipt_id, plan_id, plan_revision, lane, subject_head, verdict, reviewed_at, tests_green_at, worker_model, reviewer_model, attack_trials, citations_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `review:project-required:${source.lane}`,
          source.planId,
          source.planRevision,
          source.lane,
          source.headSha,
          source.verdict,
          source.reviewedAt,
          source.testsGreenAt,
          source.workerModel,
          source.reviewerModel,
          source.attackTrials,
          JSON.stringify(source.citations),
          source.source,
        );
      writeReviewPlan(repoRoot, sources);
      const body = renderPrTraceBlock({
        plan_id: "PLAN-L7-436-domain",
        plan_revision: "1",
        route_mode: "add-feature",
        subject_head: "abcdef1",
        base_sha: "1234567",
        issue_number: "70",
        review_receipt_digest: combinedReviewReceiptDigest({
          claimBlind: reviewReceiptDigest(sources[0]),
          specBlind: reviewReceiptDigest(sources[1]),
        }),
      });
      const result = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: new FakeGh(
          [
            {
              number: 19,
              url: "https://github.com/owner/repo/pull/19",
              headRefName: "feature/project-required",
              headRefOid: "abcdef1",
              state: "MERGED",
              baseRefName: "main",
              mergedAt: "2026-07-29T00:00:00Z",
              mergeCommit: { oid: "fedcba1" },
              body,
              statusCheckRollup: [
                { name: "harness-check", databaseId: "pr-check", conclusion: "SUCCESS" },
              ],
              reviews: [{ state: "APPROVED" }],
            },
          ],
          { check_runs: [{ name: "harness-check", id: "main-check", conclusion: "SUCCESS" }] },
        ),
      });
      expect(result.skipped).toContainEqual({ number: "19", reason: "project-item-required" });
      expect(
        db
          .prepare("SELECT COUNT(*) count FROM github_object_bindings WHERE object_kind = 'merge'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHBIND-008: completes every provider observation before opening the write transaction", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-network-boundary-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeAdmittedTestPlan(repoRoot, "PLAN-L7-436-domain", "1");
      db.prepare(
        `INSERT INTO schedule_entries (schedule_entry_id, plan_id, status, plan_revision, source_hash)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("schedule:no-network-in-tx", "PLAN-L7-436-domain", "confirmed", "1", "hash1");
      const gh = new FakeGh(
        [
          {
            number: 20,
            url: "https://github.com/owner/repo/pull/20",
            headRefName: "feature/no-network-in-tx",
            headRefOid: "abcdef1",
            state: "MERGED",
            baseRefName: "main",
            mergedAt: "2026-07-29T00:00:00Z",
            mergeCommit: { oid: "fedcba1" },
            body: renderPrTraceBlock({
              plan_id: "PLAN-L7-436-domain",
              plan_revision: "1",
              route_mode: "add-feature",
              subject_head: "abcdef1",
              base_sha: "1234567",
              issue_number: "70",
            }),
            statusCheckRollup: [],
            reviews: [],
          },
        ],
        { check_runs: [] },
        { state: "OPEN" },
      );
      let providerCalls = 0;
      gh.onJson = () => {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
        providerCalls += 1;
      };

      syncRepositoryBindings({ db, repositoryId: "owner/repo", repoRoot, gh });

      expect(providerCalls).toBe(4);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHBIND-009: manual observe cannot mint check or review evidence", () => {
    expect(
      ["project_item", "issue", "branch", "pull_request"].filter(isManualGithubObservationKind),
    ).toEqual(["project_item", "issue", "branch", "pull_request"]);
    expect(["check_run", "review", "merge"].some(isManualGithubObservationKind)).toBe(false);
  });

  it("U-GHBIND-011: PLAN revision comes from the admission binding, not the source hash", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        "INSERT INTO schedule_entries (schedule_entry_id, plan_id, plan_revision, source_hash) VALUES (?, ?, ?, ?)",
      ).run("schedule:1", "PLAN-L7-436-domain", "2", "whole-file-hash");
      expect(resolveCurrentPlanRevision(db, "PLAN-L7-436-domain")).toBe("2");
    } finally {
      db.close();
    }
  });

  it("U-GHBIND-020: source hash is never accepted as a PLAN revision", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        "INSERT INTO schedule_entries (schedule_entry_id, plan_id, source_hash) VALUES (?, ?, ?)",
      ).run("schedule:missing-revision", "PLAN-L7-436-no-revision", "sha256:not-a-revision");
      expect(resolveCurrentPlanRevision(db, "PLAN-L7-436-no-revision")).toBe("");
      expect(readForwardSchedule(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("U-GHBIND-012: rejects a stale DB projection against the canonical PLAN revision", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-projection-freshness-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeAdmittedTestPlan(repoRoot, "PLAN-L7-436-domain", "2");
      const plansDir = join(repoRoot, "docs", "plans");
      db.prepare(
        `INSERT INTO schedule_entries (
          schedule_entry_id, plan_id, status, plan_revision, source_hash
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run("schedule:stale", "PLAN-L7-436-domain", "confirmed", "1", "old-hash");
      const body = renderPrTraceBlock({
        plan_id: "PLAN-L7-436-domain",
        plan_revision: "1",
        route_mode: "add-feature",
        subject_head: "abcdef1",
        base_sha: "1234567",
        issue_number: "213",
      });
      const result = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: new FakeGh([
          {
            number: 18,
            url: "https://github.com/owner/repo/pull/18",
            headRefName: "feature/stale-projection",
            headRefOid: "abcdef1",
            state: "OPEN",
            baseRefName: "main",
            body,
            statusCheckRollup: [],
            reviews: [],
          },
        ]),
      });
      expect(result.skipped).toContainEqual({ number: "18", reason: "stale-plan-projection" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });
      db.prepare("UPDATE schedule_entries SET plan_revision = ? WHERE plan_id = ?").run(
        "2",
        "PLAN-L7-436-domain",
      );
      rmSync(join(plansDir, "PLAN-L7-436-domain.md"));
      const missingSource = syncRepositoryBindings({
        db,
        repositoryId: "owner/repo",
        repoRoot,
        gh: new FakeGh([
          {
            number: 19,
            headRefName: "feature/missing-plan-source",
            headRefOid: "abcdef2",
            state: "OPEN",
            baseRefName: "main",
            body: renderPrTraceBlock({
              plan_id: "PLAN-L7-436-domain",
              plan_revision: "2",
              route_mode: "add-feature",
              subject_head: "abcdef2",
              base_sha: "1234567",
              issue_number: "213",
            }),
            statusCheckRollup: [],
            reviews: [],
          },
        ]),
      });
      expect(missingSource.skipped).toContainEqual({
        number: "19",
        reason: "plan-source-unavailable",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM github_object_bindings").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
