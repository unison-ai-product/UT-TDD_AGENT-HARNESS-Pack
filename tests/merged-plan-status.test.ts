import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMergedPlanStatus } from "../src/doctor/index.ts";
import {
  analyzeMergedPlanStatus,
  loadMergedPlanStatusInput,
  mergedPlanStatusMessages,
} from "../src/lint/merged-plan-status.ts";
import { classifyTargetArtifacts } from "../src/lint/merged-plan-target-evidence.ts";

describe("merged-plan-status diagnostics (Issue #390 / PLAN-L7-506)", () => {
  it("U-MPSTATUS-506-001: landing violation separates preflight confirm from exact-head close evidence", () => {
    const [message] = mergedPlanStatusMessages({
      ok: false,
      violations: [
        {
          planId: "PLAN-L7-506",
          status: "draft",
          artifacts: ["src/feature.ts"],
          phase: "landing",
        },
      ],
    });

    expect(message).toContain("phase=landing");
    expect(message).toContain("(A) 分割");
    expect(message).toContain("PLAN filing PR");
    expect(message).toContain("pair-freeze cross-review");
    expect(message).toContain("(B) 単一の実装 PR");
    expect(message).toContain("preflight review_evidence");
    expect(message).toContain("confirmed として成立");
    expect(message).toContain("非著者 closing review");
    expect(message).toContain("PASS verdict");
    expect(message).toContain("canonical receipt");
    expect(message).toContain("exact PR HEAD");
    expect(message).toContain("PR comment / canonical review receipt");
    expect(message).toContain("PLAN の review_evidence へ書き戻す要件ではない");
    expect(message).toContain("close gate");
    expect(message).toContain("review_evidence");
    expect(message).toContain("tests_green_at <= reviewed_at");
    for (const field of [
      "kind",
      "command",
      "runner",
      "scope",
      "exit_code",
      "completed_at",
      "evidence_path",
      "output_digest",
      "anchor_commit",
    ]) {
      expect(message).toContain(field);
    }
    expect(message).toContain("docs/design/harness/L6-function-design/test-before-review.md");
  });

  it("U-MPSTATUS-506-002: merged violation keeps the legacy diagnostic without landing guidance", () => {
    const [message] = mergedPlanStatusMessages({
      ok: false,
      violations: [
        {
          planId: "PLAN-MERGED",
          status: "draft",
          artifacts: ["src/already.ts"],
          phase: "merged",
        },
      ],
    });

    expect(message).toBe(
      "merged-plan-status - violation: PLAN PLAN-MERGED は status=draft (未 confirm) なのに generated deliverable が merge 済み: src/already.ts → PLAN を confirm + review_evidence 記録せよ",
    );
    expect(message).not.toContain("PLAN filing PR");
    expect(message).not.toContain("phase=landing");
  });

  it("U-MPSTATUS-506-003: OK diagnostic remains unchanged", () => {
    expect(mergedPlanStatusMessages({ ok: true, violations: [] })).toEqual([
      "merged-plan-status — OK (merged generated artifact を持つ全 PLAN が confirmed/completed)",
    ]);
  });

  it("U-MPSTATUS-506-004: a non-landing violation cannot receive landing-only guidance", () => {
    const [message] = mergedPlanStatusMessages({
      ok: false,
      violations: [
        {
          planId: "PLAN-LEGACY",
          status: "draft",
          artifacts: ["tests/legacy.test.ts"],
        },
      ],
    });

    expect(message).not.toContain("phase=landing");
    expect(message).not.toContain("(A) 分割");
  });
});

// PO 指摘 2026-06-15: merge 済み generated artifact を持つのに owning PLAN が draft のまま
// 放置される V-model state 不整合 (PLAN-L7-53 の実例) を機械検出する gate の回帰。

describe("analyzeMergedPlanStatus", () => {
  it("flags an artifact-producing PLAN that is draft but whose src is merged", () => {
    const r = analyzeMergedPlanStatus({
      plans: [{ planId: "PLAN-X", status: "draft", kind: "impl", mergedArtifacts: ["src/x.ts"] }],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.planId).toBe("PLAN-X");
  });

  it("does not flag a confirmed/completed PLAN with merged artifacts", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-A", status: "confirmed", kind: "impl", mergedArtifacts: ["src/a.ts"] },
        { planId: "PLAN-B", status: "completed", kind: "add-impl", mergedArtifacts: ["src/b.ts"] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("does not flag a draft PLAN whose src is NOT yet merged (genuinely in-progress)", () => {
    const r = analyzeMergedPlanStatus({
      plans: [{ planId: "PLAN-WIP", status: "draft", kind: "impl", mergedArtifacts: [] }],
    });
    expect(r.ok).toBe(true);
  });

  // PLAN-L7-87 (2026-06-22): kind no longer gates detection. A poc dogfood spike
  // (DISCOVERY-05) or add-design (L3-04/L3-05) that ships merged src must be flagged when
  // left draft. The pre-fix kind filter assumed design/poc/reverse never merge deliverables,
  // which is false and let 3 draft-with-merged-src PLANs slip through doctor green.
  it("flags ANY kind (incl design/poc/add-design) when it ships merged src while draft", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-POC", status: "draft", kind: "poc", mergedArtifacts: ["src/schema/x.ts"] },
        {
          planId: "PLAN-AD",
          status: "draft",
          kind: "add-design",
          mergedArtifacts: ["src/lint/y.ts"],
        },
        { planId: "PLAN-DS", status: "draft", kind: "design", mergedArtifacts: ["src/d.ts"] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.planId)).toEqual(["PLAN-AD", "PLAN-DS", "PLAN-POC"]);
  });

  it("still does not flag a draft PLAN of any kind whose deliverable is NOT merged", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-POC-WIP", status: "draft", kind: "poc", mergedArtifacts: [] },
        { planId: "PLAN-AD-WIP", status: "draft", kind: "add-design", mergedArtifacts: [] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("flags add-impl and refactor kinds too (status-accuracy applies to all src-producers)", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-AI", status: "draft", kind: "add-impl", mergedArtifacts: ["src/ai.ts"] },
        { planId: "PLAN-RF", status: "draft", kind: "refactor", mergedArtifacts: ["src/rf.ts"] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.planId)).toEqual(["PLAN-AI", "PLAN-RF"]);
  });

  it("does not flag an accepted PLAN with merged artifacts (terminal done state)", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-ACC", status: "accepted", kind: "impl", mergedArtifacts: ["src/acc.ts"] },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("loadMergedPlanStatusInput + checkMergedPlanStatus", () => {
  function writePlan(root: string, name: string, status: string, srcPath: string): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/\.md$/, "")}`,
        `status: ${status}`,
        "kind: impl",
        "generates:",
        `  - artifact_path: ${srcPath}`,
        "    artifact_type: source_module",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  // issue #162 (2026-08-20): 元の意図 (PR branch の未 merge artifact を merged 扱いしない) は今も
  // 成立する — mergedArtifacts は空のままである。当時は landing 判定が無かったため、draft PLAN と
  // 同一 PR が持ち込む deliverable の組み合わせが PR CI を素通りし、merge 後の main run で初めて
  // 赤化していた (#140 RECOVERY-18)。三点比較の追加で、同じ入力が merge 前に landing violation
  // として挙がる。
  it("keeps a PR-branch artifact out of mergedArtifacts but reports it as a landing violation", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-pr-plan-"));
    // 三点比較は immediate base が解決できたときだけ有効なので、この面は main 直 PR の event を
    // 明示的に与える (CI の実 PR run と同じ形)。ambient の GITHUB_EVENT_PATH は実 PR の event を
    // 指していて base SHA が temp repo に無いため、放置すると検査したい面を測れない。
    const eventPath = join(root, "event.json");
    const previousEventPath = process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_EVENT_PATH;
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      writeFileSync(join(root, "src", "base.ts"), "export const base = true;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const mainSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { default_branch: "main" },
          pull_request: { base: { ref: "main", sha: mainSha } },
        }),
        "utf8",
      );
      process.env.GITHUB_EVENT_PATH = eventPath;
      git(root, ["checkout", "-b", "feature/pr-plan"]);
      writeFileSync(join(root, "src", "feature.ts"), "export const feature = true;\n", "utf8");
      writePlan(root, "PLAN-TEST-PR-branch.md", "draft", "src/feature.ts");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "feature plan"]);

      const input = loadMergedPlanStatusInput(root);
      const plan = input.plans.find((item) => item.planId === "PLAN-TEST-PR-branch");
      expect(plan?.status).toBe("draft");
      expect(plan?.mergedArtifacts).toEqual([]);
      expect(plan?.landingArtifacts).toEqual(["src/feature.ts"]);
      const violation = analyzeMergedPlanStatus(input).violations.find(
        (item) => item.planId === "PLAN-TEST-PR-branch",
      );
      expect(violation?.phase).toBe("landing");
      expect(violation?.artifacts).toEqual(["src/feature.ts"]);
    } finally {
      if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEventPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the PR PLAN definition while determining merged artifacts from the base tree", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-self-heal-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      writeFileSync(join(root, "src", "merged.ts"), "export const x = 1;\n", "utf8");
      writePlan(root, "PLAN-TEST-self-heal.md", "draft", "src/merged.ts");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base draft"]);
      git(root, ["checkout", "-b", "feature/self-heal"]);
      writePlan(root, "PLAN-TEST-self-heal.md", "confirmed", "src/merged.ts");

      const input = loadMergedPlanStatusInput(root);
      const plan = input.plans.find((item) => item.planId === "PLAN-TEST-self-heal");
      expect(plan?.status).toBe("confirmed");
      expect(plan?.mergedArtifacts).toEqual(["src/merged.ts"]);
      expect(analyzeMergedPlanStatus(input).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a draft PLAN whose generated src exists on disk (merged)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "merged.ts"), "export const x = 1;\n", "utf8");
      // draft PLAN with an existing (merged) src → violation
      writePlan(root, "PLAN-TEST-90-merged.md", "draft", "src/merged.ts");
      // draft PLAN whose src does NOT exist → no violation (in-progress)
      writePlan(root, "PLAN-TEST-91-wip.md", "draft", "src/not-yet.ts");

      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-90-merged");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-91-wip");

      const input = loadMergedPlanStatusInput(root);
      const merged = input.plans.find((p) => p.planId === "PLAN-TEST-90-merged");
      expect(merged?.mergedArtifacts).toContain("src/merged.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when repo root cannot be read", () => {
    const result = checkMergedPlanStatus(join(tmpdir(), "ut-tdd-merged-plan-nope-zzz"));
    expect(result.ok).toBe(false);
  });

  // Regression for the L7-71 detection hole (2026-06-19): an impl PLAN that ships a
  // non-src deliverable (.claude/commands/*.md) and is left draft must be flagged.
  // The pre-fix gate only counted src/*.ts, so this class of drift slipped through.
  function writePlanWithDeliverable(
    root: string,
    name: string,
    status: string,
    deliverablePath: string,
  ): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/\.md$/, "")}`,
        `status: ${status}`,
        "kind: impl",
        "generates:",
        `  - artifact_path: docs/plans/${name}`,
        "    artifact_type: markdown_doc",
        `  - artifact_path: ${deliverablePath}`,
        "    artifact_type: markdown_doc",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("flags a draft impl PLAN that ships a merged .claude/ deliverable (non-src), not just src/*.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-claude-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, ".claude", "commands"), { recursive: true });
      writeFileSync(join(root, ".claude", "commands", "ship.md"), "# ship\n", "utf8");
      // draft impl PLAN whose ONLY deliverable is a committed .claude/ asset -> must flag
      writePlanWithDeliverable(root, "PLAN-TEST-71-cmd.md", "draft", ".claude/commands/ship.md");
      // draft impl PLAN whose .claude/ deliverable does NOT exist yet -> no violation (in-progress)
      writePlanWithDeliverable(root, "PLAN-TEST-72-wip.md", "draft", ".claude/commands/none.md");

      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-71-cmd");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-72-wip");

      const input = loadMergedPlanStatusInput(root);
      const flagged = input.plans.find((p) => p.planId === "PLAN-TEST-71-cmd");
      expect(flagged?.mergedArtifacts).toContain(".claude/commands/ship.md");
      // the PLAN's own docs/ artifact must NOT count as a merged deliverable
      expect(flagged?.mergedArtifacts).not.toContain("docs/plans/PLAN-TEST-71-cmd.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a draft design PLAN that ships only a docs/ artifact (docs/ excluded, kind-independent)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-design-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "docs", "design"), { recursive: true });
      writeFileSync(join(root, "docs", "design", "x.md"), "# design\n", "utf8");
      writeFileSync(
        join(root, "docs", "plans", "PLAN-TEST-73-design.md"),
        [
          "---",
          "plan_id: PLAN-TEST-73-design",
          "status: draft",
          "kind: add-design",
          "generates:",
          "  - artifact_path: docs/design/x.md",
          "    artifact_type: markdown_doc",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
        "utf8",
      );
      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PLAN-L7-87 (2026-06-22): the real drift — a draft add-design/poc PLAN that merged a src/
  // deliverable. The pre-fix gate skipped these by kind; it must now flag them by deliverable.
  it("flags a draft add-design PLAN whose merged deliverable is a src/ module (kind-independent)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-adsrc-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src", "lint"), { recursive: true });
      writeFileSync(join(root, "src", "lint", "y.ts"), "export const y = 1;\n", "utf8");
      writeFileSync(
        join(root, "docs", "plans", "PLAN-TEST-87-adsrc.md"),
        [
          "---",
          "plan_id: PLAN-TEST-87-adsrc",
          "status: draft",
          "kind: add-design",
          "generates:",
          "  - artifact_path: docs/plans/PLAN-TEST-87-adsrc.md",
          "    artifact_type: markdown_doc",
          "  - artifact_path: src/lint/y.ts",
          "    artifact_type: source_module",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
        "utf8",
      );
      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-87-adsrc");
      const input = loadMergedPlanStatusInput(root);
      const flagged = input.plans.find((p) => p.planId === "PLAN-TEST-87-adsrc");
      expect(flagged?.mergedArtifacts).toContain("src/lint/y.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * issue #162: merged-plan-status は PR CI では base tree だけを見ていたため、未 confirm PLAN +
 * deliverable を持ち込む PR が green のまま merge でき、merge 後の main run で初めて赤化していた
 * (#140 RECOVERY-18 → PR #161 で復旧)。対策候補 2 (PR diff の deliverable 追加を検出して PR CI で
 * fail-close) を、canonical target / immediate base / 検査対象 (PR head) の**三点比較**で実装した
 * 回帰。三点目が無い面 (git 解決不能 / event 無し) では従来の二点比較へ縮退する。
 */
describe("pre-merge landing detection (issue #162)", () => {
  // writePlan は上の describe に閉じているので、この面で使う最小版をここに置く。
  function writeLandingPlan(root: string, name: string, status: string, srcPath: string): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/.md$/, "")}`,
        `status: ${status}`,
        "kind: impl",
        "generates:",
        `  - artifact_path: ${srcPath}`,
        "    artifact_type: source_module",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("flags a draft PLAN whose deliverable is landing in the subject, as phase=landing", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        {
          planId: "PLAN-LAND",
          status: "draft",
          kind: "impl",
          mergedArtifacts: [],
          landingArtifacts: ["src/landing.ts"],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      {
        planId: "PLAN-LAND",
        status: "draft",
        artifacts: ["src/landing.ts"],
        phase: "landing",
      },
    ]);
  });

  it("reports one violation per PLAN, keeping the merged phase when both are present", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        {
          planId: "PLAN-BOTH",
          status: "draft",
          kind: "impl",
          mergedArtifacts: ["src/already.ts"],
          landingArtifacts: ["src/landing.ts"],
        },
      ],
    });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.phase).toBe("merged");
    expect(r.violations[0]?.artifacts).toEqual(["src/already.ts"]);
  });

  it("does not flag a confirmed PLAN whose deliverable is landing (the normal implement PR)", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        {
          planId: "PLAN-CONFIRMED-LAND",
          status: "confirmed",
          kind: "impl",
          mergedArtifacts: [],
          landingArtifacts: ["src/landing.ts"],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("degrades to the two-point decision when the subject tree is unresolvable", () => {
    // subjectPaths 未指定 = 従来の二点比較。推測で violation を作らない。
    expect(classifyTargetArtifacts(["src/x.ts"], new Set())).toEqual([
      { path: "src/x.ts", decision: "absent_from_target" },
    ]);
    expect(classifyTargetArtifacts(["src/x.ts"], new Set(["src/x.ts"]))).toEqual([
      { path: "src/x.ts", decision: "landed_on_target" },
    ]);
  });

  it("attributes a stacked PR's inherited deliverable to the base, not to the subject", () => {
    const decisions = classifyTargetArtifacts(
      ["src/from-base.ts", "src/from-subject.ts"],
      new Set(),
      {
        subjectPaths: new Set(["src/from-base.ts", "src/from-subject.ts"]),
        immediateBasePaths: new Set(["src/from-base.ts"]),
      },
    );
    expect(decisions).toEqual([
      { path: "src/from-base.ts", decision: "inherited_from_base" },
      { path: "src/from-subject.ts", decision: "landing_in_subject" },
    ]);
  });

  // Codex 非著者 FLAG (PR #369 @7ff171a4): event 自体が無い面 (非 PR 実行 / ローカル doctor) でも
  // immediate base は分からない。object 未解決の面と区別できない以上、同じく landing 検出ごと落として
  // 二点比較へ縮退させる。subject だけで分類すると stacked 構成の親由来 deliverable を landing と
  // 誤認するため。三点比較は subject と immediate base の**両方**が解決できたときだけ有効。
  it("suppresses landing detection when no pull_request event declares an immediate base", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-no-event-"));
    const previousEventPath = process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_EVENT_PATH;
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      writeFileSync(join(root, "src", "base.ts"), "export const base = true;\n", "utf8");
      git(root, ["add", "src/base.ts"]);
      git(root, ["commit", "-m", "main base"]);
      git(root, ["checkout", "-b", "feature/no-event"]);
      writeFileSync(join(root, "src", "stacked.ts"), "export const stacked = true;\n", "utf8");
      writeLandingPlan(root, "PLAN-TEST-no-event.md", "draft", "src/stacked.ts");
      git(root, ["add", "src/stacked.ts", "docs/plans/PLAN-TEST-no-event.md"]);
      git(root, ["commit", "-m", "branch"]);

      const input = loadMergedPlanStatusInput(root);
      const plan = input.plans.find((item) => item.planId === "PLAN-TEST-no-event");
      expect(plan?.landingArtifacts).toEqual([]);
      expect(plan?.artifactDecisions).toEqual([
        { path: "src/stacked.ts", decision: "absent_from_target" },
      ]);
      expect(analyzeMergedPlanStatus(input).violations).toEqual([]);
    } finally {
      if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEventPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // advisor (gpt-5.6-sol) の反証: immediate base SHA が event にあってもローカルで解決できない面
  // (親 branch が消された / shallow fetch) では、親由来と本 PR 由来を区別できない。subject だけで
  // 分類すると親の成果物を landing と誤認し、RECOVERY-18 が塞いだ「子 PR を永久 Red にする」誤検出を
  // 別経路で再発させる。三点目が欠けたら landing 検出ごと落とす。
  it("suppresses landing detection when a declared immediate base cannot be resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-unresolved-base-"));
    const eventPath = join(root, "event.json");
    const previousEventPath = process.env.GITHUB_EVENT_PATH;
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      writeFileSync(join(root, "src", "base.ts"), "export const base = true;\n", "utf8");
      git(root, ["add", "src/base.ts"]);
      git(root, ["commit", "-m", "main base"]);
      git(root, ["checkout", "-b", "feature/child"]);
      writeFileSync(join(root, "src", "stacked.ts"), "export const stacked = true;\n", "utf8");
      writeLandingPlan(root, "PLAN-TEST-lost-base.md", "draft", "src/stacked.ts");
      git(root, ["add", "src/stacked.ts", "docs/plans/PLAN-TEST-lost-base.md"]);
      git(root, ["commit", "-m", "child"]);

      writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { default_branch: "main" },
          // 形式は正しいがこの repo に存在しない object。親 branch 削除後の CI を模す。
          pull_request: { base: { ref: "feature/parent", sha: `${"0".repeat(39)}1` } },
        }),
        "utf8",
      );
      process.env.GITHUB_EVENT_PATH = eventPath;

      const input = loadMergedPlanStatusInput(root);
      const plan = input.plans.find((item) => item.planId === "PLAN-TEST-lost-base");
      expect(plan?.landingArtifacts).toEqual([]);
      expect(plan?.artifactDecisions).toEqual([
        { path: "src/stacked.ts", decision: "absent_from_target" },
      ]);
      expect(analyzeMergedPlanStatus(input).violations).toEqual([]);
    } finally {
      if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEventPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a stacked PR whose deliverable already exists on its immediate base", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stacked-landing-"));
    const eventPath = join(root, "event.json");
    const previousEventPath = process.env.GITHUB_EVENT_PATH;
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      writeFileSync(join(root, "src", "base.ts"), "export const base = true;\n", "utf8");
      git(root, ["add", "src/base.ts"]);
      git(root, ["commit", "-m", "main base"]);

      // 親 PR: deliverable と draft PLAN を持ち込む。
      git(root, ["checkout", "-b", "feature/parent"]);
      writeFileSync(join(root, "src", "stacked.ts"), "export const stacked = true;\n", "utf8");
      writeLandingPlan(root, "PLAN-TEST-stacked.md", "draft", "src/stacked.ts");
      git(root, ["add", "src/stacked.ts", "docs/plans/PLAN-TEST-stacked.md"]);
      git(root, ["commit", "-m", "parent"]);
      const parentSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      // 子 PR: 親の上に別ファイルだけを積む。deliverable は子の責任ではない。
      git(root, ["checkout", "-b", "feature/child"]);
      writeFileSync(join(root, "src", "child.ts"), "export const child = true;\n", "utf8");
      git(root, ["add", "src/child.ts"]);
      git(root, ["commit", "-m", "child"]);

      writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { default_branch: "main" },
          pull_request: { base: { ref: "feature/parent", sha: parentSha } },
        }),
        "utf8",
      );
      process.env.GITHUB_EVENT_PATH = eventPath;

      const input = loadMergedPlanStatusInput(root);
      const plan = input.plans.find((item) => item.planId === "PLAN-TEST-stacked");
      expect(plan?.mergedArtifacts).toEqual([]);
      expect(plan?.landingArtifacts).toEqual([]);
      expect(plan?.artifactDecisions).toEqual([
        { path: "src/stacked.ts", decision: "inherited_from_base" },
      ]);
      expect(analyzeMergedPlanStatus(input).violations.map((item) => item.planId)).not.toContain(
        "PLAN-TEST-stacked",
      );
    } finally {
      if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEventPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function git(root: string, args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}
