import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: process.env.UT_TDD_VITEST_CACHE_DIR ?? "node_modules/.vite",
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "coverage/**", ".git/**", "**/.ut-tdd/**"],
    testTimeout: 30_000,
    setupFiles: ["tests/windows-hide-setup.ts", "tests/claude-probe-fence-setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    coverage: {
      reporter: ["text", "html", "clover", "json-summary"],
    },
  },
});
