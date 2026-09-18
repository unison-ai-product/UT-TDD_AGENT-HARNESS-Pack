import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeReviewEvidence,
  extractReviewEntries,
  GREEN_COMMAND_KINDS,
  GREEN_COMMAND_RUNNERS,
  GREEN_COMMAND_SCOPES,
  hasReviewEvidence,
  loadReviewPlans,
  type ParsedReviewPlan,
  parseReviewPlan,
} from "../src/lint/review-evidence.ts";
import { frontmatterSchema } from "../src/schema/frontmatter.ts";

/** review-evidence lint (IMP-071 presence + IMP-076 cross-review semantic) — review 前置証跡の機械強制。 */

const plan = (o: Partial<ParsedReviewPlan>): ParsedReviewPlan => ({
  file: "x.md",
  plan_id: "PLAN-X",
  kind: "design",
  status: "confirmed",
  updated: "2026-06-05",
  hasEvidence: false,
  crossEntries: [],
  ...o,
});

describe("GitHub review lane custody", () => {
  it("U-GHBIND-004: extracts immutable lane, revision, HEAD, trials, and citations", () => {
    const [entry] = extractReviewEntries(`---
plan_id: PLAN-L7-1-example
review_evidence:
  - reviewer: blind-reviewer
    review_kind: cross_agent
    reviewed_at: 2026-07-29T01:00:00Z
    tests_green_at: 2026-07-29T00:00:00Z
    verdict: PASS
    worker_model: claude-sonnet-5
    reviewer_model: gpt-5.6-sol
    lane: claim-blind
    plan_revision: rev-1
    subject_head: abcdef1
    attack_trials: 3
    citations:
      - src/example.ts:10
---
`);
    expect(entry).toMatchObject({
      lane: "claim-blind",
      plan_revision: "rev-1",
      subject_head: "abcdef1",
      attack_trials: 3,
      citations: ["src/example.ts:10"],
    });
  });
});

describe("green command evidence (IMP-108)", () => {
  it("returns an empty plan set when docs/plans is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-no-plans-"));
    try {
      expect(loadReviewPlans(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-GREENDEF-001: legacy timestamp-only review evidence remains valid before enforcement", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-LEGACY-GREEN",
        updated: "2026-06-22",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-22",
            tests_green_at: "2026-06-22",
          },
        ],
      }),
    ]);

    expect(r.greenCommandViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-GREENDEF-002: new confirmed review evidence requires green_commands", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-NEW-GREEN-MISSING",
        updated: "2026-06-23",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-23",
            tests_green_at: "2026-06-23",
          },
        ],
      }),
    ]);

    expect(r.greenCommandViolations).toEqual([
      { plan_id: "PLAN-NEW-GREEN-MISSING", reason: "missing_green_commands" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-GREENDEF-003: new confirmed review evidence accepts structured green command evidence", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-NEW-GREEN-OK",
        updated: "2026-06-23",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-23",
            tests_green_at: "2026-06-23",
            green_commands: [
              {
                kind: "unit_test",
                command: "bun test tests/review-evidence.test.ts",
                runner: "bun",
                scope: "targeted",
                exit_code: 0,
                evidence_path: "tests/review-evidence.test.ts",
                output_digest: "sha256:0123456789abcdef",
                completed_at: "2026-06-23",
                anchor_commit: "5604874bb73905967b19f2e6cbc048101f807e39",
              },
            ],
          },
        ],
      }),
    ]);

    expect(r.greenCommandViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-GREENDEF-006: runner=node is a valid green command runner after the Node cutover (PLAN-L7-462)", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-NEW-GREEN-NODE",
        updated: "2026-06-23",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-23",
            tests_green_at: "2026-06-23",
            green_commands: [
              {
                kind: "unit_test",
                command: "node scripts/run-vitest-snapshot.ts tests/review-evidence.test.ts",
                runner: "node",
                scope: "targeted",
                exit_code: 0,
                evidence_path: "tests/review-evidence.test.ts",
                output_digest: "sha256:0123456789abcdef",
                completed_at: "2026-06-23",
                anchor_commit: "5604874bb73905967b19f2e6cbc048101f807e39",
              },
            ],
          },
        ],
      }),
    ]);

    expect(r.greenCommandViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-GREENDEF-008: completed_at after tests_green_at は violation", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-NEW-GREEN-AFTER",
        updated: "2026-06-23",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-24",
            tests_green_at: "2026-06-23",
            green_commands: [
              {
                kind: "unit_test",
                command: "bun test tests/review-evidence.test.ts",
                runner: "bun",
                scope: "targeted",
                exit_code: 0,
                evidence_path: "tests/review-evidence.test.ts",
                output_digest: "sha256:0123456789abcdef",
                completed_at: "2026-06-24",
              },
            ],
          },
        ],
      }),
    ]);

    expect(r.greenCommandViolations).toEqual([
      { plan_id: "PLAN-NEW-GREEN-AFTER", reason: "completed_after_tests_green_at" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-GREENDEF-004: nonzero green command exit code fails", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-NEW-GREEN-BAD",
        updated: "2026-06-23",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-23",
            tests_green_at: "2026-06-23",
            green_commands: [
              {
                kind: "doctor",
                command: "bun run src/cli.ts doctor",
                runner: "bun",
                scope: "gate",
                exit_code: 1,
                evidence_path: "docs/plans/PLAN-L7-108-review-green-command-evidence.md",
                output_digest: "sha256:0123456789abcdef",
                completed_at: "2026-06-23",
              },
            ],
          },
        ],
      }),
    ]);

    expect(r.greenCommandViolations).toEqual([
      { plan_id: "PLAN-NEW-GREEN-BAD", reason: "nonzero_exit_code" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-GREENDEF-005: new green command evidence requires completed_at", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-NEW-GREEN-NO-COMPLETED-AT",
        updated: "2026-06-23",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-23",
            tests_green_at: "2026-06-23",
            green_commands: [
              {
                kind: "doctor",
                command: "bun run src/cli.ts doctor",
                runner: "bun",
                scope: "gate",
                exit_code: 0,
                evidence_path: "docs/plans/PLAN-L7-108-review-green-command-evidence.md",
                output_digest: "sha256:0123456789abcdef",
              },
            ],
          },
        ],
      }),
    ]);

    expect(r.greenCommandViolations).toEqual([
      { plan_id: "PLAN-NEW-GREEN-NO-COMPLETED-AT", reason: "missing_completed_at" },
    ]);
    expect(r.ok).toBe(false);
  });
});

/**
 * issue #191: anchor 無しの output_digest は working tree の現在値と比較されるため、無関係な PR が
 * 同じ evidence ファイルへ触れただけで赤化する。
 *
 * 「新規 entry だけ必須」を `completed_at` で判定する初版は、その値が **書き手の自己申告** なので
 * 過去日時を書くだけで迂回できた (PR #361 Codex FLAG B-1)。時間軸を判定から外し、**全 entry で
 * anchor を必須**にする。既存の anchor 無し 8 件は `plan digest-migrate --execute` で実 anchor を
 * backfill 済みなので、grandfather 集合そのものが不要になった。
 *
 * anchor の **実在**検査は本 gate では行わない。squash merge 運用では PR head で記録した正当な
 * anchor が merge 後の main から到達不能になり (実測: CI で 29 件が false positive)、捏造と
 * 区別できないため。詳細は PR #361 のコメントと follow-up issue を参照。
 */
describe("green command anchor_commit 必須化 (issue #191)", () => {
  const withCommand = (plan_id: string, command: Record<string, unknown>) =>
    analyzeReviewEvidence([
      plan({
        plan_id,
        updated: "2026-08-20",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-08-21T00:00:00Z",
            tests_green_at: "2026-08-20T00:00:00Z",
            green_commands: [
              {
                kind: "unit_test",
                command: "npx vitest run tests/review-evidence.test.ts",
                runner: "node",
                scope: "targeted",
                exit_code: 0,
                evidence_path: "tests/review-evidence.test.ts",
                output_digest: "sha256:0123456789abcdef",
                ...command,
              },
            ],
          },
        ],
      }),
    ]);

  it("U-REVIEW-009: requires an anchor regardless of the self-declared completed_at", () => {
    // 旧実装では発効時刻より前として grandfather された入力。自己申告で迂回できない。
    const r = withCommand("PLAN-ANCHOR-BACKDATED", {
      completed_at: "2026-08-19T19:26:02+09:00",
    });
    expect(r.greenCommandViolations).toEqual([
      { plan_id: "PLAN-ANCHOR-BACKDATED", reason: "missing_anchor_commit" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-REVIEW-010: rejects an entry without an anchor", () => {
    const r = withCommand("PLAN-ANCHOR-MISSING", { completed_at: "2026-08-20T00:00:00Z" });
    expect(r.greenCommandViolations).toEqual([
      { plan_id: "PLAN-ANCHOR-MISSING", reason: "missing_anchor_commit" },
    ]);
  });

  it("U-REVIEW-011: accepts an entry that carries an anchor", () => {
    const r = withCommand("PLAN-ANCHOR-OK", {
      completed_at: "2026-08-20T00:00:00Z",
      anchor_commit: "5604874bb73905967b19f2e6cbc048101f807e39",
    });
    expect(r.greenCommandViolations).toEqual([]);
  });

  it("U-REVIEW-012: rejects an anchor that is not a git object name", () => {
    const r = withCommand("PLAN-ANCHOR-INVALID", {
      completed_at: "2026-08-20T00:00:00Z",
      anchor_commit: "main",
    });
    expect(r.greenCommandViolations).toEqual([
      { plan_id: "PLAN-ANCHOR-INVALID", reason: "invalid_anchor_commit" },
    ]);
  });

  it("U-REVIEW-013: holds the shipped corpus free of anchor violations", () => {
    const violations = analyzeReviewEvidence(loadReviewPlans()).greenCommandViolations;
    expect(violations.filter((v) => v.reason.includes("anchor"))).toEqual([]);
  });
});

describe("green command vocabulary pin (schema ↔ lint SSoT)", () => {
  // PR #293 review 申し送り: schema (frontmatter.ts) と lint (review-evidence.ts) の
  // green_commands 語彙は 2 箇所に重複しており、片側だけの変更が無音で通る。
  // zod の invalid_enum_value issue が持つ options (= schema 側 enum の実体) を
  // 突き合わせて同期を恒久固定する (U-VPROF-RUNNER-001 と同型)。
  function schemaEnumOptions(field: "kind" | "runner" | "scope"): string[] {
    const r = frontmatterSchema.safeParse({
      review_evidence: [
        {
          reviewer: "r",
          review_kind: "human",
          reviewed_at: "2026-08-07",
          verdict: "approve",
          green_commands: [
            {
              kind: "__probe__",
              command: "c",
              runner: "__probe__",
              scope: "__probe__",
              exit_code: 0,
              evidence_path: "p",
              output_digest: "sha256:0123456789abcdef",
            },
          ],
        },
      ],
    });
    expect(r.success).toBe(false);
    if (r.success) return [];
    const issue = r.error.issues.find(
      (i) => i.code === "invalid_enum_value" && i.path.at(-1) === field,
    );
    expect(issue, `no invalid_enum_value issue for ${field}`).toBeDefined();
    return [...((issue as { options?: readonly (string | number)[] }).options ?? [])].map(String);
  }

  it("U-GREENDEF-007: schema enum と lint 語彙集合が kind/runner/scope の 3 面で一致する", () => {
    expect(schemaEnumOptions("kind").sort()).toEqual([...GREEN_COMMAND_KINDS].sort());
    expect(schemaEnumOptions("runner").sort()).toEqual([...GREEN_COMMAND_RUNNERS].sort());
    expect(schemaEnumOptions("scope").sort()).toEqual([...GREEN_COMMAND_SCOPES].sort());
  });
});

describe("stale approval cleanup (IMP-080)", () => {
  it("U-REVIEW-007: draft + verdict=approve は stale approval violation", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-DRAFT-APPROVE",
        status: "draft",
        hasEvidence: true,
        crossEntries: [{ review_kind: "intra_runtime_subagent", verdict: "approve" }],
      }),
    ]);
    expect(r.staleApprovalViolations).toEqual([
      { plan_id: "PLAN-DRAFT-APPROVE", reason: "draft_with_approval" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-REVIEW-008: confirmed + approve / draft + 証跡なし は stale approval ではない", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-CONFIRMED-APPROVE",
        status: "confirmed",
        hasEvidence: true,
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            verdict: "approve",
            reviewed_at: "2026-06-08",
            tests_green_at: "2026-06-08",
          },
        ],
      }),
      plan({ plan_id: "PLAN-DRAFT-NONE", status: "draft", hasEvidence: false, crossEntries: [] }),
    ]);
    expect(r.staleApprovalViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("review-evidence lint (review 前置の機械強制、IMP-071)", () => {
  it("U-REVIEW-001: hasReviewEvidence — review_evidence ブロック (≥1 entry) を presence 検出", () => {
    const withEv = `plan_id: PLAN-A\nstatus: confirmed\nreview_evidence:\n  - reviewer: code-reviewer\n    review_kind: intra_runtime_subagent\n    reviewed_at: "2026-06-05"\n    verdict: approve\n`;
    const withoutEv = `plan_id: PLAN-B\nstatus: confirmed\nv2_import: x\n`;
    const emptyKey = `plan_id: PLAN-C\nstatus: confirmed\nreview_evidence:\n`; // key だけ、entry なし
    expect(hasReviewEvidence(withEv)).toBe(true);
    expect(hasReviewEvidence(withoutEv)).toBe(false);
    expect(hasReviewEvidence(emptyKey)).toBe(false);
  });

  it("U-REVIEW-001: hasReviewEvidence — comment lines, key order, and flow style don't defeat presence (issue #503)", () => {
    const withComments = `plan_id: PLAN-COMMENT\nstatus: confirmed\nreview_evidence:\n  # comment line one\n  # comment line two\n  - reviewer: sol\n    review_kind: intra_runtime_subagent\n`;
    const withBlankThenComment = `plan_id: PLAN-BLANK\nstatus: confirmed\nreview_evidence:\n\n  # comment\n  - reviewer: sol\n    review_kind: intra_runtime_subagent\n`;
    const reorderedKeys = `plan_id: PLAN-ORDER\nstatus: confirmed\nreview_evidence:\n  - review_kind: intra_runtime_subagent\n    reviewer: sol\n`;
    const flowStyle = `plan_id: PLAN-FLOW\nstatus: confirmed\nreview_evidence: [{reviewer: code-reviewer, review_kind: intra_runtime_subagent}]\n`;
    expect(hasReviewEvidence(withComments)).toBe(true);
    expect(hasReviewEvidence(withBlankThenComment)).toBe(true);
    expect(hasReviewEvidence(reorderedKeys)).toBe(true);
    expect(hasReviewEvidence(flowStyle)).toBe(true);

    const wrap = (body: string) => `---\n${body}---\n# body text\n`;
    expect(hasReviewEvidence(wrap(withComments))).toBe(true);
    expect(hasReviewEvidence(wrap(withBlankThenComment))).toBe(true);
    expect(hasReviewEvidence(wrap(reorderedKeys))).toBe(true);
    expect(hasReviewEvidence(wrap(flowStyle))).toBe(true);

    const noReviewer = `plan_id: PLAN-NOREV\nstatus: confirmed\nreview_evidence:\n  - review_kind: intra_runtime_subagent\n`;
    const emptyArray = `plan_id: PLAN-EMPTYARR\nstatus: confirmed\nreview_evidence: []\n`;
    const malformed = `plan_id: PLAN-MALFORMED\nstatus: confirmed\nreview_evidence:\n  - reviewer: [unterminated\n`;
    expect(hasReviewEvidence(noReviewer)).toBe(false);
    expect(hasReviewEvidence(emptyArray)).toBe(false);
    expect(hasReviewEvidence(malformed)).toBe(false);

    const p = parseReviewPlan("PLAN-COMMENT.md", `---\n${withComments}---\n`);
    expect(p.hasEvidence).toBe(true);
  });

  it("U-REVIEW-002: parseReviewPlan — plan_id/kind/status/hasEvidence を抽出", () => {
    const content = `plan_id: PLAN-L4-05-workflow-orchestration\nkind: add-design\nstatus: confirmed\nreview_evidence:\n  - reviewer: code-reviewer\n    review_kind: intra_runtime_subagent\n    reviewed_at: "2026-06-05"\n    verdict: approve\n`;
    const p = parseReviewPlan("PLAN-L4-05-workflow-orchestration.md", content);
    expect(p.kind).toBe("add-design");
    expect(p.status).toBe("confirmed");
    expect(p.hasEvidence).toBe(true);
  });

  it("U-REVIEW-003: confirmed の design/impl 系で evidence 無し → missing + ok=false", () => {
    const r = analyzeReviewEvidence([
      plan({ plan_id: "PLAN-L4-09-x", kind: "design", hasEvidence: false }),
    ]);
    expect(r.missing).toEqual([{ plan_id: "PLAN-L4-09-x", kind: "design" }]);
    expect(r.ok).toBe(false);
  });

  it("U-REVIEW-004: evidence あり → missing 0 / ok=true (add-design/add-impl/impl 全 kind)", () => {
    const r = analyzeReviewEvidence([
      plan({ plan_id: "PLAN-D", kind: "design", hasEvidence: true }),
      plan({ plan_id: "PLAN-AD", kind: "add-design", hasEvidence: true }),
      plan({ plan_id: "PLAN-I", kind: "impl", hasEvidence: true }),
      plan({ plan_id: "PLAN-AI", kind: "add-impl", hasEvidence: true }),
    ]);
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-REVIEW-005: 対象外 — draft (未確定) / 非 design-impl kind (poc/charter/reverse) は missing にしない", () => {
    const r = analyzeReviewEvidence([
      plan({ plan_id: "PLAN-DRAFT", kind: "design", status: "draft", hasEvidence: false }),
      plan({ plan_id: "PLAN-POC", kind: "poc", status: "confirmed", hasEvidence: false }),
      plan({ plan_id: "PLAN-CHARTER", kind: "charter", status: "confirmed", hasEvidence: false }),
      plan({ plan_id: "PLAN-REV", kind: "reverse", status: "confirmed", hasEvidence: false }),
      plan({ plan_id: "PLAN-ARCH", kind: "design", status: "archived", hasEvidence: false }),
    ]);
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-REVIEW-006: 実 repo CI fail-close ガード — confirmed design/impl PLAN は全件 review_evidence あり (missing 0)", () => {
    // hard 化 (IMP-071 2026-06-05): 履歴 15 件 back-fill 完了後、missing==[] を CI で課す。
    // 以後 confirmed design/impl PLAN を review 証跡なしで足すと本テストが red → CI fail-close
    // (backfill U-BACKFILL-006 / scrum-reverse U-SCRUMREV-005 と同パターンの実 repo 回帰ガード)。
    const r = analyzeReviewEvidence(loadReviewPlans());
    expect(r.missing).toEqual([]);
    expect(r.crossReviewViolations).toEqual([]); // 実 repo に cross_agent entry は無い (claude-only solo) → 違反0
    expect(r.testBeforeReviewViolations).toEqual([]); // 全 review_evidence entry に tests_green_at ≤ reviewed_at (IMP-077 back-fill 済)
    expect(r.ok).toBe(true);
    // confirmed かつ review_evidence ありの代表 PLAN が missing に出ないことも明示 (draft 除外と混同しない)。
    const missingIds = new Set(r.missing.map((m) => m.plan_id));
    expect(missingIds.has("PLAN-L4-05-workflow-orchestration")).toBe(false);
    expect(missingIds.has("PLAN-L7-13-review-evidence")).toBe(false);
  });
});

/** IMP-076 — cross-review semantic 強制 (same_model_approval / cross_agent distinctness)。 */
describe("cross-review semantic 強制 (IMP-076)", () => {
  it("U-XREVIEW-001: cross_agent で worker≠reviewer model → 違反なし / ok=true", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-A",
        kind: "add-impl",
        crossEntries: [
          {
            review_kind: "cross_agent",
            reviewed_at: "2026-06-05",
            tests_green_at: "2026-06-05",
            worker_model: "claude-opus-4-8",
            reviewer_model: "gpt-5.5",
          },
        ],
        hasEvidence: true,
      }),
    ]);
    expect(r.crossReviewViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-XREVIEW-002: cross_agent で worker≡reviewer の同一 model → violation / ok=false (same_model_approval)", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-B",
        crossEntries: [
          {
            review_kind: "cross_agent",
            worker_model: "claude-opus-4-8",
            reviewer_model: "claude-opus-4-8",
          },
        ],
        hasEvidence: true,
      }),
    ]);
    expect(r.crossReviewViolations).toEqual([
      { plan_id: "PLAN-B", reason: "same_model_or_missing" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-XREVIEW-003: cross_agent で model 欠落 → violation (単体 runtime は相異 model を供給できない=僭称を弾く)", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-C",
        crossEntries: [{ review_kind: "cross_agent" }],
        hasEvidence: true,
      }),
    ]);
    expect(r.crossReviewViolations).toEqual([
      { plan_id: "PLAN-C", reason: "same_model_or_missing" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-XREVIEW-004: cross_agent は同一 provider の別 model でも violation", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-SAME-PROVIDER",
        crossEntries: [
          {
            review_kind: "cross_agent",
            worker_model: "claude-opus-4-8",
            reviewer_model: "claude-sonnet-4-6",
          },
        ],
        hasEvidence: true,
      }),
    ]);
    expect(r.crossReviewViolations).toEqual([
      { plan_id: "PLAN-SAME-PROVIDER", reason: "same_provider" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-XREVIEW-005: 非 cross_agent (intra_runtime_subagent) は model 同一/欠落でも対象外", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-D",
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-05",
            tests_green_at: "2026-06-05",
            worker_model: "x",
            reviewer_model: "x",
          },
        ],
        hasEvidence: true,
      }),
    ]);
    expect(r.crossReviewViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-XREVIEW-006: extractReviewEntries — frontmatter yaml から review_kind/worker_model/reviewer_model 抽出", () => {
    const content = `---
plan_id: PLAN-E
review_evidence:
  - reviewer: frontier-reviewer
    review_kind: cross_agent
    reviewed_at: "2026-06-05"
    verdict: approve
    worker_model: claude-opus-4-8
    reviewer_model: gpt-5.5
---
body`;
    const entries = extractReviewEntries(content);
    expect(entries).toEqual([
      {
        review_kind: "cross_agent",
        verdict: "approve",
        reviewed_at: "2026-06-05",
        worker_model: "claude-opus-4-8",
        reviewer_model: "gpt-5.5",
      },
    ]);
  });
});

/** IMP-077 — 定量テスト→定性レビュー順序強制 (tests_green_at ≤ reviewed_at、全駆動モデル普遍)。 */
describe("test→review 順序強制 (IMP-077)", () => {
  it("U-TORDER-001: tests_green_at ≤ reviewed_at → 違反なし / ok=true", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-T1",
        crossEntries: [
          { review_kind: "human", reviewed_at: "2026-06-05", tests_green_at: "2026-06-04" },
        ],
        hasEvidence: true,
      }),
    ]);
    expect(r.testBeforeReviewViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-TORDER-002: tests_green_at > reviewed_at → review_before_test violation / ok=false", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-T2",
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-05",
            tests_green_at: "2026-06-06",
          },
        ],
        hasEvidence: true,
      }),
    ]);
    expect(r.testBeforeReviewViolations).toEqual([
      { plan_id: "PLAN-T2", reason: "review_before_test" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-TORDER-003: tests_green_at 欠落 → missing_tests_green_at violation", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-T3",
        crossEntries: [{ review_kind: "intra_runtime_subagent", reviewed_at: "2026-06-05" }],
        hasEvidence: true,
      }),
    ]);
    expect(r.testBeforeReviewViolations).toEqual([
      { plan_id: "PLAN-T3", reason: "missing_tests_green_at" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-TORDER-004: 全駆動モデル普遍 — kind=reverse (非 design/impl) でも review_evidence entry があれば順序対象", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-T4",
        kind: "reverse",
        crossEntries: [
          {
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-05",
            tests_green_at: "2026-06-06",
          },
        ],
        hasEvidence: true,
      }),
    ]);
    expect(r.testBeforeReviewViolations).toEqual([
      { plan_id: "PLAN-T4", reason: "review_before_test" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-TORDER-005: draft (未確定) は順序対象外", () => {
    const r = analyzeReviewEvidence([
      plan({
        plan_id: "PLAN-T5",
        status: "draft",
        crossEntries: [{ review_kind: "intra_runtime_subagent", reviewed_at: "2026-06-05" }],
        hasEvidence: true,
      }),
    ]);
    expect(r.testBeforeReviewViolations).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
