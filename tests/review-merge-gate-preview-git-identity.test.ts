import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkBaselineConflictWithPreview } from "../src/feedback/baseline-conflict.ts";
import {
  buildFixture,
  canonicalPath,
  cleanFixture,
  injectedGate,
  smallFiles,
  worktreePaths,
} from "./fixtures/baseline-recompute-fixture.ts";

describe.sequential("baseline preview Git identity", { timeout: 240_000 }, () => {
  it("U-RVMG-050: identityなしでもpreviewを作りcaller configを変更しない", () => {
    const small = smallFiles();
    const fixture = buildFixture(small.base, small.branches);
    const globalConfigPath = join(fixture.base, "isolated-global.gitconfig");
    const configPath = join(fixture.work, ".git", "config");
    try {
      for (const args of [
        ["config", "--local", "--unset-all", "user.name"],
        ["config", "--local", "--unset-all", "user.email"],
        ["config", "--local", "user.useConfigOnly", "true"],
      ]) {
        execFileSync("git", ["-C", fixture.work, ...args], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }

      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfigPath);
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      for (const key of [
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
        "EMAIL",
      ]) {
        vi.stubEnv(key, undefined);
      }

      for (const identity of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
        expect(() =>
          execFileSync("git", ["-C", fixture.work, "var", identity], {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        ).toThrow();
      }

      expect(existsSync(globalConfigPath)).toBe(false);
      const configBefore = readFileSync(configPath);
      const calls: string[] = [];
      const result = checkBaselineConflictWithPreview(fixture.work, fixture.headSha, {
        pr: 1559,
        gates: [injectedGate(null, { calls })],
      });
      expect(result.reason).toBeNull();
      expect(result.preview?.gates).toEqual([{ name: "fixture-gate", ok: true, findings: [] }]);
      expect(calls).toEqual(["fixture-gate"]);
      expect(readFileSync(configPath)).toEqual(configBefore);
      expect(existsSync(globalConfigPath)).toBe(false);
      expect(worktreePaths(fixture.work).map(canonicalPath).sort()).toEqual(
        fixture.initialWorktreePaths.map(canonicalPath).sort(),
      );
    } finally {
      vi.unstubAllEnvs();
      cleanFixture(fixture);
    }
  });
});
