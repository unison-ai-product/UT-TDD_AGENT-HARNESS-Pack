import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isOutsideRepo, registerDelegationCommands } from "../src/cli/delegation.ts";
import {
  issueReviewRequest,
  projectReviewVerdict,
  REVIEW_VERDICT_FILE_ENV,
  type ReviewAttestation,
  type ReviewAttestationRequest,
  resolveReviewAuthorFamily,
} from "../src/feedback/review-attestation.ts";
import { analyzeReviewDispatch } from "../src/feedback/review-dispatch.ts";
import { REVIEW_OUTPUT_CONTRACT } from "../src/feedback/review-verdict-contract.ts";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
let stubBinDir: string | undefined;
const originalCodexBin = process.env.UT_TDD_CODEX_BIN;
const originalClaudeBin = process.env.UT_TDD_CLAUDE_BIN;

beforeAll(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-bin-"));
  if (process.platform === "win32") {
    const codexStub = join(stubBinDir, "codex.cmd");
    const claudeStub = join(stubBinDir, "claude.cmd");
    writeFileSync(codexStub, "@echo off\r\necho codex 0.0.0-stub\r\nexit /b 0\r\n", "utf8");
    writeFileSync(claudeStub, "@echo off\r\necho claude 0.0.0-stub\r\nexit /b 0\r\n", "utf8");
    process.env.UT_TDD_CODEX_BIN = codexStub;
    process.env.UT_TDD_CLAUDE_BIN = claudeStub;
    return;
  }
  const codexStub = join(stubBinDir, "codex");
  const claudeStub = join(stubBinDir, "claude");
  writeFileSync(codexStub, "#!/bin/sh\necho codex 0.0.0-stub\nexit 0\n", "utf8");
  writeFileSync(claudeStub, "#!/bin/sh\necho claude 0.0.0-stub\nexit 0\n", "utf8");
  chmodSync(codexStub, 0o755);
  chmodSync(claudeStub, 0o755);
  process.env.UT_TDD_CODEX_BIN = codexStub;
  process.env.UT_TDD_CLAUDE_BIN = claudeStub;
});

afterAll(() => {
  if (originalCodexBin === undefined) delete process.env.UT_TDD_CODEX_BIN;
  else process.env.UT_TDD_CODEX_BIN = originalCodexBin;
  if (originalClaudeBin === undefined) delete process.env.UT_TDD_CLAUDE_BIN;
  else process.env.UT_TDD_CLAUDE_BIN = originalClaudeBin;
  if (stubBinDir) rmSync(stubBinDir, { recursive: true, force: true });
});

function receiptFiles(root: string): string[] {
  const directory = join(root, ".ut-tdd", "review", "receipts");
  return existsSync(directory) ? readdirSync(directory) : [];
}

function request(): ReviewAttestationRequest {
  return {
    memoryId: "memory-rvatt",
    pr: 731,
    exactHead: head,
    reviewRevision: "review-rvatt-1",
    authorFamily: "claude",
    requestedAt: "2026-07-31T01:00:00.000Z",
  };
}

function attestation(overrides: Partial<ReviewAttestation> = {}): ReviewAttestation {
  return {
    provider: "codex",
    role: "blind-reviewer",
    model: "gpt-5.6-sol",
    pr: 731,
    head,
    reviewRevision: "review-rvatt-1",
    startedAt: "2026-07-31T01:00:00.000Z",
    completedAt: "2026-07-31T01:05:00.000Z",
    exitCode: 0,
    ...overrides,
  };
}

function runDelegation(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const program = new Command();
  registerDelegationCommands(program, {
    gitBranch: () => "work/d3b-review-attestation",
    gitHead: () => head,
    resolveTaskText: (opts) => opts.task ?? null,
    resolveSkillContextInjection: () => undefined,
    runSessionStartSideEffects: () => {},
    taskFileOptionDescription: "read task text from file",
    writeHandoverWarnings: () => {},
  });
  let stdout = "";
  let stderr = "";
  const writeStdout = process.stdout.write;
  const writeStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return program
    .parseAsync(["node", "ut-tdd", ...args])
    .then(
      () => ({ stdout, stderr }),
      (error) => {
        throw error;
      },
    )
    .finally(() => {
      process.stdout.write = writeStdout;
      process.stderr.write = writeStderr;
    });
}

describe("review attestation (U-RVATT)", () => {
  it("U-RVATT-001: reviewerFamily は呼出元の自己申告でなく attestation.provider から導出する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-family-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const result = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
        reviewerFamily: "claude",
      } as never);
      expect(result).toMatchObject({ ok: true, receipt: { reviewerFamily: "codex" } });
      expect(result.ok && result.receipt?.at).toBe("2026-07-31T01:05:00.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-002: 非ゼロ終了の attestation は reviewer_exit_nonzero で receipt を作らない", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-exit-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const result = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation({ exitCode: 17 }),
        verdictFile,
      });
      expect(result).toEqual({ ok: false, reason: "reviewer_exit_nonzero" });
      expect(receiptFiles(root)).toEqual([]);

      const strictRequest = {
        ...request(),
        authorFamily: "codex" as const,
        reviewRevision: `rv1-${"c".repeat(64)}`,
      };
      const missing = projectReviewVerdict({
        repoRoot: root,
        request: strictRequest,
        attestation: attestation({
          provider: "claude",
          reviewRevision: strictRequest.reviewRevision,
          exitCode: 17,
        }),
        verdictFile: join(root, "missing-verdict.txt"),
      });
      expect(missing).toEqual({ ok: false, reason: "verdict_absent_after_provider_failure" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-003: 同一内容の receipt replay は content-addressed な1ファイルへ収束する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-replay-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const first = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      const replay = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      expect(first).toMatchObject({ ok: true });
      expect(replay).toMatchObject({ ok: true });
      expect(receiptFiles(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-004: receipt 内容が1バイトでも異なれば別 digest ファイルになる", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-digest-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const first = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      const changed = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation({ completedAt: "2026-07-31T01:05:00.001Z" }),
        verdictFile,
      });
      expect(first).toMatchObject({ ok: true });
      expect(changed).toMatchObject({ ok: true });
      expect(receiptFiles(root)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-005: review_lane role の --review-head 欠落は review_head_required で fail-close する", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runDelegation([
        "codex",
        "--role",
        "blind-reviewer",
        "--task",
        "review slice",
        "--review-pr",
        "731",
        "--review-revision",
        "review-rvatt-1",
      ]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("review_head_required");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("U-RVATT-006: attestation.head と PR observation.head が異なれば D1 は merge_ready にしない", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-head-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const issued = issueReviewRequest({ repoRoot: root, request: request() });
      const projected = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      expect(issued).toMatchObject({ ok: true });
      expect(projected).toMatchObject({ ok: true });
      if (!issued.ok || !projected.ok || !projected.receipt) return;
      const dispatch = analyzeReviewDispatch({
        requests: [issued.request],
        receipts: [projected.receipt],
        prs: [{ pr: 731, headSha: otherHead, state: "OPEN", checksGreen: true }],
        now: "2026-07-31T01:10:00.000Z",
      });
      expect(dispatch.entries[0].state).not.toBe("merge_ready");
      expect(dispatch.entries[0].progressDiagnostics).toContain("request_superseded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-007: verdict file 不在は verdict_file_missing で receipt を作らず D1 の SLA breach に残す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-missing-"));
    const verdictFile = join(root, "missing.verdict");
    try {
      const issued = issueReviewRequest({ repoRoot: root, request: request() });
      const projected = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      expect(issued).toMatchObject({ ok: true });
      expect(projected).toEqual({ ok: false, reason: "verdict_file_missing" });
      expect(receiptFiles(root)).toEqual([]);
      if (!issued.ok) return;
      const dispatch = analyzeReviewDispatch({
        requests: [issued.request],
        receipts: [],
        prs: [{ pr: 731, headSha: head, state: "OPEN", checksGreen: true }],
        now: "2026-07-31T02:01:00.000Z",
      });
      expect(dispatch.entries[0].breaches).toEqual(["verdict"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-008: verdict file に echo された契約があっても実 verdict を採用する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-echo-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, `${REVIEW_OUTPUT_CONTRACT}\n\nVERDICT: PASS\n`, "utf8");
      const result = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      expect(result).toMatchObject({
        ok: true,
        receipt: { verdict: "PASS", blockingFindings: [] },
      });
      expect(REVIEW_OUTPUT_CONTRACT).toContain("UT_TDD_REVIEW_VERDICT_FILE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-009: 発行 request は receipt と memoryId/pr/exactHead/reviewRevision を突合できる", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-request-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const issued = issueReviewRequest({ repoRoot: root, request: request() });
      const projected = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      expect(issued).toMatchObject({
        ok: true,
        request: {
          memoryId: "memory-rvatt",
          pr: 731,
          exactHead: head,
          reviewRevision: "review-rvatt-1",
        },
      });
      expect(projected).toMatchObject({
        ok: true,
        receipt: { memoryId: "memory-rvatt", pr: 731, head, reviewRevision: "review-rvatt-1" },
      });
      expect(readdirSync(join(root, ".ut-tdd", "review", "requests"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // U-RVATT-010〜012 は**輸送そのもの**を固定する。001〜009 は `verdictFile` を手渡しで
  // 与えているため、「harness が子プロセスへ注入した path」と「harness が読み戻す path」が
  // 同一である保証がどこにも無い。別名の env を注入しても全件緑になってしまう。
  // これは D3a で踏んだ producer/consumer 乖離と同型なので、単一の定数を根拠にした
  // round-trip フェンスを張る。
  it("U-RVATT-010: review_lane 委譲は consumer-derived repo-local path だけを子へ渡す", async () => {
    const reviewer = await runDelegation([
      "codex",
      "--role",
      "blind-reviewer",
      "--task",
      "review slice",
      "--review-pr",
      "731",
      "--review-head",
      head,
      "--review-revision",
      "review-rvatt-1",
      "--review-author-family",
      "claude",
    ]);
    const worker = await runDelegation(["codex", "--role", "be-api", "--task", "implement slice"]);
    const claudeReviewer = await runDelegation([
      "claude",
      "--role",
      "blind-reviewer",
      "--task",
      "review slice",
      "--review-pr",
      "731",
      "--review-head",
      head,
      "--review-revision",
      "review-rvatt-1",
      "--review-author-family",
      "codex",
    ]);
    expect(reviewer.stdout, "review_lane の dry-run が stdout へ何も出していない").not.toBe("");
    expect(worker.stdout, "worker の dry-run が stdout へ何も出していない").not.toBe("");
    const injected = JSON.parse(reviewer.stdout).env?.[REVIEW_VERDICT_FILE_ENV];
    expect(typeof injected).toBe("string");
    expect(injected.replaceAll("\\", "/")).toContain("/.ut-tdd/review/verdicts/");
    expect(injected.replaceAll("\\", "/")).toContain("/attempts/attempt-1/verdict.txt");
    expect(JSON.parse(worker.stdout).env?.[REVIEW_VERDICT_FILE_ENV]).toBeUndefined();
    const claudePlan = JSON.parse(claudeReviewer.stdout);
    const allowedToolsIndex = claudePlan.args.indexOf("--allowedTools");
    expect(allowedToolsIndex).toBeGreaterThanOrEqual(0);
    expect(claudePlan.args[allowedToolsIndex + 1]).toMatch(
      /^Edit\(\.ut-tdd\/review\/verdicts\/[a-f0-9]{64}\/attempts\/attempt-1\/verdict\.txt\)$/,
    );
    expect(JSON.parse(reviewer.stdout).args).not.toContain("--allowedTools");
    expect(JSON.parse(worker.stdout).args).not.toContain("--allowedTools");
  });

  // U-RVATT-013〜015 は **同族レビュー検出が発火可能であること**を守る。
  // 著者族を「レビュアー族の反対」と導出すると D1 の
  // `receipt.reviewerFamily === request.authorFamily` が恒偽になり、
  // 「Claude の成果物を Claude がレビューした」を永久に検出できない fail-open になる。
  it("U-RVATT-013: 著者族の解決は provider を参照せず、判別不能なら null を返す", () => {
    expect(resolveReviewAuthorFamily({ currentRuntime: "codex" })).toBe("codex");
    expect(resolveReviewAuthorFamily({ currentRuntime: "claude" })).toBe("claude");
    expect(resolveReviewAuthorFamily({ currentRuntime: null })).toBe(null);
    expect(resolveReviewAuthorFamily({ explicit: "codex", currentRuntime: "claude" })).toBe(
      "codex",
    );
    expect(resolveReviewAuthorFamily({ explicit: "bogus", currentRuntime: "claude" })).toBe(null);
  });

  it("U-RVATT-014: 同族 (claude 著者 / claude レビュアー) は merge_ready にならない", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-samefamily-"));
    const verdictFile = join(root, "reviewer.verdict");
    try {
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const sameFamilyRequest = { ...request(), authorFamily: "claude" as const };
      const issued = issueReviewRequest({ repoRoot: root, request: sameFamilyRequest });
      const projected = projectReviewVerdict({
        repoRoot: root,
        request: sameFamilyRequest,
        attestation: attestation({ provider: "claude" }),
        verdictFile,
      });
      expect(issued.ok).toBe(true);
      expect(projected).toMatchObject({ ok: true, receipt: { reviewerFamily: "claude" } });
      if (!issued.ok || !projected.ok) return;
      const dispatch = analyzeReviewDispatch({
        requests: [issued.request],
        receipts: [projected.receipt],
        prs: [{ pr: 731, headSha: head, state: "OPEN", checksGreen: true }],
        now: "2026-07-31T01:10:00.000Z",
      });
      expect(dispatch.entries[0].state).not.toBe("merge_ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-015: 著者族が判別できない review_lane 委譲は fail-close する", async () => {
    const runtimeKeys = ["CLAUDECODE", "CODEX_SANDBOX", "CODEX_HOME"];
    const saved = new Map(runtimeKeys.map((key) => [key, process.env[key]]));
    const priorExitCode = process.exitCode;
    for (const key of runtimeKeys) delete process.env[key];
    process.exitCode = undefined;
    try {
      const result = await runDelegation([
        "codex",
        "--role",
        "blind-reviewer",
        "--task",
        "review slice",
        "--review-pr",
        "731",
        "--review-head",
        head,
        "--review-revision",
        "review-rvatt-1",
      ]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("review_author_family_required");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("U-RVATT-017: repo 内 path を repo 外と判定しない (合成 path、実 repo を読まない)", () => {
    expect(isOutsideRepo("/repo", "/tmp/ut-tdd-review-x/verdict.txt")).toBe(true);
    expect(isOutsideRepo("/repo", "/repo/.ut-tdd/verdict.txt")).toBe(false);
    expect(isOutsideRepo("/repo", "/repo")).toBe(false);
    // prefix が一致するだけの兄弟 dir を repo 内と誤判定しないこと。
    expect(isOutsideRepo("/repo", "/repo-sibling/verdict.txt")).toBe(true);
  });

  // review_lane には qa / tl / uiux のように「まだ成果物が存在しない」委譲も含まれる。
  // 全 review lane に PR/HEAD を強制すると、テスト作成依頼のような正当な用法を壊す
  // (2026-07-31 の CI で実測: cli-surface の `--role reviewer` dry-run 2 件が fail-close した)。
  it("U-RVATT-018: 識別子なしの review_lane 委譲は fail-close しない", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runDelegation(["codex", "--role", "qa", "--task", "write red tests"]);
      expect(result.stderr).not.toContain("review_head_required");
      expect(result.stderr).not.toContain("review_author_family_required");
      expect(result.stdout, "識別子なしの review_lane 委譲が dry-run を出せていない").not.toBe("");
      expect(process.exitCode).toBe(undefined);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  // 「識別子を渡した = receipt を作る宣言」なら、receipt を作れない条件が揃った時に黙って
  // 捨ててはいけない。旧実装は review_lane でない role へ識別子を渡すと request が silent に
  // undefined になり、部分指定 fail-close の思想と矛盾していた (顧問 2 名が独立に指摘)。
  it("U-RVATT-019: review lane でない role への識別子指定は fail-close する", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runDelegation([
        "codex",
        "--role",
        "be-api",
        "--task",
        "implement slice",
        "--review-pr",
        "731",
        "--review-head",
        head,
        "--review-revision",
        "review-rvatt-1",
        "--review-author-family",
        "claude",
      ]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("review_identity_requires_review_lane");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("U-RVATT-016: dry-run は注入用 temp dir を残さない", async () => {
    const delegated = await runDelegation([
      "codex",
      "--role",
      "blind-reviewer",
      "--task",
      "review slice",
      "--review-pr",
      "731",
      "--review-head",
      head,
      "--review-revision",
      "review-rvatt-1",
      "--review-author-family",
      "claude",
    ]);
    expect(delegated.stdout, "review_lane の dry-run が stdout へ何も出していない").not.toBe("");
    const injected = JSON.parse(delegated.stdout).env[REVIEW_VERDICT_FILE_ENV] as string;
    // dry-run は attempt directory や verdict fileを作らない。既存の同一digest rootが
    // 別テストから残っていても、consumer-derived path自体へ新規書込みしないことを固定する。
    expect(existsSync(injected)).toBe(false);
    expect(injected.replaceAll("\\", "/")).toContain("/.ut-tdd/review/verdicts/");
  });

  // 識別子なしの review lane では verdict の読み手 (receipt 投影) が存在しない。この経路で
  // verdict temp dir を作ると、execute の後始末 (`input.review` 経由) に到達せず委譲のたびに
  // OS temp へ ut-tdd-review-* が積み上がる (PR #214 Codex FLAG)。dry-run JSON の env 注入が
  // 無いことを回帰フェンスにする — 生成と注入は reviewRequest と同一述語なので、注入が無い
  // ことは dir を作っていないことと等価 (単一述語の設計、delegation.ts 参照)。
  it("U-RVATT-020: 識別子なしの review lane は verdict file を生成も注入もしない", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("ut-tdd-review-"));
    const delegated = await runDelegation(["codex", "--role", "qa", "--task", "write red tests"]);
    expect(
      delegated.stdout,
      "識別子なし review lane の dry-run が stdout へ何も出していない",
    ).not.toBe("");
    const env = JSON.parse(delegated.stdout).env as Record<string, string> | undefined;
    expect(env?.[REVIEW_VERDICT_FILE_ENV]).toBeUndefined();
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("ut-tdd-review-"));
    // Parallel review suites may remove their own temp dir between these observations.
    // This oracle owns only the no-new-leak direction; foreign cleanup is not a regression.
    expect(after.filter((name) => !before.includes(name))).toEqual([]);
  });

  // --review-author-family も宣言入力。三識別子だけを宣言と数えると author-family 単独指定が
  // 「識別子なし委譲」として素通りし、値が黙って捨てられる (silent discard の禁止、
  // PR #214 precheck FLAG)。
  it("U-RVATT-022: --review-author-family 単独指定は識別子なし扱いで素通りせず fail-close する", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runDelegation([
        "codex",
        "--role",
        "qa",
        "--task",
        "write red tests",
        "--review-author-family",
        "bogus",
      ]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("review_head_required");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("U-RVATT-024: blank --review-memory-idを既定identityへsilent coercionしない", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runDelegation([
        "codex",
        "--role",
        "blind-reviewer",
        "--task",
        "review slice",
        "--review-pr",
        "731",
        "--review-head",
        head,
        "--review-revision",
        "review-rvatt-1",
        "--review-author-family",
        "claude",
        "--review-memory-id",
        "   ",
      ]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("review_memory_id_required");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  // requestedAt は retry のたびに変わる。digest に入れると同一レビュー要求の retry が別
  // request として併存し、D1 の duplicate_request_conflict を偶発させる (PR #214 Codex 指摘)。
  it("U-RVATT-021: 同一 identity の request 再発行は requestedAt が違っても同じ digest へ収束する", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-idem-"));
    try {
      const base = {
        memoryId: "review:731:head:rev",
        pr: 731,
        exactHead: head,
        reviewRevision: "review-rvatt-idem",
        authorFamily: "claude" as const,
      };
      const first = issueReviewRequest({
        repoRoot,
        request: { ...base, requestedAt: "2026-08-03T00:00:00.000Z" },
      });
      const second = issueReviewRequest({
        repoRoot,
        request: { ...base, requestedAt: "2026-08-03T01:23:45.678Z" },
      });
      if (!first.ok || !second.ok) throw new Error("request issuance failed");
      expect(second.digest).toBe(first.digest);
      expect(second.path).toBe(first.path);
      // 上書き後の本文は最新の requestedAt を保持する (metadata であって identity ではない)。
      expect(JSON.parse(readFileSync(first.path, "utf8")).requestedAt).toBe(
        "2026-08-03T01:23:45.678Z",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-RVATT-011: 契約テキストと reader は同一の env 定数を根拠にする", () => {
    expect(REVIEW_VERDICT_FILE_ENV).toBe("UT_TDD_REVIEW_VERDICT_FILE");
    expect(REVIEW_OUTPUT_CONTRACT).toContain(REVIEW_VERDICT_FILE_ENV);
  });

  it("U-RVATT-012: 注入された path をそのまま読み戻して receipt を作れる", async () => {
    const delegated = await runDelegation([
      "codex",
      "--role",
      "blind-reviewer",
      "--task",
      "review slice",
      "--review-pr",
      "731",
      "--review-head",
      head,
      "--review-revision",
      "review-rvatt-1",
      "--review-author-family",
      "claude",
    ]);
    expect(delegated.stdout, "review_lane の dry-run が stdout へ何も出していない").not.toBe("");
    const verdictFile = JSON.parse(delegated.stdout).env[REVIEW_VERDICT_FILE_ENV] as string;
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvatt-wire-"));
    try {
      // dry-run は temp dir を後始末する (execute 経路だけが子の実行中それを保持する)。
      // ここで確かめたいのは「注入された path 文字列を reader がそのまま受理する」ことなので、
      // 同じ path を作り直して読み戻す。
      mkdirSync(dirname(verdictFile), { recursive: true });
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      const result = projectReviewVerdict({
        repoRoot: root,
        request: request(),
        attestation: attestation(),
        verdictFile,
      });
      expect(result).toMatchObject({ ok: true, receipt: { verdict: "PASS" } });
      expect(receiptFiles(root)).toHaveLength(1);
    } finally {
      rmSync(verdictFile, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
