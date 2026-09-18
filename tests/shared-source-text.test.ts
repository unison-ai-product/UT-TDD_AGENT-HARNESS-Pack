import { describe, expect, it } from "vitest";
import { normalizePath as lintNormalizePath } from "../src/lint/shared.ts";
import { normalizePath } from "../src/shared/source-text.ts";

describe("source text shared contract", () => {
  it("U-DOMAIN-001: normalizes Windows separators through the neutral shared boundary", () => {
    expect(normalizePath("src\\state-db\\projection-writer.ts")).toBe(
      "src/state-db/projection-writer.ts",
    );
    expect(lintNormalizePath).toBe(normalizePath);
  });
});
