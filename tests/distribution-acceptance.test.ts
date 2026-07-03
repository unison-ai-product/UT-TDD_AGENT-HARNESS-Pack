import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCleanDistributionPlan,
  cleanDistributionSourcePath,
  transformCleanDistributionArtifact,
} from "../src/setup/index";

const repoRoot = process.cwd();

function walkCandidatePaths(root: string): string[] {
  const ignored = new Set([".git", "node_modules", "dist"]);
  const out: string[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel.replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

function runBun(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "bun", ...args], {
      cwd,
      encoding: "utf8",
      env,
      timeout: 300_000,
    });
  }
  return spawnSync("bun", args, { cwd, encoding: "utf8", env, timeout: 300_000 });
}

function runBareUtTdd(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "ut-tdd", ...args], {
      cwd,
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
  }
  return spawnSync("ut-tdd", args, { cwd, encoding: "utf8", env, timeout: 120_000 });
}

function writeFakeCodex(root: string): string {
  const binDir = join(root, ".fake-bin");
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const path = join(binDir, "codex.cmd");
    writeFileSync(path, "@echo off\r\necho codex 0.0.0\r\nexit /b 0\r\n", "utf8");
    return path;
  }
  const path = join(binDir, "codex");
  writeFileSync(path, "#!/bin/sh\necho codex 0.0.0\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  return path;
}

function writeLocalUtTddShim(root: string): string {
  const binDir = join(root, ".fake-bin");
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const path = join(binDir, "ut-tdd.cmd");
    writeFileSync(path, '@echo off\r\nbun "%~dp0..\\src\\cli.ts" %*\r\n', "utf8");
    return path;
  }
  const path = join(binDir, "ut-tdd");
  writeFileSync(path, '#!/bin/sh\nexec bun "$(dirname "$0")/../src/cli.ts" "$@"\n', {
    encoding: "utf8",
    mode: 0o755,
  });
  chmodSync(path, 0o755);
  return path;
}

function removeCleanRoot(root: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`cleanup warning: could not remove ${root}: ${String(error)}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

describe("clean distribution local acceptance smoke", () => {
  it("U-SETUP-013 / U-SETUP-014 / AT-DIST-001: clean artifact installs and exposes the same core CLI surfaces", () => {
    const plan = buildCleanDistributionPlan({
      paths: walkCandidatePaths(repoRoot),
      sourceTag: "v0.1.0",
    });
    expect(plan.ok).toBe(true);
    expect(plan.missingRequired).toEqual([]);
    expect(plan.denylistViolations).toEqual([]);

    const cleanRoot = mkdtempSync(join(tmpdir(), "ut-tdd-clean-acceptance-"));
    try {
      const sourcePaths = walkCandidatePaths(repoRoot);
      for (const rel of plan.artifactPaths) {
        const from = join(repoRoot, cleanDistributionSourcePath(rel, sourcePaths));
        const to = join(cleanRoot, rel);
        mkdirSync(dirname(to), { recursive: true });
        if (rel === "package.json") {
          writeFileSync(to, transformCleanDistributionArtifact(rel, readFileSync(from, "utf8")));
        } else {
          cpSync(from, to, { recursive: true });
        }
      }

      const fakeCodex = writeFakeCodex(cleanRoot);
      writeLocalUtTddShim(cleanRoot);
      const env = {
        ...process.env,
        UT_TDD_CODEX_BIN: fakeCodex,
        PATH: `${join(cleanRoot, ".fake-bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      };

      const install = runBun(cleanRoot, ["install", "--frozen-lockfile"], env);
      expect(install.status, install.stderr || install.stdout).toBe(0);
      const packPackageJson = JSON.parse(readFileSync(join(cleanRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      expect(packPackageJson.scripts.test).toContain("tests/distribution-acceptance.test.ts");
      expect(packPackageJson.scripts.test).toContain("tests/readability.test.ts");
      expect(packPackageJson.scripts["test:source"]).toBe("vitest run");

      const status = runBun(cleanRoot, ["src/cli.ts", "status", "--json"], env);
      expect(status.status, status.stderr || status.stdout).toBe(0);
      const statusJson = JSON.parse(status.stdout);
      expect(statusJson.availableRuntimes).toContain("codex");

      const bareStatus = runBareUtTdd(cleanRoot, ["status", "--json"], env);
      expect(bareStatus.status, bareStatus.stderr || bareStatus.stdout).toBe(0);
      expect(JSON.parse(bareStatus.stdout).availableRuntimes).toContain("codex");

      const codexHooks = JSON.parse(
        readFileSync(join(cleanRoot, "docs/templates/adapter/.codex/hooks.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string; blockOnFailure?: boolean }[] }[]
        >;
      };
      expect(codexHooks.hooks.PreToolUse).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matcher: "spawn_agent|spawn_agents_on_csv",
            hooks: [
              expect.objectContaining({
                command: "bun .ut-tdd/bin/ut-tdd.mjs hook agent-guard",
                blockOnFailure: true,
              }),
            ],
          }),
          expect.objectContaining({
            matcher: "apply_patch|write_file",
            hooks: [
              expect.objectContaining({
                command: "bun .ut-tdd/bin/ut-tdd.mjs hook work-guard",
                blockOnFailure: true,
              }),
            ],
          }),
        ]),
      );

      const distribution = runBun(
        cleanRoot,
        ["src/cli.ts", "distribution", "plan", "--tag", "v0.1.0", "--json"],
        env,
      );
      expect(distribution.status, distribution.stderr || distribution.stdout).toBe(0);
      const distributionJson = JSON.parse(distribution.stdout);
      expect(distributionJson).toMatchObject({
        ok: true,
        export: {
          ok: true,
          missingRequired: [],
          denylistViolations: [],
        },
        readiness: {
          ok: true,
        },
      });
      expect(distributionJson.export.artifactPaths).toContain("src/cli.ts");
      expect(distributionJson.export.artifactPaths).toContain("skills/SKILL_MAP.md");
      expect(distributionJson.export.artifactPaths).not.toContain("docs/skills/SKILL_MAP.md");
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.codex/hooks.json",
      );
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.claude/agents/ut-tdd-tl.md",
      );
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.claude/agents/code-reviewer.md",
      );
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.claude/agents/qa-test.md",
      );
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.claude/commands/build.md",
      );
      expect(distributionJson.export.artifactPaths).not.toContain(
        "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
      );
      // A-172 review B 項目: 参照ゼロの孤立旧構想 doc (v1.1) は clean 配布に載せない
      // (PLAN-RECOVERY-06 同時修正、allowlist から除外)。
      expect(distributionJson.export.artifactPaths).not.toContain(
        "docs/governance/ai-dev-team-concept_v1.1.md",
      );
      expect(distributionJson.export.artifactPaths).not.toContain(
        "docs/governance/ai-dev-team-operations_v1.1.md",
      );
      expect(distributionJson.actualCutRequiresPoApproval).toBe(true);

      const setup = runBun(cleanRoot, ["src/cli.ts", "setup", "--solo"], env);
      expect(setup.status, setup.stderr || setup.stdout).toBe(0);

      const wrapperHelp = runBun(cleanRoot, [".ut-tdd/bin/ut-tdd.mjs", "--help"], env);
      expect(wrapperHelp.status, wrapperHelp.stderr || wrapperHelp.stdout).toBe(0);
      expect(wrapperHelp.stdout).toContain("Usage: ut-tdd");

      const setupSmoke = runBun(
        cleanRoot,
        [".ut-tdd/bin/ut-tdd.mjs", "doctor", "--setup-smoke"],
        env,
      );
      expect(setupSmoke.status, setupSmoke.stderr || setupSmoke.stdout).toBe(0);
      expect(setupSmoke.stdout).toContain("doctor: setup-smoke - OK");

      const typecheck = runBun(cleanRoot, ["run", "typecheck"], env);
      expect(typecheck.status, typecheck.stderr || typecheck.stdout).toBe(0);
    } finally {
      removeCleanRoot(cleanRoot);
    }
  }, 420_000);
});
