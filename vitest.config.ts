import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const assertionRequiredRunner = fileURLToPath(
  new URL("./tests/support/vitest-assertion-required-runner.mjs", import.meta.url),
);
const assertionRequiredExport = fileURLToPath(
  new URL("./tests/support/vitest-assertion-required-export.mjs", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^vitest$/, replacement: assertionRequiredExport }],
  },
  cacheDir: process.env.UT_TDD_VITEST_CACHE_DIR ?? "node_modules/.vite",
  test: {
    runner: assertionRequiredRunner,
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
