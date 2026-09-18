import { describe, expect, it } from "vitest";
import {
  analyzeRefactorQaReleaseContracts,
  loadRefactorQaReleaseContractInput,
  type RefactorQaReleaseContractInput,
  refactorQaReleaseContractMessages,
} from "../src/vmodel/lint.ts";

const authoringSource = [
  "VMS-012",
  "VMS-013",
  "循環的複雑度 関数あたり15超",
  "重複コード率 5%超",
  "単体10分超",
  "直近3回中2回リグレッション",
  "振る舞い不変",
  "characterization test",
  "切り戻し",
  "ISO/IEC 25010",
  "Go/No-Go",
  "G01",
  "G08",
  "schedule --live",
  "review --status",
  "スモーク",
  "No-Go",
].join("\n");

const validInput = (): RefactorQaReleaseContractInput => ({
  authoringSource,
  refactorProcess: [
    "behavior-invariant",
    "assertRefactorInvariant",
    "test IDs",
    "Database-triggered Refactor",
    "vmodel-refactor-qa-release-gates.md",
  ].join("\n"),
  workflowContracts: [
    "assertRefactorInvariant",
    "input.before === input.after",
    "refactor-test-id-missing",
    "linked regression test ids",
  ].join("\n"),
});

describe("refactor / QA release contracts (U-REFACTOR-QA)", () => {
  it("U-REFACTOR-QA-001: ZIP108/109 authoring source, refactor process, and workflow contract pass together", () => {
    const result = analyzeRefactorQaReleaseContracts(validInput());
    expect(result.ok).toBe(true);
    expect(refactorQaReleaseContractMessages(result)[0]).toContain("OK");
  });

  it("U-REFACTOR-QA-002: QA Go/No-Go cannot be omitted from the authoring source", () => {
    const input = validInput();
    input.authoringSource = authoringSource.replace("Go/No-Go", "release check");
    const result = analyzeRefactorQaReleaseContracts(input);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        reason: "authoring-source-marker-missing",
        detail: "Go/No-Go",
      }),
    );
  });

  it("U-REFACTOR-QA-003: refactor process must point back to the V-model authoring source", () => {
    const input = validInput();
    input.refactorProcess =
      input.refactorProcess?.replace("vmodel-refactor-qa-release-gates.md", "local-note.md") ??
      null;
    const result = analyzeRefactorQaReleaseContracts(input);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        reason: "refactor-process-marker-missing",
        detail: "vmodel-refactor-qa-release-gates.md",
      }),
    );
  });

  it("U-REFACTOR-QA-004: real repo satisfies ZIP108/109 refactor and QA release contracts", () => {
    const result = analyzeRefactorQaReleaseContracts(loadRefactorQaReleaseContractInput());
    if (!result.ok) {
      throw new Error(JSON.stringify(result.violations, null, 2));
    }
    expect(result.ok).toBe(true);
  });
});
