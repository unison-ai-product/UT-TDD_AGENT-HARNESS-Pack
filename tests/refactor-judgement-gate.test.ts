import { describe, expect, it } from "vitest";
import {
  evaluateRefactorJudgementGate,
  readPullRequestChanges,
} from "../src/feedback/refactor-judgement-gate.ts";
import type { ReviewDispatchEntry } from "../src/feedback/review-dispatch.ts";
import type { GitChange } from "../src/github/git-diff.ts";

function gateEntry(overrides: Record<string, unknown> = {}): ReviewDispatchEntry {
  return {
    memoryId: "memory-001",
    pr: 465,
    exactHead: "a".repeat(40),
    reviewRevision: "review-001",
    authorFamily: "claude",
    reviewerFamily: "codex",
    verdict: "PASS",
    state: "merge_ready",
    breaches: [],
    ageMinutes: 5,
    blocking: [],
    reasons: [],
    progressDiagnostics: [],
    ...overrides,
  } as ReviewDispatchEntry;
}

describe("refactor judgement gate candidates", () => {
  it("CANDIDATE-U-REFACTORGATE-062: docs/tests-only changes are not target", () => {
    expect(
      evaluateRefactorJudgementGate([{ kind: "modified", path: "docs/guide.md" }], [gateEntry()]),
    ).toEqual({ target: false, ok: true, reasons: [] });
    expect(
      evaluateRefactorJudgementGate(
        [
          { kind: "modified", path: "tests/sample.test.ts" },
          { kind: "added", path: "docs/test-design/sample.md" },
        ],
        [gateEntry()],
      ),
    ).toEqual({ target: false, ok: true, reasons: [] });
  });

  it.fails.each([
    { change: { kind: "modified" as const, path: "scripts/b.mjs" } },
    { change: { kind: "renamed" as const, from: "src/old.ts", path: "lib/new.ts" } },
  ])("CANDIDATE-U-REFACTORGATE-063: $change は実装対象", ({ change }) => {
    expect(evaluateRefactorJudgementGate([change], [gateEntry()])).toEqual({
      target: true,
      ok: false,
      reasons: ["refactor_judgement_missing"],
    });
  });

  it.fails("CANDIDATE-U-REFACTORGATE-064: adapter は PR files を paginate して PlanChange へ写す", () => {
    const files = [
      { filename: "src/a.ts", status: "added" },
      { filename: "src/b.ts", status: "removed" },
      { filename: "lib/c.ts", previous_filename: "src/c.ts", status: "renamed" },
      { filename: "src/d.ts", status: "modified" },
    ];
    let observed: unknown[] = [];
    const runGh = ((...args: unknown[]) => {
      observed = args;
      return JSON.stringify(files);
    }) as never;
    expect(readPullRequestChanges(465, runGh)).toEqual([
      { kind: "added", path: "src/a.ts" },
      { kind: "deleted", path: "src/b.ts" },
      { kind: "renamed", from: "src/c.ts", path: "lib/c.ts" },
      { kind: "modified", path: "src/d.ts" },
    ] satisfies GitChange[]);
    expect(observed[0]).toBe("gh");
    expect(observed[1]).toContain("api");
    expect(observed[1]).toContain("repos/{owner}/{repo}/pulls/465/files");
    expect(observed[1]).toContain("--paginate");
  });

  it.fails("CANDIDATE-U-REFACTORGATE-065: 3000 件で打ち切り一覧を拒否する", () => {
    const list = (count: number) =>
      JSON.stringify(
        Array.from({ length: count }, (_, index) => ({
          filename: `docs/${index}.md`,
          status: "modified",
        })),
      );
    expect(() => readPullRequestChanges(465, (() => list(3000)) as never)).toThrow(
      "file_list_truncated",
    );
  });

  it.fails("CANDIDATE-U-REFACTORGATE-065: 2999 件は完全一覧として受理する", () => {
    const list = (count: number) =>
      JSON.stringify(
        Array.from({ length: count }, (_, index) => ({
          filename: `docs/${index}.md`,
          status: "modified",
        })),
      );
    expect(readPullRequestChanges(465, (() => list(2999)) as never)).toHaveLength(2999);
  });

  it.fails.each([
    "{}",
    JSON.stringify([{ filename: 3, status: "modified" }]),
    JSON.stringify([{ filename: "src/a.ts" }]),
    JSON.stringify([{ filename: "src/a.ts", status: 1 }]),
    JSON.stringify([{ filename: "lib/a.ts", status: "renamed" }]),
    JSON.stringify([{ filename: "lib/a.ts", previous_filename: 2, status: "renamed" }]),
    JSON.stringify([{ filename: "lib/a.ts", previous_filename: "", status: "renamed" }]),
  ])("CANDIDATE-U-REFACTORGATE-066: 不正 response %j は invalid_response", (response) => {
    expect(() => readPullRequestChanges(465, (() => response) as never)).toThrow(
      "invalid_response",
    );
  });

  it.fails.each([
    "commit-ok",
    "none-ok",
    "not-applicable",
  ])("CANDIDATE-U-REFACTORGATE-067: %s は対象変更を許可する", (refactorJudgement) => {
    expect(
      evaluateRefactorJudgementGate(
        [{ kind: "modified", path: "src/a.ts" }],
        [gateEntry({ refactorJudgement })],
      ),
    ).toEqual({ target: true, ok: true, reasons: [] });
  });

  it.fails("CANDIDATE-U-REFACTORGATE-068: 判定欄なしは対象変更を拒否する", () => {
    expect(
      evaluateRefactorJudgementGate([{ kind: "modified", path: "src/a.ts" }], [gateEntry()]),
    ).toEqual({ target: true, ok: false, reasons: ["refactor_judgement_missing"] });
  });

  it.fails.each([
    "commit-tests-changed",
    "none-rejected",
  ])("CANDIDATE-U-REFACTORGATE-069: %s は PASS verdict でも拒否する", (refactorJudgement) => {
    expect(
      evaluateRefactorJudgementGate(
        [{ kind: "modified", path: "src/a.ts" }],
        [gateEntry({ refactorJudgement })],
      ),
    ).toEqual({
      target: true,
      ok: false,
      reasons: [`refactor_judgement_rejected:${refactorJudgement}`],
    });
  });

  it.fails("CANDIDATE-U-REFACTORGATE-070: exact HEAD の全 verdict entry を検査する", () => {
    expect(
      evaluateRefactorJudgementGate(
        [{ kind: "modified", path: "src/a.ts" }],
        [
          gateEntry({ refactorJudgement: "commit-ok" }),
          gateEntry({ refactorJudgement: undefined }),
        ],
      ),
    ).toEqual({ target: true, ok: false, reasons: ["refactor_judgement_missing"] });
  });

  it.fails("CANDIDATE-U-REFACTORGATE-071: verdict の無い entry は review gate に任せる", () => {
    expect(
      evaluateRefactorJudgementGate(
        [{ kind: "modified", path: "src/a.ts" }],
        [gateEntry({ verdict: undefined, refactorJudgement: undefined })],
      ),
    ).toEqual({ target: true, ok: true, reasons: [] });
  });

  it.fails("CANDIDATE-U-REFACTORGATE-072: 複数拒否理由を一意・昇順にする", () => {
    expect(
      evaluateRefactorJudgementGate(
        [{ kind: "modified", path: "src/a.ts" }],
        [
          gateEntry({ refactorJudgement: "none-rejected" }),
          gateEntry({ refactorJudgement: "commit-tests-changed" }),
          gateEntry({ refactorJudgement: "none-rejected" }),
        ],
      ),
    ).toEqual({
      target: true,
      ok: false,
      reasons: [
        "refactor_judgement_rejected:commit-tests-changed",
        "refactor_judgement_rejected:none-rejected",
      ],
    });
  });
});
