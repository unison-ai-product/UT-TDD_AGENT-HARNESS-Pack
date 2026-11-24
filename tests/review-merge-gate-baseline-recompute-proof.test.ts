import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkBaselineConflict } from "../src/feedback/baseline-conflict.ts";
import { CODE_SIZE_BASELINE_PATH } from "../src/lint/code-size.ts";
import { checkCodeSize } from "../src/lint/code-size-inputs.ts";
import {
  buildFixture,
  cleanFixture,
  createPreviewWorktree,
  type Fixture,
  injectedGate,
  removeFixturePreviewWorktree,
  runMerge,
  separatedFile,
  TARGET,
  verifyConflictAndCleanPreview,
} from "./fixtures/baseline-recompute-fixture.ts";
import { heavyAfterEach, heavyBeforeEach } from "./support/hook-bounds.ts";

const wrapperBaseline = '{\n  "src/alpha.ts": {"lines": null, "functionExcess": null}\n}\n';

let testFixture: Fixture | undefined;
let expectedTreeSha = "";

function currentFixture(): Fixture {
  if (!testFixture) throw new Error("U-RVMG-050 fixture prerequisite did not run");
  return testFixture;
}

function readLatestMergeResultReceipt(receiptPath: string | null): Record<string, unknown> {
  if (receiptPath === null) throw new Error("merge result receipt path is null");
  const receipts = readFileSync(receiptPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const receipt = receipts.at(-1);
  expect(receipt?.receiptKind).toBe("merge_result");
  return receipt ?? {};
}

heavyBeforeEach(["git", 420_000], () => {
  testFixture = buildFixture(
    {
      [TARGET]: separatedFile("const left = 1;", "const right = 1;"),
      [CODE_SIZE_BASELINE_PATH]: wrapperBaseline,
    },
    {
      pr: { [TARGET]: separatedFile("const left = 2;", "const right = 1;") },
      main: { [TARGET]: separatedFile("const left = 1;", "const right = 2;") },
    },
  );
  const fixture = currentFixture();
  expectedTreeSha = verifyConflictAndCleanPreview(fixture, [injectedGate(null)], (previewPath) => {
    expect(injectedGate(null).check(previewPath)).toMatchObject({ ok: true, findings: [] });
  });
  expect(expectedTreeSha).toMatch(/^[0-9a-f]{40,64}$/);

  const preview = createPreviewWorktree(fixture);
  try {
    expect(checkCodeSize(preview.path).ok).toBe(true);
  } finally {
    removeFixturePreviewWorktree(fixture, preview.path);
  }
  expect(() => checkBaselineConflict(fixture.work, fixture.headSha, { pr: 1559 })).not.toThrow();
});

heavyAfterEach("teardown", () => {
  const fixture = testFixture;
  testFixture = undefined;
  if (fixture) cleanFixture(fixture);
});

describe.sequential("review merge gate baseline recompute proof (Issue #1559)", {
  timeout: 420_000,
}, () => {
  it("U-RVMG-050: merge 後の tree 一致を記録し、merge 成功を維持する", () => {
    const run = runMerge(currentFixture(), false, undefined, () => expectedTreeSha);

    expect(run.result).toMatchObject({ ok: true, decision: "merge" });
    expect(run.merges).toBe(1);
    const receipt = readLatestMergeResultReceipt(run.result.receiptPath);
    expect(receipt.preview).toMatchObject({
      treeSha: expectedTreeSha,
      postMergeTreeSha: expectedTreeSha,
      treeMatch: true,
    });
  });

  it("U-RVMG-050: merge 後の tree 不一致を記録し、merge 成功を維持する", () => {
    const differentTreeSha = `${expectedTreeSha[0] === "0" ? "1" : "0"}${expectedTreeSha.slice(1)}`;
    const run = runMerge(currentFixture(), false, undefined, () => differentTreeSha);

    expect(run.result).toMatchObject({ ok: true, decision: "merge" });
    expect(run.merges).toBe(1);
    const receipt = readLatestMergeResultReceipt(run.result.receiptPath);
    expect(receipt.preview).toMatchObject({
      treeSha: expectedTreeSha,
      postMergeTreeSha: differentTreeSha,
      treeMatch: false,
    });
  });

  it("U-RVMG-050: merge 後の tree 読取例外は unknown として記録し、merge 成功を維持する", () => {
    const run = runMerge(currentFixture(), false, undefined, () => {
      throw new Error("injected merge tree read failure");
    });

    expect(run.result).toMatchObject({ ok: true, decision: "merge" });
    expect(run.merges).toBe(1);
    const receipt = readLatestMergeResultReceipt(run.result.receiptPath);
    expect(receipt.preview).toMatchObject({
      treeSha: expectedTreeSha,
      postMergeTreeSha: null,
      treeMatch: "unknown",
      postMergeTreeError: "injected merge tree read failure",
    });
  });
});
