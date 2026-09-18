import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveForwardReadiness } from "../src/kernel/forward-readiness.ts";
import {
  encodeMergeClosureReceipt,
  reviewReceiptDigest,
} from "../src/kernel/github-closure-receipt.ts";
import {
  deriveStoredForwardReadiness,
  markGithubProjectionApplied,
  markGithubProjectionFailed,
  queueGithubProjection,
  readGithubEvidence,
  rebuildExecutionReadiness,
  recordGithubBinding,
  selectActiveProjectRows,
  selectExistingProjectPlans,
} from "../src/state-db/github-forward-projection.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { clearRebuildableProjectionTables } from "../src/state-db/sqlite-projection-rebuild.ts";

describe("GitHub Forward SQLite store", () => {
  const insertSchedule = (
    db: ReturnType<typeof openHarnessDb>,
    planId: string,
    revision = "rev1",
    status = "draft",
  ) =>
    db
      .prepare(
        `INSERT INTO schedule_entries (
          schedule_entry_id, plan_id, layer, status, current_location, rag,
          blocked_reason, predecessor_plan_ids, plan_revision, source_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`schedule:${planId}`, planId, "L7", status, "plan", "yellow", "", "", revision);

  const insertMerge = (
    db: ReturnType<typeof openHarnessDb>,
    input: {
      planId: string;
      revision: string;
      prNumber: string;
      headSha: string;
      mergeSha: string;
      state?: string;
      repoRoot?: string;
      includeCheckBindings?: boolean;
    },
  ) => {
    const reviewSources = (["claim-blind", "spec-blind"] as const).map((lane) => ({
      planId: input.planId,
      planRevision: input.revision,
      headSha: input.headSha,
      reviewKind: "cross_agent",
      verdict: "PASS",
      reviewedAt: "2026-07-29T01:00:00Z",
      testsGreenAt: "2026-07-29T00:00:00Z",
      workerModel: "claude-sonnet-5",
      reviewerModel: "gpt-5.6-sol",
      source: `docs/plans/${input.planId}.md`,
      lane,
      attackTrials: 3,
      citations: [`docs/plans/${input.planId}.md:1`],
    }));
    if (!input.state)
      for (const source of reviewSources)
        db.prepare(
          `INSERT INTO github_review_lane_receipts (
            review_lane_receipt_id, plan_id, plan_revision, lane, subject_head,
            verdict, reviewed_at, tests_green_at, worker_model, reviewer_model,
            attack_trials, citations_json, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `review:${input.planId}:${source.lane}`,
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
    if (!input.state && input.repoRoot) {
      const plansDir = join(input.repoRoot, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(plansDir, `${input.planId}.md`),
        `---
plan_id: ${input.planId}
review_evidence:
${reviewSources
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
  .join("\n")}
---
`,
        "utf8",
      );
    }
    if (!input.state && input.includeCheckBindings !== false) {
      const checkRows = [
        [`pr:${input.prNumber}:check:pr-check`, "pr-check"],
        [`main:${input.mergeSha}:check:main-check`, "main-check"],
      ] as const;
      for (const [objectId, suffix] of checkRows)
        db.prepare(
          `INSERT INTO github_object_bindings (
            binding_id, repository_id, plan_id, plan_revision, project_item_id,
            object_kind, object_id, object_url, head_sha, state, observed_at
          ) VALUES (?, 'repo', ?, ?, '', 'check_run', ?, '', ?, '成功', ?)`,
        ).run(
          `check:${input.prNumber}:${suffix}`,
          input.planId,
          input.revision,
          objectId,
          input.headSha,
          "2026-07-29T01:30:00Z",
        );
    }
    return db
      .prepare(
        `INSERT INTO github_object_bindings (
          binding_id, repository_id, plan_id, plan_revision, project_item_id,
          object_kind, object_id, object_url, head_sha, state, observed_at
        ) VALUES (?, ?, ?, ?, '', 'merge', ?, '', ?, ?, ?)`,
      )
      .run(
        `merge:${input.prNumber}`,
        "repo",
        input.planId,
        input.revision,
        `pr:${input.prNumber}:merge:${input.mergeSha}`,
        input.headSha,
        input.state ??
          encodeMergeClosureReceipt({
            version: 1,
            status: "verified",
            planId: input.planId,
            planRevision: input.revision,
            prNumber: input.prNumber,
            headSha: input.headSha,
            mergeSha: input.mergeSha,
            requiredCheck: "harness-check",
            prCheckId: "pr-check",
            mainCheckId: "main-check",
            reviewReceiptDigests: {
              claimBlind: reviewReceiptDigest(reviewSources[0]),
              specBlind: reviewReceiptDigest(reviewSources[1]),
            },
            issueClosed: true,
          }),
        "2026-07-29T02:00:00Z",
      );
  };

  it("U-GHPROJ-010: projects schedule readiness and keeps external bindings across rebuild clear", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO schedule_entries (
          schedule_entry_id, plan_id, layer, status, current_location, rag,
          blocked_reason, predecessor_plan_ids, plan_revision, source_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", "PLAN-L7-1-a", "L7", "draft", "plan", "yellow", "", "", "rev1", "hash1");
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "branch",
        objectId: "feature/a",
        state: "active",
      });
      expect(rebuildExecutionReadiness({ db })).toHaveLength(1);
      expect(db.prepare("SELECT readiness FROM execution_readiness_projection").get()).toEqual({
        readiness: "着手可能",
      });
      clearRebuildableProjectionTables(db);
      expect(db.prepare("SELECT COUNT(*) count FROM execution_readiness_projection").get()).toEqual(
        {
          count: 0,
        },
      );
      expect(db.prepare("SELECT object_id FROM github_object_bindings").get()).toEqual({
        object_id: "feature/a",
      });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-011: converges out-of-order lifecycle observations by object identity", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const base = {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "check_run" as const,
        objectId: "check:abc",
      };
      recordGithubBinding(db, { ...base, state: "実行中", headSha: "abc" });
      recordGithubBinding(db, { ...base, state: "成功", headSha: "abc" });
      expect(db.prepare("SELECT state FROM github_object_bindings").all()).toEqual([
        { state: "成功" },
      ]);
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-012: rejects stale HEAD evidence and keeps queued projection intent", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "12",
        state: "open",
        headSha: "abc",
      });
      expect(() =>
        recordGithubBinding(db, {
          repositoryId: "repo",
          planId: "PLAN-L7-1-a",
          planRevision: "rev1",
          objectKind: "review",
          objectId: "review:1",
          state: "承認",
          headSha: "def",
        }),
      ).toThrow(/stale/);
      queueGithubProjection({
        db,
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        operation: "project-item-upsert",
        payload: {
          owner: "unison-ai-product",
          projectNumber: 6,
          readiness: "着手可能",
          currentGate: "G7",
          headSha: "abcdef1",
        },
      });
      clearRebuildableProjectionTables(db);
      const queued = db
        .prepare("SELECT payload_json, payload_digest, status FROM github_projection_outbox")
        .get();
      expect(queued).toMatchObject({ status: "pending" });
      expect(JSON.parse(String(queued?.payload_json))).toEqual({
        owner: "unison-ai-product",
        projectNumber: 6,
        readiness: "着手可能",
        currentGate: "G7",
        headSha: "abcdef1",
      });
      expect(String(queued?.payload_digest)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-039: rejects non-contract fields before persisting an outbox payload", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      expect(() =>
        queueGithubProjection({
          db,
          repositoryId: "repo",
          planId: "PLAN-L7-1-a",
          planRevision: "rev1",
          operation: "project-item-upsert",
          payload: {
            owner: "unison-ai-product",
            projectNumber: 6,
            readiness: "着手可能",
            currentGate: "G7",
            headSha: "abcdef1",
            token: "must-not-persist",
          } as never,
        }),
      ).toThrow(/payload fields/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM github_projection_outbox").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-052: queues an unstarted PLAN with an explicit empty HEAD", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      queueGithubProjection({
        db,
        repositoryId: "owner/repo",
        planId: "PLAN-L7-1-unstarted",
        planRevision: "rev1",
        operation: "project-item-upsert",
        payload: {
          owner: "owner",
          projectNumber: 6,
          readiness: "着手可能",
          currentGate: "implementation",
          headSha: "",
        },
      });
      const row = db.prepare("SELECT payload_json, status FROM github_projection_outbox").get();
      expect(JSON.parse(String(row?.payload_json))).toMatchObject({ headSha: "" });
      expect(row?.status).toBe("pending");
      for (const invalidHeadSha of [" ", "not-a-sha", undefined, { oid: "abcdef1" }]) {
        expect(() =>
          queueGithubProjection({
            db,
            repositoryId: "owner/repo",
            planId: "PLAN-L7-2-invalid-head",
            planRevision: "rev1",
            operation: "project-item-upsert",
            payload: {
              owner: "owner",
              projectNumber: 6,
              readiness: "着手可能",
              currentGate: "implementation",
              headSha: invalidHeadSha,
            } as never,
          }),
        ).toThrow(/payload values/);
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM github_projection_outbox").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-040: preserves an applied outbox only for an identical payload digest", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const input = {
        db,
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        operation: "project-item-upsert" as const,
        payload: {
          owner: "unison-ai-product",
          projectNumber: 6,
          readiness: "着手可能",
          currentGate: "implementation",
          headSha: "abcdef1",
        },
        now: "2026-07-31T00:00:00Z",
      };
      const firstId = queueGithubProjection(input);
      markGithubProjectionApplied(db, [firstId], "2026-07-31T00:01:00Z");
      expect(queueGithubProjection({ ...input, now: "2026-07-31T00:02:00Z" })).toBe(firstId);
      expect(
        db.prepare("SELECT status, attempt_count, last_error FROM github_projection_outbox").get(),
      ).toEqual({ status: "applied", attempt_count: 1, last_error: "" });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-041: changed payload creates a pending intent that an old completion cannot apply", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const base = {
        db,
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        operation: "project-item-upsert" as const,
        payload: {
          owner: "unison-ai-product",
          projectNumber: 6,
          readiness: "着手可能",
          currentGate: "implementation",
          headSha: "abcdef1",
        },
      };
      const oldId = queueGithubProjection(base);
      markGithubProjectionApplied(db, [oldId]);
      const newId = queueGithubProjection({
        ...base,
        payload: { ...base.payload, currentGate: "review", headSha: "def5678" },
      });
      expect(newId).not.toBe(oldId);
      markGithubProjectionApplied(db, [oldId]);
      expect(
        db
          .prepare(
            "SELECT outbox_id, status, attempt_count, last_error, payload_json FROM github_projection_outbox",
          )
          .get(),
      ).toEqual({
        outbox_id: newId,
        status: "pending",
        attempt_count: 0,
        last_error: "",
        payload_json: JSON.stringify({
          owner: "unison-ai-product",
          projectNumber: 6,
          readiness: "着手可能",
          currentGate: "review",
          headSha: "def5678",
        }),
      });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-044: records a closed retryable failure without persisting provider output", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const id = queueGithubProjection({
        db,
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        operation: "project-item-upsert",
        payload: {
          owner: "unison-ai-product",
          projectNumber: 6,
          readiness: "着手可能",
          currentGate: "review",
          headSha: "def5678",
        },
      });
      markGithubProjectionFailed(db, [id], "2026-07-31T00:03:00Z");
      expect(
        db
          .prepare(
            "SELECT status, attempt_count, last_error, updated_at FROM github_projection_outbox",
          )
          .get(),
      ).toEqual({
        status: "pending",
        attempt_count: 1,
        last_error: "project-sync-failed",
        updated_at: "2026-07-31T00:03:00Z",
      });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-045: a delayed failure cannot reopen an applied intent", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const id = queueGithubProjection({
        db,
        repositoryId: "owner/repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        operation: "project-item-upsert",
        payload: {
          owner: "unison-ai-product",
          projectNumber: 6,
          readiness: "着手可能",
          currentGate: "review",
          headSha: "def5678",
        },
      });
      markGithubProjectionApplied(db, [id]);
      markGithubProjectionFailed(db, [id]);
      expect(
        db.prepare("SELECT status, attempt_count, last_error FROM github_projection_outbox").get(),
      ).toEqual({ status: "applied", attempt_count: 1, last_error: "" });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-046: repository-scoped evidence excludes another repository", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a");
      for (const [repositoryId, state] of [
        ["owner/repo-a", "成功"],
        ["owner/repo-b", "失敗"],
      ])
        recordGithubBinding(db, {
          repositoryId,
          planId: "PLAN-L7-1-a",
          planRevision: "rev1",
          objectKind: "check_run",
          objectId: "check:current",
          state,
          headSha: "abc",
        });
      expect(readGithubEvidence(db, process.cwd(), "owner/repo-a")).toEqual([
        expect.objectContaining({ planId: "PLAN-L7-1-a", ci: "成功" }),
      ]);
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-047: repository-scoped derive cannot truncate the global readiness projection", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a");
      insertSchedule(db, "PLAN-L7-2-b");
      for (const [repositoryId, planId] of [
        ["owner/repo-a", "PLAN-L7-1-a"],
        ["owner/repo-b", "PLAN-L7-2-b"],
      ])
        recordGithubBinding(db, {
          repositoryId,
          planId,
          planRevision: "rev1",
          objectKind: "branch",
          objectId: `branch:${planId}`,
          state: "active",
        });
      rebuildExecutionReadiness({ db, now: "2026-08-03T00:00:00Z" });
      expect(deriveStoredForwardReadiness(db, process.cwd(), "owner/repo-a")).toHaveLength(2);
      expect(
        db.prepare("SELECT plan_id FROM execution_readiness_projection ORDER BY plan_id").all(),
      ).toEqual([{ plan_id: "PLAN-L7-1-a" }, { plan_id: "PLAN-L7-2-b" }]);
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-013: rejects reassignment of one provider object to another PLAN revision", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "12",
        state: "open",
      });
      expect(() =>
        recordGithubBinding(db, {
          repositoryId: "repo",
          planId: "PLAN-L7-2-b",
          planRevision: "rev2",
          objectKind: "pull_request",
          objectId: "12",
          state: "open",
        }),
      ).toThrow(/identity conflict/);
      expect(db.prepare("SELECT plan_id, plan_revision FROM github_object_bindings").get()).toEqual(
        {
          plan_id: "PLAN-L7-1-a",
          plan_revision: "rev1",
        },
      );
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-014: allows Project item revision rollover but rejects delayed regression", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const base = {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        objectKind: "project_item" as const,
        objectId: "item:1",
        state: "同期済",
      };
      recordGithubBinding(db, {
        ...base,
        planRevision: "rev1",
        observedAt: "2026-07-29T01:00:00Z",
      });
      recordGithubBinding(db, {
        ...base,
        planRevision: "rev2",
        observedAt: "2026-07-29T02:00:00Z",
      });
      recordGithubBinding(db, {
        ...base,
        planRevision: "rev2",
        state: "遅延",
        observedAt: "2026-07-29T01:30:00Z",
      });
      expect(
        db.prepare("SELECT plan_revision, state, observed_at FROM github_object_bindings").get(),
      ).toEqual({
        plan_revision: "rev2",
        state: "同期済",
        observed_at: "2026-07-29T02:00:00Z",
      });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-015: allows a newer lifecycle observation to roll the same PLAN revision", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const base = {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        objectKind: "pull_request" as const,
        objectId: "12",
        state: "open",
      };
      recordGithubBinding(db, {
        ...base,
        planRevision: "1",
        observedAt: "2026-07-29T01:00:00Z",
      });
      recordGithubBinding(db, {
        ...base,
        planRevision: "2",
        observedAt: "2026-07-29T02:00:00Z",
      });
      expect(
        recordGithubBinding(db, {
          ...base,
          planRevision: "1",
          observedAt: "2026-07-29T01:30:00Z",
        }),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT plan_revision, observed_at FROM github_object_bindings").get(),
      ).toEqual({ plan_revision: "2", observed_at: "2026-07-29T02:00:00Z" });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-030: marks multiple open PR heads inconsistent and does not mix their evidence", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a");
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "12",
        state: "open",
        headSha: "abc",
      });
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "check_run",
        objectId: "check:abc",
        state: "成功",
        headSha: "abc",
      });
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "13",
        state: "open",
        headSha: "def",
      });
      expect(() =>
        recordGithubBinding(db, {
          repositoryId: "repo",
          planId: "PLAN-L7-1-a",
          planRevision: "rev1",
          objectKind: "check_run",
          objectId: "check:def",
          state: "成功",
          headSha: "def",
        }),
      ).not.toThrow();
      const [evidence] = readGithubEvidence(db);
      expect(evidence).toMatchObject({
        planId: "PLAN-L7-1-a",
        sync: "不整合",
      });
      expect(evidence).not.toHaveProperty("ci");
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-031: prefers the current open PR over older merged PR evidence", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a");
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "12",
        state: "merged",
        headSha: "old",
      });
      insertMerge(db, {
        planId: "PLAN-L7-1-a",
        revision: "rev1",
        prNumber: "12",
        headSha: "old",
        mergeSha: "abc1234",
      });
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "13",
        state: "open",
        headSha: "current",
      });
      const [evidence] = readGithubEvidence(db);
      expect(evidence).toMatchObject({
        planId: "PLAN-L7-1-a",
        headSha: "current",
      });
      expect(evidence).not.toHaveProperty("mergeVerified");
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-032: ignores stale Project revisions and consumes current merge evidence", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-review-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a", "rev2", "accepted");
      db.prepare(
        `INSERT INTO github_project_item_projection (
          projection_id, repository_id, project_id, project_item_id, plan_id,
          plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "old-projection",
        "repo",
        "project",
        "item",
        "PLAN-L7-1-a",
        "rev1",
        "content",
        "old",
        "同期済",
        "2026-07-29T01:00:00Z",
      );
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev2",
        objectKind: "pull_request",
        objectId: "14",
        state: "merged",
        headSha: "current",
      });
      insertMerge(db, {
        planId: "PLAN-L7-1-a",
        revision: "rev2",
        prNumber: "14",
        headSha: "current",
        mergeSha: "def5678",
        repoRoot,
      });
      expect(readGithubEvidence(db, repoRoot)).toEqual([
        {
          planId: "PLAN-L7-1-a",
          headSha: "current",
          ci: "成功",
          mergeVerified: true,
        },
      ]);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHPROJ-037: preserves the authoritative PR head when Project evidence is stale", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a");
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "15",
        state: "open",
        headSha: "current",
      });
      db.prepare(
        `INSERT INTO github_project_item_projection (
          projection_id, repository_id, project_id, project_item_id, plan_id,
          plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "stale-head-projection",
        "repo",
        "project",
        "item",
        "PLAN-L7-1-a",
        "rev1",
        "content",
        "old",
        "同期済",
        "2026-07-29T01:00:00Z",
      );

      expect(readGithubEvidence(db)).toEqual([
        {
          planId: "PLAN-L7-1-a",
          headSha: "current",
          sync: "不整合",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-036: rebuild resolves review evidence from the supplied repository root, not process cwd", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-review-root-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a", "rev1", "confirmed");
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "check_run",
        objectId: "check:current",
        state: "成功",
        headSha: "current",
      });
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "review",
        objectId: "review:current",
        state: "承認",
        headSha: "current",
      });
      db.prepare(
        `INSERT INTO github_project_item_projection (
          projection_id, repository_id, project_id, project_item_id, plan_id,
          plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "projection:current",
        "repo",
        "project",
        "item",
        "PLAN-L7-1-a",
        "rev1",
        "",
        "current",
        "同期済",
        "2026-07-29T01:00:00Z",
      );
      insertMerge(db, {
        planId: "PLAN-L7-1-a",
        revision: "rev1",
        prNumber: "14",
        headSha: "current",
        mergeSha: "def5678",
        repoRoot,
      });
      expect(
        rebuildExecutionReadiness({
          db,
          now: "2026-07-29T03:00:00Z",
          transactional: true,
          repoRoot,
        })[0],
      ).toMatchObject({
        readiness: "完了",
      });
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHPROJ-033: keeps managed completed rows in all-active convergence", () => {
    const rows = deriveForwardReadiness(
      [
        {
          planId: "PLAN-L7-1-a",
          revision: "rev1",
          layer: "L7",
          status: "accepted",
          currentLocation: "accept",
          rag: "green",
          blockedReason: "",
          predecessorPlanIds: [],
        },
        {
          planId: "PLAN-L7-2-b",
          revision: "rev1",
          layer: "L7",
          status: "parked",
          currentLocation: "plan",
          rag: "yellow",
          blockedReason: "",
          predecessorPlanIds: [],
        },
      ],
      [
        {
          planId: "PLAN-L7-1-a",
          ci: "成功",
          review: "承認",
          sync: "同期済",
          mergeVerified: true,
        },
      ],
    );
    expect(selectActiveProjectRows(rows, new Set(["PLAN-L7-1-a"]))).toEqual([rows[0]]);
  });

  it("U-GHPROJ-034: stored readiness never treats unmanaged completed status as closure evidence", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a", "rev1", "confirmed");
      db.prepare(
        `INSERT INTO schedule_entries (
          schedule_entry_id, plan_id, layer, status, current_location, rag,
          blocked_reason, predecessor_plan_ids, plan_revision, source_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "schedule:PLAN-L7-2-b",
        "PLAN-L7-2-b",
        "L7",
        "draft",
        "plan",
        "yellow",
        "",
        "PLAN-L7-1-a",
        "rev1",
        "hash2",
      );
      const rows = rebuildExecutionReadiness({ db });
      expect(rows[0]).toMatchObject({ readiness: "阻害中", currentGate: "merge-closure" });
      expect(rows[0]?.unlockedPlanIds).toEqual([]);
      expect(rows[1]?.readiness).toBe("阻害中");
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-035: rejects forged merge receipts and ignores invalidated receipts", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gh-forged-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertSchedule(db, "PLAN-L7-1-a");
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-1-a",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "15",
        state: "merged",
        headSha: "head15",
      });
      expect(() =>
        recordGithubBinding(db, {
          repositoryId: "repo",
          planId: "PLAN-L7-1-a",
          planRevision: "rev1",
          objectKind: "merge",
          objectId: "pr:15:merge:abc9876",
          state: "bogus",
          headSha: "head15",
        } as unknown as Parameters<typeof recordGithubBinding>[1]),
      ).toThrow(/repository-sync only/);
      insertMerge(db, {
        planId: "PLAN-L7-1-a",
        revision: "rev1",
        prNumber: "15",
        mergeSha: "abc9876",
        state: "invalidated:closure-incomplete",
        headSha: "head15",
      });
      expect(readGithubEvidence(db)[0]).not.toHaveProperty("mergeVerified");

      insertSchedule(db, "PLAN-L7-2-forged");
      recordGithubBinding(db, {
        repositoryId: "repo",
        planId: "PLAN-L7-2-forged",
        planRevision: "rev1",
        objectKind: "pull_request",
        objectId: "16",
        state: "merged",
        headSha: "head16",
      });
      insertMerge(db, {
        planId: "PLAN-L7-2-forged",
        revision: "rev1",
        prNumber: "16",
        mergeSha: "def9876",
        headSha: "head16",
        repoRoot,
        includeCheckBindings: false,
      });
      expect(
        readGithubEvidence(db, repoRoot).find((row) => row.planId === "PLAN-L7-2-forged"),
      ).not.toHaveProperty("mergeVerified");
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-GHPROJ-038: existing Project plans are scoped by repository", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      for (const [repositoryId, planId] of [
        ["owner/repo-a", "PLAN-L7-1-a"],
        ["owner/repo-b", "PLAN-L7-2-b"],
      ])
        db.prepare(
          `INSERT INTO github_project_item_projection (
            projection_id, repository_id, project_id, project_item_id, plan_id,
            plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
          ) VALUES (?, ?, 'project:1', ?, ?, 'rev1', '', '', '同期済', ?)`,
        ).run(`projection:${planId}`, repositoryId, `item:${planId}`, planId, "2026-07-31");

      expect(selectExistingProjectPlans(db, "owner/repo-a")).toEqual(new Set(["PLAN-L7-1-a"]));
    } finally {
      db.close();
    }
  });
});
