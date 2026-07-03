import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");
const legacyEnvPrefix = ["HE", "LIX"].join("");

function runCli(args: string[]) {
  return runCliIn(repoRoot, args);
}

function runCliIn(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "bun", cliPath, ...args], {
      cwd,
      encoding: "utf8",
      env,
    });
  }
  return spawnSync("bun", [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

function parseCliJson(run: ReturnType<typeof runCliIn>) {
  expect(run.status, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0);
  expect(run.stdout.trim(), `stderr:\n${run.stderr}`).not.toBe("");
  return JSON.parse(run.stdout);
}

function writeFakeProvider(binDir: string, name: "codex" | "claude"): string {
  const rawEnv = [legacyEnvPrefix, "ALLOW", "RAW", name.toUpperCase()].join("_");
  const reasonEnv = [legacyEnvPrefix, "RAW", name.toUpperCase(), "REASON"].join("_");
  if (process.platform === "win32") {
    const path = join(binDir, `${name}.cmd`);
    writeFileSync(
      path,
      [
        "@echo off",
        `echo noisy-${name}`,
        `echo raw=%${rawEnv}% > ${name}-env.txt`,
        `echo reason=%${reasonEnv}% >> ${name}-env.txt`,
        `echo effort=%CLAUDE_CODE_EFFORT_LEVEL% >> ${name}-env.txt`,
        `echo args=%* >> ${name}-env.txt`,
        "exit /b 0",
        "",
      ].join("\r\n"),
    );
    return path;
  }
  const path = join(binDir, name);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo noisy-${name}`,
      `printf "raw=%s\\nreason=%s\\neffort=%s\\nargs=%s\\n" "$${rawEnv}" "$${reasonEnv}" "$CLAUDE_CODE_EFFORT_LEVEL" "$*" > ${name}-env.txt`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function writeFakeUtTdd(binDir: string): string {
  if (process.platform === "win32") {
    const path = join(binDir, "ut-tdd.cmd");
    writeFileSync(path, "@echo off\r\necho ut-tdd 0.0.0\r\nexit /b 0\r\n", "utf8");
    return path;
  }
  const path = join(binDir, "ut-tdd");
  writeFileSync(path, "#!/bin/sh\necho ut-tdd 0.0.0\nexit 0\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  chmodSync(path, 0o755);
  return path;
}

describe("L7 CLI surface closure", () => {
  it("exposes plan complete as the completed handover lifecycle entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-plan-complete-"));
    try {
      const use = runCliIn(root, ["plan", "use", "PLAN-L7-04-handover-mechanism"]);
      expect(use.status).toBe(0);

      const complete = runCliIn(root, ["plan", "complete", "--dry-run"]);
      expect(complete.status).toBe(0);
      expect(complete.stdout).toContain("plan complete:");
      expect(complete.stdout).toContain("status=completed");
      expect(complete.stdout).toContain("(dry-run)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("exposes skill suggest as a JSON command surface", () => {
    const run = runCli(["skill", "suggest", "--plan", "PLAN-NO-SUCH", "--json"]);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([]);
  }, 15_000);

  it("exposes strict telemetry provenance as a doctor verification flag", () => {
    const run = runCli(["doctor", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--setup-smoke");
    expect(run.stdout).toContain("--strict-telemetry-provenance");
    expect(run.stdout).toContain("--strict-green-command-digest");
  }, 15_000);

  it("exposes Pack sync commands as first-class distribution surfaces", () => {
    const run = runCli(["distribution", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("sync-plan");
    expect(run.stdout).toContain("sync-stage");
    expect(run.stdout).toContain("sync-pack");
    expect(run.stdout).toContain("release-plan");
  }, 15_000);

  it("exposes feedback commands through the extracted registrar", () => {
    const help = runCli(["feedback", "--help"]);
    const classify = runCli(["feedback", "classify", "--text", "please review this regression"]);
    const payload = JSON.parse(classify.stdout);

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("list");
    expect(help.stdout).toContain("classify");
    expect(help.stdout).toContain("pending");
    expect(classify.status).toBe(0);
    expect(payload).toMatchObject({
      role: "pmo-haiku",
      text: "please review this regression",
    });
    expect(payload.output_schema.category).toContain("feedback");
  }, 15_000);

  it("exposes skill injection as a provider-neutral JSON manifest", () => {
    const run = runCli([
      "skill",
      "suggest",
      "--text",
      "refactor regression test",
      "--inject",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      plan_id: "text:refactor-regression-test",
      missing_skill_ids: [],
    });
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.entries.every((entry: { skill_path: string }) => entry.skill_path)).toBe(true);
    expect(payload.required_paths.length).toBeGreaterThan(0);
  }, 20_000);

  it("injects per-call model/effort overrides into adapter plans (PLAN-L7-255)", () => {
    const run = runCli([
      "codex",
      "--role",
      "reviewer",
      "--task",
      "mechanical ledger check",
      "--model",
      "gpt-5.3-codex-spark",
    ]);
    const payload = parseCliJson(run);
    expect(payload.dry_run).toBe(true);
    expect(payload.model).toBe("gpt-5.3-codex-spark");
    expect(payload.args).toEqual(["exec", "-m", "gpt-5.3-codex-spark", "-"]);
  }, 20_000);

  it("keeps claude runtime command dry-run registered through delegation helper", () => {
    const run = runCli([
      "claude",
      "--role",
      "reviewer",
      "--task",
      "mechanical ledger check",
      "--model",
      "claude-opus-4-8",
      "--effort",
      "xhigh",
    ]);
    const payload = parseCliJson(run);
    expect(payload).toMatchObject({
      provider: "claude",
      dry_run: true,
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(payload.args).toEqual([
      "--print",
      "--input-format",
      "text",
      "--model",
      "claude-opus-4-8",
      "--effort",
      "high",
    ]);
  }, 20_000);

  it("passes plan skill injection through task route adapter plans", () => {
    const sourcePlan = join(
      repoRoot,
      "docs",
      "plans",
      "PLAN-L7-135-dynamic-skill-injection-materialization.md",
    );
    if (!existsSync(sourcePlan)) return;

    const run = runCli([
      "task",
      "route",
      "--role",
      "se",
      "--plan",
      sourcePlan,
      "--mode",
      "codex-only",
      "--execute",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload.adapterPlan.context_injection.required_paths.length).toBeGreaterThan(0);
    expect(payload.adapterPlan.stdin).toContain("UT-TDD context injection:");
  }, 20_000);

  it("keeps proposal advisory lanes aligned with executable task routing", () => {
    const classify = runCli([
      "task",
      "classify",
      "--design-docs",
      "--json",
      "--text",
      "Rename a local docs helper and update README wording.",
    ]);
    const route = runCli([
      "task",
      "route",
      "--role",
      "se",
      "--primary",
      "codex",
      "--mode",
      "codex-only",
      "--json",
      "--text",
      "rename a field",
    ]);
    const classifyPayload = JSON.parse(classify.stdout);
    const routePayload = JSON.parse(route.stdout);

    expect(classify.status).toBe(0);
    expect(route.status).toBe(0);
    expect(classifyPayload.document_coverage.recommended_subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "T2-mini",
          model: "gpt-5.4-mini",
          parallel_slots: 4,
          closing_authority: false,
          ownership: expect.stringContaining("disjoint"),
        }),
        expect.objectContaining({
          tier: "T2-spark",
          model: "gpt-5.3-codex-spark",
          parallel_slots: 3,
          closing_authority: false,
          ownership: expect.stringContaining("disjoint"),
        }),
      ]),
    );
    expect(routePayload.decision).toMatchObject({
      role: "se",
      tier: "T2",
      model: "gpt-5.3-codex-spark",
      status: "ready",
    });
    expect(routePayload.decision.model).not.toBe("gpt-5.4-mini");
  }, 20_000);

  it("exposes upper-model advisor dry-runs for lower orchestrator models", () => {
    const run = runCli([
      "advisor",
      "--task",
      "review whether the release gate is safe to close",
      "--current-model",
      "claude-sonnet-4-6",
      "--mode",
      "hybrid",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      current_model_lower_than_advisor: true,
      adapterPlan: {
        provider: "claude",
        model: "claude-opus-4-8",
        effort: "high",
        dry_run: true,
      },
    });
    expect(payload.adapterPlan.stdin).toContain("upper-model advisor");
  }, 20_000);

  it("executes advisor through the selected upper Codex adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-advisor-exec-"));
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      const fakeCodex = writeFakeProvider(binDir, "codex");
      const currentPath = process.env.PATH ?? process.env.Path ?? "";
      const testPath = `${binDir}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
      const run = runCliIn(
        root,
        [
          "advisor",
          "--task",
          "advise on uncertain implementation close",
          "--provider",
          "codex",
          "--mode",
          "codex-only",
          "--execute",
          "--json",
        ],
        {
          ...process.env,
          PATH: testPath,
          Path: testPath,
          UT_TDD_CODEX_BIN: fakeCodex,
        },
      );
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("noisy-codex");
      expect(payload).toMatchObject({
        provider: "codex",
        model: "gpt-5.5",
        effort: "xhigh",
        adapterPlan: {
          provider: "codex",
          model: "gpt-5.5",
          dry_run: false,
          executed: true,
          exit_code: 0,
        },
      });
      const codexEnv = readFileSync(join(root, "codex-env.txt"), "utf8");
      expect(codexEnv).toContain("gpt-5.5");
      expect(codexEnv).toContain("args=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("exposes builder catalog as a JSON command surface", () => {
    const run = runCli(["builder", "catalog", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.commands.map((row: { command: string }) => row.command)).toContain(
      "ut-tdd builder catalog",
    );
  });

  it("fails review command closed unless the current uncommitted scope is explicit", () => {
    const run = runCli(["review", "--json"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("review requires --uncommitted");
  });

  it("emits a non-destructive cutover dry-run plan", () => {
    const run = runCli(["cutover", "--to", "staging", "--dry-run", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      mode: "dry-run",
      to: "staging",
      humanApprovalRequired: true,
    });
    expect(payload.checks).toContain("bun run src\\cli.ts doctor");
  });

  it("refuses cutover apply without a human-approved runbook", () => {
    const run = runCli(["cutover", "--to", "staging", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      mode: "requires-human-approval",
      humanApprovalRequired: true,
    });
    expect(run.stderr).toContain("explicit human-approved runbook");
  });

  it("exposes clean distribution planning with preflight, rollback, and contract metadata", () => {
    const binDir = mkdtempSync(join(tmpdir(), "ut-tdd-cli-dist-"));
    try {
      const fakeCodex = writeFakeProvider(binDir, "codex");
      writeFakeUtTdd(binDir);
      const run = runCliIn(repoRoot, ["distribution", "plan", "--tag", "v0.1.0", "--json"], {
        ...process.env,
        UT_TDD_CODEX_BIN: fakeCodex,
        PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      });
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        actualCutRequiresPoApproval: true,
        export: {
          ok: true,
          channel: "clean-repo-plus-signed-tarball",
          sourceTag: "v0.1.0",
          cleanRepo: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
        },
        readiness: {
          ok: true,
        },
      });
      expect(payload.export.artifactPaths).toContain("LICENSE");
      expect(payload.export.artifactPaths).not.toContain(
        "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
      );
      expect(payload.readiness.rollback.managedPaths).toContain("AGENTS.md");
      expect(payload.readiness.contracts.tagPin).toBe(
        "github:unison-ai-product/UT-TDD_AGENT-HARNESS-Pack#v0.1.0",
      );
      expect(payload.readiness.contracts.tagPin).toContain("#v0.1.0");
      expect(payload.readiness.ci.forkPullRequestSecrets).toBe("not-required");
    } finally {
      rmSync(join(repoRoot, "codex-env.txt"), { force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("creates a local clean distribution tarball and checksum without publishing", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-package-out-"));
    try {
      const run = runCliIn(repoRoot, [
        "distribution",
        "package",
        "--tag",
        "v0.1.0",
        "--out",
        outDir,
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        actualPublishRequiresPoApproval: true,
        artifacts: {
          signatureRequired: true,
          signatureCreated: false,
        },
        export: {
          ok: true,
          sourceTag: "v0.1.0",
        },
      });
      expect(existsSync(payload.artifacts.tarball)).toBe(true);
      expect(existsSync(payload.artifacts.checksum)).toBe(true);
      expect(existsSync(payload.artifacts.manifest)).toBe(true);
      expect(existsSync(payload.artifacts.signature)).toBe(false);
      expect(readFileSync(payload.artifacts.checksum, "utf8")).toContain("v0.1.0.tar.gz");
      const manifest = JSON.parse(readFileSync(payload.artifacts.manifest, "utf8"));
      expect(manifest.signatureCreated).toBe(false);
      expect(manifest.artifactCount).toBeGreaterThan(100);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("exposes a non-destructive Pack repository sync plan", () => {
    const run = runCliIn(repoRoot, [
      "distribution",
      "sync-plan",
      "--tag",
      "v0.1.0",
      "--staging-dir",
      "tmp-pack-stage",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      actualRemoteMutationRequiresPoApproval: true,
      sync: {
        mode: "non-destructive-sync-plan",
        cleanRepo: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
        sourceTag: "v0.1.0",
        branch: "main",
        publishRequiresPoApproval: true,
        destructiveRemoteMutation: false,
      },
    });
    expect(payload.sync.copyPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactPath: "skills/SKILL_MAP.md",
        }),
      ]),
    );
    expect(
      payload.sync.copyPlan.map((entry: { artifactPath: string }) => entry.artifactPath),
    ).not.toContain("docs/plans/PLAN-L7-157-distribution-clean-pull.md");
    expect(payload.sync.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "git clone https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack.git",
        ),
        expect.stringContaining("git -C "),
        expect.stringContaining("push origin main --follow-tags"),
      ]),
    );
  });

  it("materializes clean Pack artifacts into a local staging directory without publishing", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-pack-stage-"));
    try {
      const run = runCliIn(repoRoot, [
        "distribution",
        "sync-stage",
        "--tag",
        "v0.1.0",
        "--out",
        outDir,
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        stage: {
          outDir,
          destructiveRemoteMutation: false,
          actualRemoteMutationRequiresPoApproval: true,
          unmanagedExistingPaths: [],
          copyError: null,
        },
      });
      expect(existsSync(join(outDir, "skills", "SKILL_MAP.md"))).toBe(true);
      expect(existsSync(join(outDir, "docs", "templates", "adapter", "AGENTS.md"))).toBe(true);
      expect(existsSync(join(outDir, "docs", "templates", "adapter", ".codex", "hooks.json"))).toBe(
        true,
      );
      expect(
        existsSync(join(outDir, "docs", "plans", "PLAN-L7-157-distribution-clean-pull.md")),
      ).toBe(false);
      expect(existsSync(join(outDir, ".ut-tdd", "harness.db"))).toBe(false);
      expect(existsSync(payload.stage.manifest)).toBe(true);
      const manifest = JSON.parse(readFileSync(payload.stage.manifest, "utf8"));
      expect(manifest.stage.copiedArtifacts).toBeGreaterThan(100);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("updates a local Pack checkout and prunes non-Pack files only when requested", () => {
    const packDir = mkdtempSync(join(tmpdir(), "ut-tdd-pack-repo-"));
    let manifest: string | null = null;
    try {
      const stalePlan = join(packDir, "docs", "plans", "PLAN-L7-157-distribution-clean-pull.md");
      mkdirSync(join(packDir, "docs", "plans"), { recursive: true });
      writeFileSync(stalePlan, "dogfood plan should not ship\n", "utf8");

      const blocked = runCliIn(repoRoot, [
        "distribution",
        "sync-pack",
        "--tag",
        "v0.1.0",
        "--repo-dir",
        packDir,
        "--json",
      ]);
      const blockedPayload = JSON.parse(blocked.stdout);
      manifest = blockedPayload.pack.manifest;

      expect(blocked.status, blocked.stderr || blocked.stdout).toBe(1);
      expect(blockedPayload).toMatchObject({
        ok: false,
        pack: {
          repoDir: packDir,
          repoExists: true,
          pruneLocal: false,
          unmanagedExistingPaths: ["docs/plans/PLAN-L7-157-distribution-clean-pull.md"],
          localGitMutationExecuted: false,
          destructiveRemoteMutation: false,
          actualRemoteMutationRequiresPoApproval: true,
        },
      });
      expect(existsSync(stalePlan)).toBe(true);

      const pruned = runCliIn(repoRoot, [
        "distribution",
        "sync-pack",
        "--tag",
        "v0.1.0",
        "--repo-dir",
        packDir,
        "--prune-local",
        "--json",
      ]);
      const prunedPayload = JSON.parse(pruned.stdout);
      manifest = prunedPayload.pack.manifest;

      expect(pruned.status, pruned.stderr || pruned.stdout).toBe(0);
      expect(prunedPayload).toMatchObject({
        ok: true,
        pack: {
          repoDir: packDir,
          repoExists: true,
          pruneLocal: true,
          prunedPaths: ["docs/plans/PLAN-L7-157-distribution-clean-pull.md"],
          unmanagedExistingPaths: [],
          localGitMutationExecuted: false,
          destructiveRemoteMutation: false,
          actualRemoteMutationRequiresPoApproval: true,
        },
      });
      expect(existsSync(join(packDir, "skills", "SKILL_MAP.md"))).toBe(true);
      expect(existsSync(stalePlan)).toBe(false);
      expect(prunedPayload.pack.nextCommands).toEqual(
        expect.arrayContaining([
          expect.stringContaining("git -C "),
          expect.stringContaining(" add -- "),
          expect.stringContaining('"src/cli.ts"'),
          expect.stringContaining('commit -m "chore: sync clean pack v0.1.0"'),
          expect.stringContaining("push origin main"),
        ]),
      );
      expect(prunedPayload.pack.nextCommands.join("\n")).not.toContain("git add --all");
      expect(prunedPayload.pack.nextCommands.join("\n")).not.toContain(" add --all");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
      if (manifest) rmSync(manifest, { force: true });
    }
  }, 40_000);

  it("exposes non-destructive release publication planning", () => {
    const run = runCliIn(repoRoot, [
      "distribution",
      "release-plan",
      "--tag",
      "v0.1.0",
      "--repo",
      "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      tag: "v0.1.0",
      repo: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
      externalPublishRequiresApproval: true,
    });
    expect(payload.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("git tag -a v0.1.0"),
        expect.stringContaining("gh release create v0.1.0"),
      ]),
    );
  });

  it("exposes GitHub branch-type guard as a JSON command surface", () => {
    const body = join(tmpdir(), `ut-tdd-pr-body-${Date.now()}.md`);
    const commits = join(tmpdir(), `ut-tdd-commits-${Date.now()}.txt`);
    writeFileSync(body, "## Summary\nPatch only.\n", "utf8");
    writeFileSync(commits, "fix: patch production regression\n", "utf8");
    try {
      const run = runCliIn(repoRoot, [
        "github",
        "guard",
        "--head-ref",
        "hotfix/prod-regression",
        "--base-ref",
        "main",
        "--pr-title",
        "fix: patch production regression",
        "--pr-body-file",
        body,
        "--commit-file",
        commits,
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(1);
      expect(payload.ok).toBe(false);
      expect(payload.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "hotfix-postmortem-missing" })]),
      );
    } finally {
      rmSync(body, { force: true });
      rmSync(commits, { force: true });
    }
  });

  it("rejects team setup when CODEOWNERS team slugs are omitted", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-setup-no-teams-"));
    try {
      const run = runCliIn(repo, ["setup", "--team", "--dry-run"]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("--tl-team / --qa-team / --po-team");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("exposes telemetry scan as a JSON command surface without provider CLI execution", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-telemetry-"));
    try {
      const run = runCliIn(root, [
        "telemetry",
        "scan",
        "--claude-dir",
        join(root, "missing-claude"),
        "--codex-dir",
        join(root, "missing-codex"),
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(payload).toMatchObject({
        totalRuns: 0,
        claudeRuns: 0,
        codexRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(payload.claudeDir).toBe(join(root, "missing-claude"));
      expect(payload.codexDir).toBe(join(root, "missing-codex"));
      expect(run.stderr).not.toContain("claude");
      expect(run.stderr).not.toContain("codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes quality audit as a JSON command surface", () => {
    const run = runCli(["audit", "quality", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toHaveProperty("byBucket");
    expect(payload.byBucket).toHaveProperty("gate");
    expect(payload).toHaveProperty("byCode");
  }, 20_000);

  it("exposes roster list and check as JSON command surfaces", () => {
    const list = runCli(["roster", "list", "--json"]);
    const listed = JSON.parse(list.stdout);
    const check = runCli(["roster", "check", "--json"]);
    const checked = JSON.parse(check.stdout);

    expect(list.status).toBe(0);
    expect(listed.ok).toBe(true);
    expect(listed.count).toBeGreaterThanOrEqual(14);
    expect(listed.entries.map((entry: { id: string }) => entry.id)).toContain("pmo-sonnet");

    expect(check.status).toBe(0);
    expect(checked.ok).toBe(true);
    expect(checked.missingFromRoster).toEqual([]);
    expect(checked.nameMismatches).toEqual([]);
    expect(checked.allowlistedPresent).toBe(19);
    expect(checked.nonAllowlisted).toEqual([]);
  }, 20_000);

  it("exposes branch audit as a read-only JSON command surface", () => {
    const run = runCli(["branch", "audit", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toHaveProperty("byStatus");
    expect(payload.byStatus).toHaveProperty("delete-candidate");
    expect(Array.isArray(payload.rows)).toBe(true);
  }, 20_000);

  it("exposes team run as a shared Claude/Codex dry-run launch plan", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-team-"));
    try {
      const teamPath = join(root, "team.yaml");
      writeFileSync(
        teamPath,
        [
          "name: speed-team",
          "strategy: parallel",
          "max_parallel: 2",
          "members:",
          "  - role: se",
          "    engine: codex-se",
          "    task: implement slice A",
          "  - role: tl",
          "    engine: pmo-sonnet",
          "    task: review slice A",
          "",
        ].join("\n"),
      );

      const run = runCli(["team", "run", "--definition", teamPath, "--mode", "hybrid", "--json"]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        team: "speed-team",
        strategy: "parallel",
        dry_run: true,
      });
      expect(payload.members.map((member: { provider: string }) => member.provider)).toEqual([
        "codex",
        "claude",
      ]);
      expect(
        payload.members.map((member: { adapter: { command: string } }) => member.adapter.command),
      ).toEqual(["codex", "claude"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes team suggest as a deterministic launch policy surface", () => {
    const run = runCli([
      "team",
      "suggest",
      "--task",
      "production security schema migration",
      "--mode",
      "hybrid",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      should_launch: true,
      mode: "hybrid",
      difficulty: "critical",
      trigger: "risk",
    });
    expect(
      payload.definition.members.map((member: { provider?: string; role: string }) => member.role),
    ).toEqual(["se", "tl", "qa"]);
  });

  it("exposes proposal document coverage lanes as a parallel team suggestion", () => {
    const run = runCli([
      "team",
      "suggest",
      "--task",
      "Rename a local docs helper and update README wording.",
      "--mode",
      "hybrid",
      "--design-docs",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      should_launch: true,
      mode: "hybrid",
      trigger: "difficulty",
    });
    expect(payload.document_coverage.recommended_subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "T2-mini", parallel_slots: 4 }),
        expect.objectContaining({ tier: "T2-spark", parallel_slots: 3 }),
      ]),
    );
    expect(payload.definition).toMatchObject({
      name: "proposal-coverage-team",
      strategy: "parallel",
      max_parallel: 7,
    });
    expect(
      payload.definition.members.filter(
        (member: { model?: string }) => member.model === "gpt-5.4-mini",
      ),
    ).toHaveLength(4);
    expect(
      payload.definition.members.filter(
        (member: { model?: string }) => member.model === "gpt-5.3-codex-spark",
      ),
    ).toHaveLength(3);
    expect(
      payload.definition.members.some((member: { model?: string }) => member.model === "gpt-5.5"),
    ).toBe(false);
    expect(
      payload.definition.members.every((member: { ownership?: string }) => member.ownership),
    ).toBe(true);
  }, 20_000);

  it("executes team run through fake Claude/Codex adapters while keeping JSON machine-readable", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-team-exec-"));
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      const fakeCodex = writeFakeProvider(binDir, "codex");
      const fakeClaude = writeFakeProvider(binDir, "claude");
      const teamPath = join(root, "team.yaml");
      writeFileSync(
        teamPath,
        [
          "name: speed-team",
          "strategy: parallel",
          "max_parallel: 2",
          "members:",
          "  - role: se",
          "    engine: codex-se",
          "    task: implement slice A",
          "  - role: tl",
          "    engine: pmo-sonnet",
          "    task: review slice A",
          "",
        ].join("\n"),
      );

      const currentPath = process.env.PATH ?? process.env.Path ?? "";
      const testPath = `${binDir}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
      const env = {
        ...process.env,
        PATH: testPath,
        Path: testPath,
        UT_TDD_CODEX_BIN: fakeCodex,
        UT_TDD_CLAUDE_BIN: fakeClaude,
      };
      const run = runCliIn(
        root,
        ["team", "run", "--definition", teamPath, "--mode", "hybrid", "--execute", "--json"],
        env,
      );
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("noisy-codex");
      expect(run.stdout).not.toContain("noisy-claude");
      expect(payload).toMatchObject({
        ok: true,
        team: "speed-team",
        strategy: "parallel",
        dry_run: false,
      });
      expect(payload.executions.map((row: { status: string }) => row.status)).toEqual([
        "completed",
        "completed",
      ]);
      const slots = JSON.parse(
        readFileSync(join(root, ".ut-tdd", "state", "agent-slots.json"), "utf8"),
      );
      expect(slots).toHaveLength(2);
      expect(
        slots.every((slot: { slot_source: string }) => slot.slot_source === "team_runner"),
      ).toBe(true);
      expect(slots.every((slot: { released_at: string | null }) => slot.released_at !== null)).toBe(
        true,
      );
      expect(readFileSync(join(root, "codex-env.txt"), "utf8")).not.toContain("raw=1");
      expect(readFileSync(join(root, "codex-env.txt"), "utf8")).not.toContain(
        "reason=ut-tdd-runtime-adapter-wrapper",
      );
      expect(readFileSync(join(root, "claude-env.txt"), "utf8")).not.toContain("raw=1");
      expect(readFileSync(join(root, "claude-env.txt"), "utf8")).toContain("effort=high");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes codex adapter under --execute --json and reports dry_run:false honestly", () => {
    // 回帰: 旧実装は --execute --json で provider を起動せず dry_run:false の plan JSON だけ
    // 返していた (実行していないのに実行済みに見える機械判定の罠)。実行 + 正直な JSON を要求する。
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-adapter-exec-"));
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      const fakeCodex = writeFakeProvider(binDir, "codex");
      const fakeClaude = writeFakeProvider(binDir, "claude");
      const currentPath = process.env.PATH ?? process.env.Path ?? "";
      const testPath = `${binDir}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
      const env = {
        ...process.env,
        PATH: testPath,
        Path: testPath,
        UT_TDD_CODEX_BIN: fakeCodex,
        UT_TDD_CLAUDE_BIN: fakeClaude,
      };
      const run = runCliIn(
        root,
        ["codex", "--role", "se", "--task", "implement slice A", "--execute", "--json"],
        env,
      );

      // provider の stdout (noisy-codex) は fd2(stderr) へ逃がし、stdout は実行結果 JSON 専用に保つ。
      expect(run.stdout).not.toContain("noisy-codex");
      const payload = JSON.parse(run.stdout);
      expect(payload).toMatchObject({
        provider: "codex",
        executed: true,
        dry_run: false,
        exit_code: 0,
        // 正常終了は signal=null (signal 終了時のみ exit_code=null + signal 名が入る)。
        signal: null,
      });
      // provider が実際に起動した証跡 (env dump)。「実行せず JSON だけ」だと生成されない。
      expect(readFileSync(join(root, "codex-env.txt"), "utf8")).toContain("args=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
