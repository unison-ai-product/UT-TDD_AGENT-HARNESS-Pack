import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerDelegationCommands } from "../src/cli/delegation.ts";
import { analyzeReviewDispatch, type ReviewReceipt } from "../src/feedback/review-dispatch.ts";
import {
  extractVerdict,
  REVIEW_OUTPUT_CONTRACT,
  REVIEW_VERDICT_FILE_ENV,
  reviewOutputContractExample,
  type VerdictExtraction,
} from "../src/feedback/review-verdict-contract.ts";

// 期待値ビルダのみを共通化し、`expect` は各 test body に残す。
// `ddd-tdd-rules` の `test-oracle-strength` は AST で body 内の literal expect/assert を要求するため、
// assertion をヘルパへ括り出すと「oracle なし」と判定される (2026-07-31 の CI で実測: violation 7)。
function failure(reason: string): { ok: false; reasons: string[] } {
  return { ok: false, reasons: [reason] };
}

// `detectMode()` は codex/claude を **実 spawn (`--version` が exit 0 か)** して mode を決め、
// `buildAdapterPlan` は mode が codex-only / hybrid でなければ `plan.available=false` として
// **stdout へ何も出さず stderr へ落ちる**。したがって provider CLI が入っていない機械では
// dry-run JSON が空になり、この test file は「開発機だけで通る」状態になっていた。
// 2026-07-31 の CI で実測: U-RVCON-016 が linux/windows 両方で
// `SyntaxError: Unexpected end of JSON input` (= 空 stdout) で fail。
// 対策として exit 0 のスタブを `UT_TDD_CODEX_BIN` へ差し、mode を機械非依存に固定する
// (既存作法: tests/cli-surface.test.ts の `writeFakeProvider` / `UT_TDD_CODEX_BIN`)。
let stubBinDir: string | undefined;
const originalCodexBin = process.env.UT_TDD_CODEX_BIN;

beforeAll(() => {
  stubBinDir = mkdtempSync(join(tmpdir(), "ut-tdd-rvcon-bin-"));
  if (process.platform === "win32") {
    const stub = join(stubBinDir, "codex.cmd");
    writeFileSync(stub, "@echo off\r\necho codex 0.0.0-stub\r\nexit /b 0\r\n", "utf8");
    process.env.UT_TDD_CODEX_BIN = stub;
    return;
  }
  const stub = join(stubBinDir, "codex");
  writeFileSync(stub, "#!/bin/sh\necho codex 0.0.0-stub\nexit 0\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  chmodSync(stub, 0o755);
  process.env.UT_TDD_CODEX_BIN = stub;
});

afterAll(() => {
  if (originalCodexBin === undefined) delete process.env.UT_TDD_CODEX_BIN;
  else process.env.UT_TDD_CODEX_BIN = originalCodexBin;
  if (stubBinDir) rmSync(stubBinDir, { recursive: true, force: true });
});

function verdictReceipt(extraction: VerdictExtraction): ReviewReceipt {
  return {
    memoryId: "memory-rvcon",
    pr: 701,
    head: "a".repeat(40),
    reviewRevision: "revision-rvcon",
    reviewerFamily: "codex",
    kind: "verdict",
    verdict: extraction.verdict,
    blockingFindings: extraction.blockingFindings,
    at: "2026-07-31T00:03:00.000Z",
  };
}

function analyze(extraction: VerdictExtraction) {
  return analyzeReviewDispatch({
    requests: [
      {
        memoryId: "memory-rvcon",
        pr: 701,
        exactHead: "a".repeat(40),
        reviewRevision: "revision-rvcon",
        authorFamily: "claude",
        requestedAt: "2026-07-31T00:00:00.000Z",
      },
    ],
    receipts: [verdictReceipt(extraction)],
    prs: [{ pr: 701, headSha: "a".repeat(40), state: "OPEN", checksGreen: true }],
    now: "2026-07-31T00:10:00.000Z",
  });
}

async function dryRunTask(provider: "claude" | "codex", role: string): Promise<string> {
  const program = new Command();
  registerDelegationCommands(program, {
    gitBranch: () => "work/d3-verdict-receipt",
    gitHead: () => "a".repeat(40),
    resolveTaskText: (opts) => opts.task ?? null,
    resolveSkillContextInjection: () => undefined,
    runSessionStartSideEffects: () => {},
    taskFileOptionDescription: "read task text from file",
    writeHandoverWarnings: () => {},
  });
  let output = "";
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const reviewIdentity = role.startsWith("blind")
      ? [
          "--review-pr",
          "701",
          "--review-head",
          "a".repeat(40),
          "--review-revision",
          "contract-review-1",
          // 著者族は CLAUDECODE / CODEX_* から推定されるが、CI runner にはどちらも無い。
          // 環境依存を持ち込まないよう明示する (2026-07-31 の CI 事故と同型の予防)。
          "--review-author-family",
          "claude",
        ]
      : [];
    await program.parseAsync([
      "node",
      "ut-tdd",
      provider,
      "--role",
      role,
      "--task",
      "review task",
      ...reviewIdentity,
    ]);
  } finally {
    process.stdout.write = write;
  }
  // 空 stdout を `JSON.parse` に食わせると `Unexpected end of JSON input` になり、
  // 「provider が unavailable で dry-run が何も出していない」という真因が隠れる。
  // 診断可能な形で落とす (2026-07-31 の CI 赤の再発防止)。
  if (output.trim() === "") {
    throw new Error(
      `dry-run が stdout へ何も出力しなかった (provider=${provider} role=${role})。` +
        "plan.available=false の疑い: detectMode() の spawn probe が失敗している。",
    );
  }
  return JSON.parse(output).stdin as string;
}

describe("review verdict contract (U-RVCON)", () => {
  it("U-RVCON-001: 行頭 VERDICT: PASS を採用する", () => {
    expect(extractVerdict("VERDICT: PASS\n")).toEqual({
      ok: true,
      value: { verdict: "PASS", blockingFindings: [] },
    });
  });

  it("U-RVCON-002: PASS-WEAK をハイフンを保って採用する", () => {
    expect(extractVerdict("VERDICT: PASS-WEAK\n")).toEqual({
      ok: true,
      value: { verdict: "PASS-WEAK", blockingFindings: [] },
    });
  });

  it("U-RVCON-003: 依頼文中のインデント・箇条書き・引用を候補にせず実判定を採用する", () => {
    const log = [
      "依頼文の例:",
      "  VERDICT: PASS",
      "- Verdict: FLAG",
      "> VERDICT: FLAG",
      "VERDICT: PASS",
    ].join("\n");
    expect(extractVerdict(log)).toEqual({
      ok: true,
      value: { verdict: "PASS", blockingFindings: [] },
    });
  });

  it("U-RVCON-004: 行頭候補が無ければ verdict_absent で fail-close する", () => {
    expect(extractVerdict("Verdict: PASS\n  VERDICT: FLAG")).toEqual(failure("verdict_absent"));
  });

  it("U-RVCON-005: 異なる行頭候補は verdict_ambiguous で fail-close する", () => {
    expect(extractVerdict("VERDICT: PASS\nVERDICT: FLAG")).toEqual(failure("verdict_ambiguous"));
  });

  it("U-RVCON-006: 同値の行頭候補3件は冪等な再掲として採用する", () => {
    expect(extractVerdict("VERDICT: PASS\nVERDICT: PASS\nVERDICT: PASS")).toEqual({
      ok: true,
      value: { verdict: "PASS", blockingFindings: [] },
    });
  });

  it("U-RVCON-007: 未知の verdict は verdict_unknown で fail-close する", () => {
    expect(extractVerdict("VERDICT: MAYBE")).toEqual(failure("verdict_unknown"));
  });

  it("U-RVCON-008: FLAG 後の行頭 FINDING を順序を保って全件抽出する", () => {
    expect(
      extractVerdict("VERDICT: FLAG\nFINDING: first\nFINDING: second\nFINDING: third"),
    ).toEqual({
      ok: true,
      value: { verdict: "FLAG", blockingFindings: ["first", "second", "third"] },
    });
  });

  it("U-RVCON-009: finding の無い FLAG は flag_without_findings で fail-close する", () => {
    expect(extractVerdict("VERDICT: FLAG")).toEqual(failure("flag_without_findings"));
  });

  it("U-RVCON-010: 空白だけの FINDING は数えず FLAG を fail-close する", () => {
    expect(extractVerdict("VERDICT: FLAG\nFINDING:   ")).toEqual(failure("flag_without_findings"));
  });

  it("U-RVCON-011: 最後の VERDICT より前の FINDING は抽出せず fail-close する", () => {
    expect(extractVerdict("FINDING: stale request text\nVERDICT: FLAG")).toEqual(
      failure("flag_without_findings"),
    );
  });

  it("U-RVCON-012: PASS 上の FINDING は findings_on_pass で fail-close する", () => {
    expect(extractVerdict("VERDICT: PASS\nFINDING: must not be present")).toEqual(
      failure("findings_on_pass"),
    );
  });

  it("U-RVCON-013: finding 本文の前後空白を trim する", () => {
    expect(extractVerdict("VERDICT: FLAG\nFINDING:  contract mismatch  ")).toEqual({
      ok: true,
      value: { verdict: "FLAG", blockingFindings: ["contract mismatch"] },
    });
  });

  it("U-RVCON-014: D1 dispatch では FLAG は merge_ready にならず PASS はなる", () => {
    const flagged = extractVerdict("VERDICT: FLAG\nFINDING: contract mismatch");
    const passed = extractVerdict("VERDICT: PASS");
    expect(flagged.ok).toBe(true);
    expect(passed.ok).toBe(true);
    if (!flagged.ok || !passed.ok) return;
    expect(analyze(flagged.value).entries[0].state).not.toBe("merge_ready");
    expect(analyze(passed.value).entries[0].state).toBe("merge_ready");
  });

  it("U-RVCON-015: output contract の模範出力を parser が受理する", () => {
    expect(REVIEW_OUTPUT_CONTRACT).toContain("VERDICT: PASS");
    expect(REVIEW_OUTPUT_CONTRACT).toContain("VERDICT: PASS-WEAK");
    expect(REVIEW_OUTPUT_CONTRACT).toContain("VERDICT: FLAG");
    expect(REVIEW_OUTPUT_CONTRACT).toContain("FINDING:");
    expect(extractVerdict("VERDICT: FLAG\nFINDING: blocking example")).toEqual({
      ok: true,
      value: { verdict: "FLAG", blockingFindings: ["blocking example"] },
    });
    expect(extractVerdict(reviewOutputContractExample())).toEqual({
      ok: true,
      value: { verdict: "FLAG", blockingFindings: ["blocking finding summary"] },
    });
  });

  it("U-RVCON-016: 判断ゲート role だけに output contract を注入する", async () => {
    // identity 宣言のある review lane では書き出し先が literal path で埋め込まれるため、
    // 契約全文の定数一致では比較できない (U-RVATT-029)。role による注入の有無という
    // 本来の不変条件は、path に依存しない契約冒頭行で見る。
    const invariant = REVIEW_OUTPUT_CONTRACT.split("\n")[0];
    const gate = await dryRunTask("codex", "blind-reviewer");
    expect(gate).toContain(invariant);
    // env を読めない reviewer のために literal path が入っていること。
    expect(gate).toContain(`環境変数 ${REVIEW_VERDICT_FILE_ENV} と同値です`);
    expect(gate).toMatch(/verdict\.txt/);
    await expect(dryRunTask("codex", "be-api")).resolves.not.toContain(invariant);
  });

  // 委譲した task text は provider の captured log へ**行頭のまま echo される** (2026-07-31 実測)。
  // 契約の模範出力を行頭 `VERDICT:` で書くと、echo された値と実判定の 2 値が並び PASS が
  // verdict_ambiguous で恒久 fail-close する (FLAG は同値なので通る = 非対称な破壊)。
  it("U-RVCON-017: 契約が prompt echo されたログでも実判定 PASS を採用する", () => {
    const log = [REVIEW_OUTPUT_CONTRACT, "", "レビュー結果:", "VERDICT: PASS"].join("\n");
    expect(extractVerdict(log)).toEqual({
      ok: true,
      value: { verdict: "PASS", blockingFindings: [] },
    });
  });

  it("U-RVCON-018: 契約 echo 下の FLAG は模範 finding を拾わず実 finding だけを返す", () => {
    const log = [
      REVIEW_OUTPUT_CONTRACT,
      "",
      "レビュー結果:",
      "VERDICT: FLAG",
      "FINDING: 実際の blocking finding",
    ].join("\n");
    expect(extractVerdict(log)).toEqual({
      ok: true,
      value: { verdict: "FLAG", blockingFindings: ["実際の blocking finding"] },
    });
  });

  it("U-RVCON-019: 契約の模範ブロックは行頭 VERDICT/FINDING を含まない", () => {
    const lines = REVIEW_OUTPUT_CONTRACT.split("\n");
    expect(lines.filter((line) => /^VERDICT:/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^FINDING:/.test(line))).toEqual([]);
    // それでも dedent 後は parser が受理する = round-trip は維持されている。
    expect(extractVerdict(reviewOutputContractExample()).ok).toBe(true);
  });
});
