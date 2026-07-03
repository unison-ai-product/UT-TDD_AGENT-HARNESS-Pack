import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBranchProtectionPayload } from "../src/setup/branch-protection";
import {
  applyBranchProtection,
  buildCleanDistributionPlan,
  buildConsumerReadinessPlan,
  buildPackSyncPlan,
  cleanDistributionArtifactPath,
  cleanDistributionSourcePath,
  detectProjectScale,
  emitSetup,
  loadTemplates,
  type ProjectScale,
  planSetup,
  recommendPhase,
  recordSetupState,
  runSetup,
  type SetupDeps,
  type SetupState,
  transformCleanDistributionArtifact,
} from "../src/setup/index";
import { COMMON_FILES, type TemplateSet } from "../src/setup/templates";

/** in-memory file store + gh 呼び出し記録の mock deps (now 固定で決定論)。 */
function mockDeps(
  over: Partial<SetupDeps> = {},
): SetupDeps & { files: Map<string, string>; ghCalls: string[][] } {
  const files = new Map<string, string>();
  const ghCalls: string[][] = [];
  return {
    files,
    ghCalls,
    repoRoot: "/repo",
    now: () => "2026-06-02T00:00:00.000Z",
    gh: (args) => {
      ghCalls.push(args);
      return { ok: false, stdout: "" }; // 既定: gh 使えない
    },
    readText: (p) => files.get(p) ?? null,
    writeText: (p, c) => files.set(p, c),
    confirm: () => false,
    isInteractive: false,
    templates: {},
    ...over,
  };
}

const codeownersPath = join("/repo", ".github", "CODEOWNERS");
const statePath = join("/repo", ".ut-tdd", "state", "setup.json");

function walkRepoCandidatePaths(root: string): string[] {
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

/** org + 4 collaborators + protection あり + admin を返す gh mock。 */
const ghTeam = (args: string[]): { ok: boolean; stdout: string } => {
  const key = args.join(" ");
  if (key === "api repos/{owner}/{repo}")
    return {
      ok: true,
      stdout: JSON.stringify({ owner: { type: "Organization" }, permissions: { admin: true } }),
    };
  if (key === "api repos/{owner}/{repo}/collaborators")
    return { ok: true, stdout: JSON.stringify([{}, {}, {}, {}]) };
  if (key === "api repos/{owner}/{repo}/branches/main/protection")
    return { ok: true, stdout: "{}" };
  if (key === "auth status") return { ok: true, stdout: "logged in" };
  return { ok: false, stdout: "" };
};

const baseTemplates: TemplateSet = {
  "common/ut-tdd.mjs": "#!/usr/bin/env bun\n",
  "adapter/AGENTS.md": [
    "<!-- UT-TDD:managed:start -->",
    "# UT-TDD Agent Harness Adapter",
    "",
    "- Status: `ut-tdd status`",
    "- Doctor: `ut-tdd doctor`",
    "- Handover: `ut-tdd handover`",
    "<!-- UT-TDD:managed:end -->",
    "",
  ].join("\n"),
  "adapter/CLAUDE.md": [
    "<!-- UT-TDD:managed:start -->",
    "# UT-TDD Agent Harness Shared Context",
    "",
    "- `ut-tdd status`",
    "- `ut-tdd doctor`",
    "<!-- UT-TDD:managed:end -->",
    "",
  ].join("\n"),
  "adapter/.codex/config.toml": "[features]\nhooks = true\n",
  "adapter/.codex/hooks.json": '{"hooks":{"SessionStart":[]}}\n',
  "adapter/.claude/CLAUDE.md": [
    "<!-- UT-TDD:managed:start -->",
    "# Claude Runtime Adapter",
    "",
    "- `ut-tdd handover`",
    "<!-- UT-TDD:managed:end -->",
    "",
  ].join("\n"),
  "adapter/.claude/agents/ut-tdd-tl.md": "---\nname: ut-tdd-tl\n---\n",
  "adapter/.claude/commands/ut-tdd-status.md": "---\ndescription: Status\n---\n",
  "adapter/.claude/commands/ut-tdd-test.md": "---\ndescription: Test\n---\n",
  "adapter/.claude/settings.json": '{"hooks":{"SessionStart":[]}}\n',
  "common/harness-check.yml": "name: harness-check\n",
  "common/commitlint.config.js":
    "module.exports = { extends: ['@commitlint/config-conventional'] };\n",
  "common/escalation-stale.yml": "name: escalation-stale\n",
  "common/recovery.md": "# Recovery\n",
  "common/add-feature.md": "# Add-feature\n",
  "common/PULL_REQUEST_TEMPLATE.md": "## 概要\nCloses #\n",
  "team/CODEOWNERS": "* {{TL_TEAM}}\n/docs/ {{PO_TEAM}}\n/tests/ {{QA_TEAM}}\n",
  "team/setup-branch-protection.sh":
    "#!/usr/bin/env bash\ngh api -X PUT repos/{owner}/{repo}/branches/main/protection --input protection.json\n",
};

describe("setup solo/team (PLAN-L7-03 add-impl / U-SETUP)", () => {
  it("U-SETUP-001: detectProjectScale は never-throws / org 検出 / gh 失敗で unknown+null", () => {
    // org + collaborators + protection
    const org = mockDeps({ gh: ghTeam });
    const s = detectProjectScale(org);
    expect(s.ownerType).toBe("Organization");
    expect(s.collaborators).toBe(4);
    expect(s.hasBranchProtection).toBe(true);

    // gh 全失敗 (未認証/不在) → unknown / null、token 非読取、throw しない
    const down = mockDeps(); // 既定 gh = ok:false
    let scale: ProjectScale | undefined;
    expect(() => {
      scale = detectProjectScale(down);
    }).not.toThrow();
    expect(scale).toEqual({
      ownerType: "unknown",
      collaborators: null,
      hasCodeowners: false,
      hasBranchProtection: null,
    });

    // 既存 CODEOWNERS はローカル file で検出 (gh 不要)
    const local = mockDeps();
    local.files.set(codeownersPath, "* @team\n");
    expect(detectProjectScale(local).hasCodeowners).toBe(true);
  });

  it("U-SETUP-002: recommendPhase 純関数 / team・solo・fallback 信号", () => {
    const base: ProjectScale = {
      ownerType: "User",
      collaborators: 1,
      hasCodeowners: false,
      hasBranchProtection: false,
    };
    // team 信号
    expect(recommendPhase({ ...base, ownerType: "Organization" })).toMatchObject({
      phase: "0-B",
      confidence: "high",
    });
    expect(recommendPhase({ ...base, collaborators: 3 })).toMatchObject({ phase: "0-B" });
    expect(recommendPhase({ ...base, hasCodeowners: true })).toMatchObject({ phase: "0-B" });
    expect(recommendPhase({ ...base, hasBranchProtection: true })).toMatchObject({ phase: "0-B" });
    // solo (User + collaborators<=1)
    expect(recommendPhase(base)).toMatchObject({ phase: "0-A", confidence: "high" });
    // 不明信号 → solo low (安全フォールバック)
    expect(
      recommendPhase({
        ownerType: "unknown",
        collaborators: null,
        hasCodeowners: false,
        hasBranchProtection: null,
      }),
    ).toMatchObject({ phase: "0-A", confidence: "low" });
    // null 単独 (User だが collaborators 取得不可) → 0-B にしない
    expect(
      recommendPhase({
        ownerType: "User",
        collaborators: null,
        hasCodeowners: false,
        hasBranchProtection: null,
      }),
    ).toMatchObject({ phase: "0-A", confidence: "low" });
  });

  it("U-SETUP-003: planSetup 0-A=A のみ / 0-B=A+CODEOWNERS+bp script / teams 反映 / applied=false", () => {
    const solo = planSetup("0-A", { dryRun: false });
    expect(solo.files.every((f) => f.category === "A")).toBe(true);
    expect(solo.files.some((f) => f.path.endsWith("CODEOWNERS"))).toBe(false);
    expect(solo.actions).toEqual([]);

    const team = planSetup("0-B", {
      dryRun: false,
      teams: { tl: "@org/tl", qa: "@org/qa", po: "@org/po" },
    });
    expect(team.files.some((f) => f.path.endsWith("CODEOWNERS") && f.category === "B")).toBe(true);
    expect(team.files.some((f) => f.path.includes("setup-branch-protection.sh"))).toBe(true);
    // teams 名が CODEOWNERS GeneratedFile に反映
    const co = team.files.find((f) => f.path.endsWith("CODEOWNERS"));
    expect(co?.purpose).toContain("@org/tl");
    // action は宣言されるが applied=false (適用は別関数)
    expect(team.actions).toEqual([
      {
        kind: "branch-protection",
        script_path: join("scripts", "setup-branch-protection.sh"),
        applied: false,
      },
    ]);
  });

  it("U-SETUP-004: emitSetup dryRun 非書込 / 書込 / token 非埋込 / team 名 render", () => {
    // dryRun → 書かず path 一覧
    const dry = mockDeps({ templates: baseTemplates });
    const plan = planSetup("0-A", { dryRun: true });
    const paths = emitSetup(plan, baseTemplates, dry);
    expect(paths.length).toBe(plan.files.length);
    expect([...dry.files.keys()].length).toBe(0); // 何も書いていない

    // 書込
    const wet = mockDeps({ templates: baseTemplates });
    const teamPlan = planSetup("0-B", {
      dryRun: false,
      teams: { tl: "@org/tl-team", qa: "@org/qa-team", po: "@org/po-team" },
    });
    const written = emitSetup(teamPlan, baseTemplates, wet);
    expect(written).toContain(join(".github", "CODEOWNERS"));
    const co = wet.files.get(join("/repo", ".github", "CODEOWNERS")) as string;
    // team 名 render: プレースホルダ解決 / token 非含
    expect(co).toContain("@org/tl-team");
    expect(co).not.toContain("{{TL_TEAM}}");
    for (const v of wet.files.values()) {
      expect(v.toLowerCase()).not.toMatch(/(ghp_|github_pat_|token=|bearer )/);
    }
  });

  it("U-SETUP-004b: loadTemplates has built-in fallback for existing repos without harness docs", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-setup-existing-"));
    try {
      const templates = loadTemplates(repo);
      expect(templates["adapter/AGENTS.md"]).toContain("UT-TDD Agent Harness Adapter");
      expect(templates["common/harness-check.yml"]).toContain("harness-check");
      expect(templates["common/harness-check.yml"]).toContain("github guard");
      expect(templates["common/harness-check.yml"]).toContain("audit quality --include-tests");
      expect(templates["common/harness-check.yml"]).toContain("ut-tdd.mjs doctor --setup-smoke");
      expect(templates["team/CODEOWNERS"]).toContain("{{TL_TEAM}}");
      const deps = mockDeps({ repoRoot: repo, templates });
      const plan = planSetup("0-B", {
        dryRun: false,
        teams: { tl: "@org/tl", qa: "@org/qa", po: "@org/po" },
      });
      const written = emitSetup(plan, templates, deps);
      expect(written).toContain(join(".github", "CODEOWNERS"));
      expect(deps.files.get(join(repo, ".github", "CODEOWNERS"))).toContain("@org/tl");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-SETUP-004b2: source docs template keeps consumer harness-check guard strength", () => {
    const templates = loadTemplates(process.cwd());
    const workflow = templates["common/harness-check.yml"];
    expect(workflow).toContain("github guard");
    expect(workflow).toContain("bun run typecheck");
    expect(workflow).toContain("bun run test");
    expect(workflow).toContain("audit quality --include-tests");
    expect(workflow).toContain("ut-tdd.mjs doctor --setup-smoke");
  });

  it("U-SETUP-004c: built-in adapter templates ship enforced portable guard hooks", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-setup-templates-"));
    const templates = loadTemplates(repo);
    try {
      const claude = JSON.parse(templates["adapter/.claude/settings.json"]) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string; blockOnFailure?: boolean }[] }[]
        >;
      };
      const codex = JSON.parse(templates["adapter/.codex/hooks.json"]) as {
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string; blockOnFailure?: boolean }[] }[]
        >;
      };

      expect(claude.hooks.PreToolUse).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matcher: "Agent|Task",
            hooks: [
              expect.objectContaining({
                command: "bun .ut-tdd/bin/ut-tdd.mjs hook agent-guard",
                blockOnFailure: true,
              }),
            ],
          }),
          expect.objectContaining({
            matcher: "Edit|Write|MultiEdit",
            hooks: [
              expect.objectContaining({
                command: "bun .ut-tdd/bin/ut-tdd.mjs hook work-guard",
                blockOnFailure: true,
              }),
            ],
          }),
        ]),
      );
      expect(claude.hooks.SubagentStop[0].hooks[0].command).toBe(
        "bun .ut-tdd/bin/ut-tdd.mjs hook subagent-stop",
      );
      expect(codex.hooks.PreToolUse).toEqual(
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
      expect(templates["adapter/.claude/agents/pmo-sonnet.md"]).toContain(
        "model: claude-sonnet-4-6",
      );
      expect(templates["adapter/.claude/agents/pmo-haiku.md"]).toContain(
        "model: claude-haiku-4-5-20251001",
      );
      expect(templates["adapter/.claude/agents/pdm-tech-innovation.md"]).toContain(
        "model: claude-opus-4-7",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-SETUP-009: planSetup projects clean adapter templates for brownfield consumers", () => {
    const plan = planSetup("0-A", { dryRun: true });
    expect(plan.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md", category: "A" }),
        expect.objectContaining({ path: join(".ut-tdd", "bin", "ut-tdd.mjs"), category: "A" }),
        expect.objectContaining({ path: "CLAUDE.md", category: "A" }),
        expect.objectContaining({ path: join(".codex", "config.toml"), category: "A" }),
        expect.objectContaining({ path: join(".codex", "hooks.json"), category: "A" }),
        expect.objectContaining({ path: join(".claude", "CLAUDE.md"), category: "A" }),
        expect.objectContaining({
          path: join(".claude", "agents", "code-reviewer.md"),
          category: "A",
        }),
        expect.objectContaining({
          path: join(".claude", "agents", "qa-test.md"),
          category: "A",
        }),
        expect.objectContaining({
          path: join(".claude", "commands", "build.md"),
          category: "A",
        }),
        expect.objectContaining({
          path: join(".claude", "commands", "ut-tdd-status.md"),
          category: "A",
        }),
        expect.objectContaining({ path: join(".claude", "settings.json"), category: "A" }),
      ]),
    );

    const deps = mockDeps({ templates: baseTemplates });
    const preview = emitSetup(plan, baseTemplates, deps);
    expect(preview).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        join(".ut-tdd", "bin", "ut-tdd.mjs"),
        "CLAUDE.md",
        join(".codex", "hooks.json"),
        join(".claude", "CLAUDE.md"),
        join(".claude", "agents", "code-reviewer.md"),
        join(".claude", "commands", "build.md"),
      ]),
    );
    for (const p of preview) expect(p).not.toContain("UT-TDD-agent-harness");
  });

  it("U-SETUP-009b: built-in wrapper falls back to the setup Pack CLI", () => {
    const deps = mockDeps();
    const plan = planSetup("0-A", { dryRun: false });

    emitSetup(plan, {}, deps);

    const wrapper = deps.files.get(join("/repo", ".ut-tdd", "bin", "ut-tdd.mjs"));
    expect(wrapper).toContain('const setupSourceCli = "');
    expect(wrapper).toContain(
      'const repoLocalHarness = existsSync(repoLocalCli) && existsSync(join(repoRoot, "src", "setup", "index.ts"));',
    );
    expect(wrapper).toContain(
      "const sourceCli = repoLocalHarness ? repoLocalCli : setupSourceCli;",
    );
    expect(wrapper).toContain(
      'existsSync(localBin) ? localBin : existsSync(sourceCli) ? "bun" : "ut-tdd"',
    );
    expect(wrapper).toContain("[sourceCli, ...process.argv.slice(2)]");
    expect(wrapper).not.toContain("{{UT_TDD_SOURCE_CLI_JSON}}");

    const codexHooks = deps.files.get(join("/repo", ".codex", "hooks.json"));
    const claudeSettings = deps.files.get(join("/repo", ".claude", "settings.json"));
    expect(codexHooks).toContain("hook agent-guard");
    expect(claudeSettings).toContain("hook agent-guard");
    expect(() => JSON.parse(codexHooks ?? "")).not.toThrow();
    expect(() => JSON.parse(claudeSettings ?? "")).not.toThrow();
  });

  it("U-SETUP-009b2: generated wrapper prefers consumer local bin when local and setup fallback both exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-wrapper-local-"));
    try {
      const deps = mockDeps({ repoRoot: repo });
      const plan = planSetup("0-A", { dryRun: false });
      emitSetup(plan, {}, deps);
      const wrapper = deps.files.get(join(repo, ".ut-tdd", "bin", "ut-tdd.mjs"));
      expect(wrapper).toBeTruthy();

      const wrapperPath = join(repo, ".ut-tdd", "bin", "ut-tdd.mjs");
      const localBin = join(
        repo,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "ut-tdd.cmd" : "ut-tdd",
      );
      mkdirSync(join(repo, ".ut-tdd", "bin"), { recursive: true });
      mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
      writeFileSync(wrapperPath, wrapper ?? "");
      writeFileSync(
        localBin,
        process.platform === "win32"
          ? "@echo off\r\necho local-bin %*\r\nexit /b 0\r\n"
          : '#!/usr/bin/env sh\necho local-bin "$@"\n',
      );
      if (process.platform !== "win32") chmodSync(localBin, 0o755);

      const result = spawnSync(process.execPath, [wrapperPath, "status", "--json"], {
        cwd: repo,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("local-bin status --json");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-SETUP-009b3: generated wrapper falls back to setup Pack CLI through bun when local bin is absent", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-wrapper-source-"));
    try {
      const deps = mockDeps({ repoRoot: repo });
      const plan = planSetup("0-A", { dryRun: false });
      emitSetup(plan, {}, deps);
      const wrapper = deps.files.get(join(repo, ".ut-tdd", "bin", "ut-tdd.mjs"));
      expect(wrapper).toBeTruthy();

      const wrapperPath = join(repo, ".ut-tdd", "bin", "ut-tdd.mjs");
      mkdirSync(join(repo, ".ut-tdd", "bin"), { recursive: true });
      writeFileSync(wrapperPath, wrapper ?? "");

      const result = spawnSync(process.execPath, [wrapperPath, "status"], {
        cwd: repo,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("mode:");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-SETUP-010: emitSetup preserves consumer-owned adapter files and merges only managed blocks", () => {
    const deps = mockDeps({ templates: baseTemplates, confirm: () => false });
    deps.files.set(join("/repo", "AGENTS.md"), "# Consumer Rules\n\nKeep this line.\n");
    deps.files.set(join("/repo", ".claude", "settings.json"), '{"consumer":true}\n');
    const plan = planSetup("0-A", { dryRun: false });

    const written = emitSetup(plan, baseTemplates, deps);
    expect(written).toContain("AGENTS.md");
    expect(written).not.toContain(join(".claude", "settings.json"));

    const agents = deps.files.get(join("/repo", "AGENTS.md")) as string;
    expect(agents).toContain("# Consumer Rules\n\nKeep this line.\n");
    expect(agents).toContain("<!-- UT-TDD:managed:start -->");
    expect(agents).toContain("`ut-tdd doctor`");
    expect(deps.files.get(join("/repo", ".claude", "settings.json"))).toBe('{"consumer":true}\n');

    const beforeSecondRun = deps.files.get(join("/repo", "AGENTS.md"));
    emitSetup(plan, baseTemplates, deps);
    expect(deps.files.get(join("/repo", "AGENTS.md"))).toBe(beforeSecondRun);
  });

  it("U-SETUP-011: clean distribution plan excludes dogfood, UI, and runtime state", () => {
    const plan = buildCleanDistributionPlan({
      sourceTag: "v0.1.0",
      cleanRepo: "UNISON-TECHNOLOGY/clean",
      paths: [
        "README.md",
        "LICENSE",
        "package.json",
        "src/cli.ts",
        "src/setup/index.ts",
        ...COMMON_FILES.filter((entry) => entry.template.startsWith("adapter/")).map(
          (entry) => `docs/templates/${entry.template}`,
        ),
        "src/web/page.tsx",
        ".codex/hooks.json",
        ".claude/settings.json",
        "docs/governance/README.md",
        "docs/governance/ut-tdd-agent-harness-concept_v3.1.md",
        "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
        "skills/SKILL_MAP.md",
        "docs/governance/conditional-backfill-decision-audit-2026-06-22.md",
        "docs/governance/forward-convergence-legacy-debt-audit.md",
        "docs/governance/reverse-fullback-backprop-audit-2026-06-22.md",
        "docs/governance/runtime-parity-l0-l3-design-audit-2026-06-02.md",
        "docs/governance/ut-tdd-agent-harness-extraction-plan_v0.1.md",
        "docs/governance/future-release-audit-2026-06-30.md",
        "docs/governance/product-runtime-parity-check.md",
        "docs/governance/customer-extraction-plan.md",
        "docs/adr/ADR-005-distribution-model-and-central-ui.md",
        "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
        "docs/design/harness/L6-function-design/setup-solo-team.md",
        "docs/test-design/harness/L7-unit-test-design.md",
        ".ut-tdd/handover/CURRENT.json",
        ".ut-tdd/harness.db",
        ".ut-tdd/harness.db-wal",
      ],
    });

    expect(plan.ok).toBe(true);
    expect(plan.channel).toBe("clean-repo-plus-signed-tarball");
    expect(plan.artifactPaths).toContain("LICENSE");
    expect(plan.artifactPaths).toContain("docs/templates/adapter/AGENTS.md");
    expect(plan.artifactPaths).toContain("docs/templates/adapter/.codex/hooks.json");
    expect(plan.artifactPaths).toContain("docs/templates/adapter/.claude/agents/code-reviewer.md");
    expect(plan.artifactPaths).toContain("docs/templates/adapter/.claude/commands/build.md");
    expect(plan.artifactPaths).toContain("docs/templates/adapter/.claude/agents/ut-tdd-tl.md");
    expect(plan.artifactPaths).toContain("docs/governance/README.md");
    expect(plan.artifactPaths).toContain("docs/governance/ut-tdd-agent-harness-concept_v3.1.md");
    expect(plan.artifactPaths).toContain(
      "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
    );
    expect(cleanDistributionArtifactPath("skills/SKILL_MAP.md")).toBe("skills/SKILL_MAP.md");
    expect(plan.artifactPaths).toContain("skills/SKILL_MAP.md");
    expect(plan.artifactPaths).not.toContain("docs/skills/SKILL_MAP.md");
    expect(
      cleanDistributionSourcePath("skills/SKILL_MAP.md", ["README.md", "skills/SKILL_MAP.md"]),
    ).toBe("skills/SKILL_MAP.md");
    expect(
      cleanDistributionSourcePath(".github/workflows/harness-check.yml", [
        ".github/workflows/harness-check.yml",
        "docs/templates/github/common/pack-harness-check.yml",
      ]),
    ).toBe("docs/templates/github/common/pack-harness-check.yml");
    expect(plan.artifactPaths).not.toContain("src/web/page.tsx");
    expect(plan.artifactPaths).not.toContain(".codex/hooks.json");
    expect(plan.artifactPaths).not.toContain(".claude/settings.json");
    expect(plan.artifactPaths).not.toContain(
      "docs/governance/conditional-backfill-decision-audit-2026-06-22.md",
    );
    expect(plan.artifactPaths).not.toContain(
      "docs/governance/forward-convergence-legacy-debt-audit.md",
    );
    expect(plan.artifactPaths).not.toContain(
      "docs/governance/reverse-fullback-backprop-audit-2026-06-22.md",
    );
    expect(plan.artifactPaths).not.toContain(
      "docs/governance/runtime-parity-l0-l3-design-audit-2026-06-02.md",
    );
    expect(plan.artifactPaths).not.toContain(
      "docs/governance/ut-tdd-agent-harness-extraction-plan_v0.1.md",
    );
    expect(plan.artifactPaths).not.toContain("docs/governance/future-release-audit-2026-06-30.md");
    expect(plan.artifactPaths).not.toContain("docs/governance/product-runtime-parity-check.md");
    expect(plan.artifactPaths).not.toContain("docs/governance/customer-extraction-plan.md");
    expect(plan.artifactPaths).not.toContain(
      "docs/adr/ADR-005-distribution-model-and-central-ui.md",
    );
    expect(plan.artifactPaths).not.toContain("docs/plans/PLAN-L7-157-distribution-clean-pull.md");
    expect(plan.artifactPaths).not.toContain(
      "docs/design/harness/L6-function-design/setup-solo-team.md",
    );
    expect(plan.artifactPaths).not.toContain("docs/test-design/harness/L7-unit-test-design.md");
    expect(plan.artifactPaths).not.toContain(".ut-tdd/handover/CURRENT.json");
    expect(plan.artifactPaths).not.toContain(".ut-tdd/harness.db");
    expect(plan.artifactPaths).not.toContain(".ut-tdd/harness.db-wal");
    expect(plan.releaseIntegrity.artifacts).toEqual([
      "v0.1.0.tar.gz",
      "v0.1.0.tar.gz.sha256",
      "v0.1.0.tar.gz.sig",
    ]);
  });

  it("U-SETUP-011c: Pack sync plan is non-destructive and copies only clean artifacts", () => {
    const sourcePaths = [
      "README.md",
      "LICENSE",
      "package.json",
      "src/cli.ts",
      "src/setup/index.ts",
      ...COMMON_FILES.filter((entry) => entry.template.startsWith("adapter/")).map(
        (entry) => `docs/templates/${entry.template}`,
      ),
      "docs/governance/README.md",
      "docs/governance/ut-tdd-agent-harness-concept_v3.1.md",
      "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
      "docs/skills/SKILL_MAP.md",
      "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
      ".ut-tdd/harness.db",
    ];
    const exportPlan = buildCleanDistributionPlan({
      sourceTag: "v0.1.0",
      paths: sourcePaths,
    });
    const sync = buildPackSyncPlan({
      exportPlan,
      sourcePaths,
      stagingDir: "/tmp/ut-tdd-pack",
      branch: "main",
    });

    expect(sync.ok).toBe(true);
    expect(sync.mode).toBe("non-destructive-sync-plan");
    expect(sync.cleanRepo).toBe("unison-ai-product/UT-TDD_AGENT-HARNESS-Pack");
    expect(sync.publishRequiresPoApproval).toBe(true);
    expect(sync.destructiveRemoteMutation).toBe(false);
    expect(sync.copyPlan).toContainEqual({
      sourcePath: "docs/skills/SKILL_MAP.md",
      artifactPath: "skills/SKILL_MAP.md",
    });
    expect(sync.copyPlan.map((entry) => entry.artifactPath)).not.toContain(
      "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
    );
    expect(sync.copyPlan.map((entry) => entry.artifactPath)).not.toContain(".ut-tdd/harness.db");
    expect(sync.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "git clone https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack.git",
        ),
        expect.stringContaining("git -C /tmp/ut-tdd-pack status --short"),
        expect.stringContaining("git -C /tmp/ut-tdd-pack add -- "),
        expect.stringContaining("git -C /tmp/ut-tdd-pack push origin main --follow-tags"),
      ]),
    );
    expect(sync.commands.find((command) => command.includes(" add -- "))).toContain('"src/cli.ts"');
    expect(sync.commands.join("\n")).not.toContain(" add -- .");
    expect(sync.commands.join("\n")).not.toContain(" add --all");
    expect(sync.checks).toContain("denylistViolations.length === 0");
  });

  it("U-SETUP-011c2: source-only audit and design updates do not change Pack artifacts", () => {
    const sourcePaths = [
      ...walkRepoCandidatePaths(process.cwd()),
      ".ut-tdd/audit/A-local-only.md",
      "docs/plans/PLAN-L7-local-only.md",
      "docs/design/harness/L6-function-design/local-only.md",
      "docs/test-design/harness/L7-local-only.md",
      "docs/handover/session-local-only.md",
    ];
    const filteredSourcePaths = sourcePaths.filter(
      (path) =>
        !path.startsWith(".ut-tdd/") &&
        !path.startsWith("docs/plans/") &&
        !path.startsWith("docs/design/harness/") &&
        !path.startsWith("docs/test-design/") &&
        !path.startsWith("docs/handover/"),
    );

    const withSourceOnlyDocs = buildCleanDistributionPlan({
      sourceTag: "source-with-audit-docs",
      paths: sourcePaths,
    });
    const withoutSourceOnlyDocs = buildCleanDistributionPlan({
      sourceTag: "source-without-audit-docs",
      paths: filteredSourcePaths,
    });
    const syncWithSourceOnlyDocs = buildPackSyncPlan({
      exportPlan: withSourceOnlyDocs,
      sourcePaths,
      stagingDir: "/tmp/ut-tdd-pack",
      branch: "main",
    });
    const syncWithoutSourceOnlyDocs = buildPackSyncPlan({
      exportPlan: withoutSourceOnlyDocs,
      sourcePaths: filteredSourcePaths,
      stagingDir: "/tmp/ut-tdd-pack",
      branch: "main",
    });

    expect(withSourceOnlyDocs.ok).toBe(true);
    expect(withSourceOnlyDocs.artifactPaths).toEqual(withoutSourceOnlyDocs.artifactPaths);
    expect(syncWithSourceOnlyDocs.copyPlan.map((entry) => entry.artifactPath)).toEqual(
      syncWithoutSourceOnlyDocs.copyPlan.map((entry) => entry.artifactPath),
    );
    expect(withSourceOnlyDocs.excludedPaths).toEqual(
      expect.arrayContaining([
        ".ut-tdd/audit/A-local-only.md",
        "docs/plans/PLAN-L7-local-only.md",
        "docs/design/harness/L6-function-design/local-only.md",
        "docs/test-design/harness/L7-local-only.md",
        "docs/handover/session-local-only.md",
      ]),
    );
  });

  it("U-SETUP-011d: clean Pack package.json points test to Pack-safe smoke tests", () => {
    const transformed = JSON.parse(
      transformCleanDistributionArtifact(
        "package.json",
        JSON.stringify({
          name: "ut-tdd-agent-harness",
          scripts: {
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
        }),
      ),
    ) as { scripts: Record<string, string> };

    expect(transformed.scripts.test).toContain("tests/distribution-acceptance.test.ts");
    expect(transformed.scripts.test).toContain("tests/readability.test.ts");
    expect(transformed.scripts["test:pack"]).toBe(transformed.scripts.test);
    expect(transformed.scripts["test:source"]).toBe("vitest run");
    expect(transformed.scripts.typecheck).toBe("tsc --noEmit");
  });

  it("U-SETUP-011e: clean Pack workflow reuses the package test:pack script", () => {
    const transformed = transformCleanDistributionArtifact(
      ".github/workflows/harness-check.yml",
      readFileSync(
        join(process.cwd(), "docs", "templates", "github", "common", "pack-harness-check.yml"),
        "utf8",
      ),
    );

    expect(transformed).toContain("run: bun run test:pack");
    expect(transformed).not.toContain("tests/distribution-acceptance.test.ts");
  });

  it("U-SETUP-011b: real clean distribution artifact excludes dogfood governance audit documents", () => {
    const plan = buildCleanDistributionPlan({
      sourceTag: "v0.1.0",
      paths: walkRepoCandidatePaths(process.cwd()),
    });
    const dogfoodGovernanceDocs = [
      "docs/governance/conditional-backfill-decision-audit-2026-06-22.md",
      "docs/governance/forward-convergence-legacy-debt-audit.md",
      "docs/governance/reverse-fullback-backprop-audit-2026-06-22.md",
      "docs/governance/runtime-parity-l0-l3-design-audit-2026-06-02.md",
      "docs/governance/ut-tdd-agent-harness-extraction-plan_v0.1.md",
    ];
    const nonPackPrefixes = [
      "docs/adr/",
      "docs/design/",
      "docs/test-design/",
      "docs/plans/",
      ".ut-tdd/",
    ];
    const nonPackDbFiles = /\.(?:db|sqlite)(?:-|$|\.)/i;

    expect(plan.ok).toBe(true);
    expect(plan.cleanRepo).toBe("unison-ai-product/UT-TDD_AGENT-HARNESS-Pack");
    const sourcePaths = walkRepoCandidatePaths(process.cwd());
    for (const path of dogfoodGovernanceDocs) {
      expect(plan.artifactPaths).not.toContain(path);
      if (sourcePaths.includes(path)) expect(plan.excludedPaths).toContain(path);
    }
    expect(
      plan.artifactPaths.filter(
        (path) =>
          nonPackPrefixes.some((prefix) => path.startsWith(prefix)) || nonPackDbFiles.test(path),
      ),
    ).toEqual([]);

    const textArtifacts = plan.artifactPaths.filter((path) =>
      /\.(?:md|ts|json|toml|ya?ml|js|txt)$/.test(path),
    );
    const legacyRuntimeName = "he" + "lix";
    const legacyNamePattern = new RegExp(`\\b${legacyRuntimeName}\\b`, "i");
    const legacyNameHits = textArtifacts.filter((path) => {
      const sourcePath = cleanDistributionSourcePath(path, sourcePaths);
      return legacyNamePattern.test(readFileSync(join(process.cwd(), sourcePath), "utf8"));
    });
    expect(legacyNameHits).toEqual([]);
  });

  it("U-SETUP-012: consumer readiness covers preflight, rollback, contracts, CI, and monorepo root", () => {
    const ready = buildConsumerReadinessPlan({
      bunVersion: "1.3.2",
      hasGit: true,
      hasGh: false,
      hasUtTddCli: true,
      hasClaude: false,
      hasCodex: true,
      repoRoot: "/repo",
      packageRoot: "/repo/packages/app",
      tag: "v0.1.0",
    });

    expect(ready.ok).toBe(true);
    expect(ready.mode).toBe("codex-only");
    expect(ready.workspace.monorepo).toBe(true);
    expect(ready.checks.find((c) => c.name === "gh")).toMatchObject({ ok: false });
    expect(ready.checks.find((c) => c.name === "ut-tdd-cli")).toMatchObject({ ok: true });
    expect(ready.ci.requires).toContain("bun run test");
    expect(ready.rollback.backupRequired).toBe(true);
    expect(ready.rollback.managedPaths).toContain("AGENTS.md");
    expect(ready.rollback.managedPaths).toContain(".ut-tdd/bin/ut-tdd.mjs");
    expect(ready.rollback.managedPaths).toContain(".claude/agents/code-reviewer.md");
    expect(ready.rollback.managedPaths).toContain(".claude/commands/build.md");
    expect(ready.contracts.tagPin).toBe(
      "github:unison-ai-product/UT-TDD_AGENT-HARNESS-Pack#v0.1.0",
    );
    expect(ready.contracts.tagPin).toContain("#v0.1.0");
    expect(ready.contracts.stable).toContain("adapter managed markers");
    expect(ready.contracts.stable).toContain("project-local .ut-tdd/bin/ut-tdd.mjs wrapper");
    expect(ready.smokeScenarios).toEqual(
      expect.arrayContaining([
        "consumer CI -> harness-check green without repository secrets",
        "monorepo package root -> adapter paths remain repo-root scoped",
      ]),
    );

    const customRepo = buildConsumerReadinessPlan({
      bunVersion: "1.3.0",
      hasGit: true,
      hasGh: true,
      hasClaude: false,
      hasCodex: true,
      repoRoot: tmpdir(),
      tag: "v9.9.9",
      cleanRepo: "example/custom-pack",
    });
    expect(customRepo.contracts.tagPin).toBe("github:example/custom-pack#v9.9.9");

    const blocked = buildConsumerReadinessPlan({
      bunVersion: "1.2.9",
      hasGit: false,
      hasGh: false,
      hasUtTddCli: false,
      hasClaude: false,
      hasCodex: false,
      repoRoot: "/repo",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "bun>=1.3",
      "git",
      "gh",
      "ut-tdd-cli",
      "runtime-cli",
    ]);
    expect(blocked.checks.find((c) => c.name === "ut-tdd-cli")?.message).toContain(
      "Generated Claude/Codex hooks call `bun .ut-tdd/bin/ut-tdd.mjs ...`",
    );
    expect(blocked.checks.find((c) => c.name === "ut-tdd-cli")?.message).toContain(
      "Do not rely on a global `bun link`",
    );
    expect(blocked.checks.find((c) => c.name === "ut-tdd-cli")?.message).toContain(
      "Bun itself must still resolve",
    );
  });

  it("U-SETUP-005: recordSetupState signals 4 フィールド strip / 上書き / token 非含", () => {
    const deps = mockDeps();
    const dirty = {
      ownerType: "Organization",
      collaborators: 4,
      hasCodeowners: true,
      hasBranchProtection: true,
      token: "ghp_secret", // 混入を試みる余分フィールド
    } as unknown as ProjectScale;
    recordSetupState(
      { phase: "0-B", decidedAt: "2026-06-02T00:00:00.000Z", decidedBy: "confirm", signals: dirty },
      deps,
    );
    const stored = JSON.parse(deps.files.get(statePath) as string) as SetupState;
    expect(Object.keys(stored.signals).sort()).toEqual([
      "collaborators",
      "hasBranchProtection",
      "hasCodeowners",
      "ownerType",
    ]);
    expect(deps.files.get(statePath)).not.toContain("ghp_secret"); // 余分フィールド strip
    expect(stored.phase).toBe("0-B");

    // 再実行 (phase 変更) → 上書きで最新のみ
    recordSetupState(
      { phase: "0-A", decidedAt: "2026-06-03T00:00:00.000Z", decidedBy: "flag", signals: dirty },
      deps,
    );
    const re = JSON.parse(deps.files.get(statePath) as string) as SetupState;
    expect(re.phase).toBe("0-A"); // append でなく上書き
  });

  it("U-SETUP-006: applyBranchProtection emit-only 既定 / 非対話封鎖 / 非 admin", () => {
    const plan = planSetup("0-B", { dryRun: false });

    // apply≠true → emit-only、gh 呼ばれない
    const d1 = mockDeps({ isInteractive: true, gh: ghTeam });
    expect(applyBranchProtection(plan, d1, { apply: false })).toEqual({
      applied: false,
      reason: "emit-only",
    });
    expect(d1.ghCalls.length).toBe(0);

    // 非対話 + apply=true → non-interactive、gh 呼ばれない (ガバナンス封鎖)
    const d2 = mockDeps({ isInteractive: false, gh: ghTeam, confirm: () => true });
    expect(applyBranchProtection(plan, d2, { apply: true })).toEqual({
      applied: false,
      reason: "non-interactive",
    });
    expect(d2.ghCalls.length).toBe(0);

    // 対話 + 認証ありだが admin でない → not-admin
    const ghNoAdmin = (args: string[]) => {
      const key = args.join(" ");
      if (key === "auth status") return { ok: true, stdout: "" };
      if (key === "api repos/{owner}/{repo}")
        return { ok: true, stdout: JSON.stringify({ permissions: { admin: false } }) };
      return { ok: false, stdout: "" };
    };
    const d3 = mockDeps({ isInteractive: true, gh: ghNoAdmin, confirm: () => true });
    expect(applyBranchProtection(plan, d3, { apply: true })).toEqual({
      applied: false,
      reason: "not-admin",
    });

    const ghAdminCalls: string[][] = [];
    const ghAdmin = (args: string[]) => {
      ghAdminCalls.push(args);
      const key = args.join(" ");
      if (key === "auth status") return { ok: true, stdout: "" };
      if (key === "api repos/{owner}/{repo}")
        return { ok: true, stdout: JSON.stringify({ permissions: { admin: true } }) };
      if (
        key.startsWith(
          "api -X PUT repos/{owner}/{repo}/branches/main/protection -H Accept: application/vnd.github+json --input ",
        )
      )
        return { ok: true, stdout: "" };
      return { ok: false, stdout: "" };
    };
    const d4 = mockDeps({ isInteractive: true, gh: ghAdmin, confirm: () => true });
    expect(applyBranchProtection(plan, d4, { apply: true })).toEqual({
      applied: true,
      reason: "applied",
    });
    const applyCall = ghAdminCalls.at(-1) ?? [];
    expect(applyCall).toContain("--input");
    expect(applyCall).not.toContain("-F");
    expect(applyCall).not.toContain("-f");
    const payload = JSON.parse(
      Array.from(d4.files.entries()).find(([path]) =>
        path.endsWith(join(".ut-tdd", "tmp", "branch-protection.json")),
      )?.[1] ?? "{}",
    );
    expect(payload).toMatchObject({
      required_status_checks: { strict: true, checks: [{ context: "harness-check" }] },
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 1 },
      restrictions: null,
    });
    expect(payload).toEqual(buildBranchProtectionPayload());
  });

  it("U-SETUP-007: runSetup 優先順 (flag > confirm > fallback) + 非対話 apply 封鎖", () => {
    // ① フラグあり → フラグ値採用
    const f = mockDeps({ templates: baseTemplates, isInteractive: true });
    expect(
      runSetup(
        {
          phase: "0-B",
          dryRun: true,
          applyBranchProtection: false,
          teams: { tl: "@a", qa: "@b", po: "@c" },
        },
        f,
      ).phase,
    ).toBe("0-B");

    // ② フラグ無し + 対話 + confirm yes → 推奨 phase (ここでは org 検出 → 0-B)
    const c = mockDeps({
      templates: baseTemplates,
      isInteractive: true,
      gh: ghTeam,
      confirm: () => true,
    });
    expect(runSetup({ dryRun: true, applyBranchProtection: false }, c).phase).toBe("0-B");

    // ③ フラグ無し + 非対話 → 0-A fallback (record は本実行=dryRun:false でのみ起きる)
    const nb = mockDeps({ templates: baseTemplates, isInteractive: false, gh: ghTeam });
    const r3 = runSetup({ dryRun: false, applyBranchProtection: false }, nb);
    expect(r3.phase).toBe("0-A");
    expect(JSON.parse(nb.files.get(statePath) as string).decidedBy).toBe("fallback");

    // ④ apply=true + 非対話 → branchProtection.applied=false (本実行で precondition 評価)
    const a = mockDeps({ templates: baseTemplates, isInteractive: false, gh: ghTeam });
    const r4 = runSetup({ phase: "0-B", dryRun: false, applyBranchProtection: true }, a);
    expect(r4.branchProtection.applied).toBe(false);
    expect(r4.branchProtection.reason).toBe("non-interactive");
  });

  it("U-SETUP-008: dryRun=true は副作用ゼロ (state 非書込 / gh 非呼出 / branch protection 非適用)", () => {
    // dry-run は preview のみ。--apply-branch-protection を併用しても remote へ進まない。
    const d = mockDeps({
      templates: baseTemplates,
      isInteractive: true,
      gh: ghTeam,
      confirm: () => true,
    });
    const r = runSetup({ phase: "0-B", dryRun: true, applyBranchProtection: true }, d);
    // state SSoT を書かない
    expect(d.files.get(statePath)).toBeUndefined();
    // 生成物 (CODEOWNERS 等) も書かない (path 一覧は返るが file store は空)
    expect(d.files.get(codeownersPath)).toBeUndefined();
    expect(r.written.length).toBeGreaterThan(0); // preview は path を列挙する
    // detectProjectScale の read-only gh は許容するが、applyBranchProtection の
    // mutating 経路 (auth status / -X PUT) には決して入らない。
    expect(d.ghCalls).not.toContainEqual(["auth", "status"]);
    expect(d.ghCalls.some((call) => call.includes("PUT"))).toBe(false);
    // branch protection は dry-run 理由で skip
    expect(r.branchProtection).toEqual({ applied: false, reason: "dry-run" });
  });
});
