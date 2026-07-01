import { describe, expect, it } from "vitest";
import { analyzeQualityText, renderQualityAudit } from "../src/audit/quality";

describe("quality audit", () => {
  it("classifies security gate, actionable hardcode, and telemetry debt markers", () => {
    const result = analyzeQualityText([
      {
        path: "src/demo.ts",
        text: [
          `const key = "sk-${"a".repeat(20)}";`,
          `const home = "C:\\Users\\dev\\project";`,
          `const base = "http://localhost:3000";`,
          `const model = "gpt-5-codex";`,
          "// TODO: remove compatibility branch",
        ].join("\n"),
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.byBucket.gate).toBe(1);
    expect(result.byBucket.actionable).toBe(3);
    expect(result.byBucket.telemetry).toBe(1);
    expect(result.byCode.secret_like_literal).toBe(1);
    expect(result.byCode.hardcoded_absolute_path).toBe(1);
    expect(renderQualityAudit(result)).toContain("quality audit:");
  });

  it("keeps clean source green", () => {
    const result = analyzeQualityText([
      { path: "src/clean.ts", text: "export const value = 1;\n" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
  });
});
