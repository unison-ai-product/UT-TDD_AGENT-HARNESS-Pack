import { describe, expect, it } from "vitest";
import config from "../vitest.config.ts";

describe("U-TESTHYGIENE-001: vitest execution boundary", () => {
  it("pins test discovery, exclusions, and timeout", () => {
    const test = (
      config as {
        cacheDir?: string;
        test?: {
          include?: string[];
          exclude?: string[];
          testTimeout?: number;
          globalSetup?: string[];
        };
      }
    ).test;
    expect((config as { cacheDir?: string }).cacheDir).toBe(
      process.env.UT_TDD_VITEST_CACHE_DIR ?? "node_modules/.vite",
    );
    expect(test?.include).toEqual(["tests/**/*.test.ts"]);
    expect(test?.exclude).toEqual([
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".git/**",
      "**/.ut-tdd/**",
    ]);
    expect(test?.testTimeout).toBe(30_000);
    expect(test?.globalSetup).toEqual(["tests/global-setup.ts"]);
  });
});
