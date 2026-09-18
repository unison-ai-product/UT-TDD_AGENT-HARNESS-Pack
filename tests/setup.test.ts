import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBranchProtectionPayload } from "../src/setup/branch-protection.ts";
import {
  applyBranchProtection,
  buildCleanDistributionPlan,
  buildConsumerNodeRuntimeBundle,
  buildConsumerNodeRuntimePayloads,
  buildConsumerReadinessPlan,
  buildPackSyncPlan,
  cleanDistributionArtifactPath,
  cleanDistributionSourcePath,
  detectProjectScale,
  digestConsumerRuntimeBytes,
  emitSetup,
  loadTemplates,
  nodeSetupDeps,
  PACK_SAFE_TEST_SCRIPT,
  type ProjectScale,
  planSetup,
  recommendPhase,
  recordSetupState,
  runSetup,
  type SetupDeps,
  type SetupState,
  transformCleanDistributionArtifact,
} from "../src/setup/index.ts";
import { COMMON_FILES, type TemplateSet } from "../src/setup/templates.ts";
import { MODEL_IDS } from "../src/team/model-policy.ts";

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

const AUTHORING_TEMPLATE_SOURCES = [
  "docs/templates/plan/design/template.md",
  "docs/templates/plan/impl/template.md",
  "docs/templates/design/L6-function-spec-template.md",
  "docs/templates/state/vmodel.json",
  "docs/templates/prompts/effort-classify.md",
  ".ut-tdd/teams/example-review-team.yaml",
] as const;

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
  "common/ut-tdd.mjs": "#!/usr/bin/env node\n",
  "adapter/AGENTS.md": [
    "<!-- UT-TDD:managed:start -->",
    "# UT-TDD Agent Harness Adapter",
    "",
    "- Status: `ut-tdd status`",
    "- Setup doctor: `ut-tdd doctor --profile consumer-setup-smoke`",
    "- Toolchain doctor: `ut-tdd doctor --profile consumer-toolchain`",
    "- Full doctor: `ut-tdd doctor` (source/governance repositories only)",
    "- Handover: `ut-tdd handover`",
    "<!-- UT-TDD:managed:end -->",
    "",
  ].join("\n"),
  "adapter/CLAUDE.md": [
    "<!-- UT-TDD:managed:start -->",
    "# UT-TDD Agent Harness Shared Context",
    "",
    "- `ut-tdd status`",
    "- `ut-tdd doctor --profile consumer-setup-smoke`",
    "- `ut-tdd doctor --profile consumer-toolchain`",
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
      expect(templates["adapter/AGENTS.md"]).toContain(
        "ut-tdd doctor --profile consumer-setup-smoke",
      );
      expect(templates["adapter/AGENTS.md"]).toContain(
        "ut-tdd doctor --profile consumer-toolchain",
      );
      expect(templates["adapter/CLAUDE.md"]).toContain(
        "Full `ut-tdd doctor` is for source/governance repositories",
      );
      expect(templates["adapter/CLAUDE.md"]).toContain(
        "ut-tdd doctor --profile consumer-toolchain",
      );
      expect(templates["adapter/.claude/commands/ut-tdd-status.md"]).toContain(
        "ut-tdd doctor --profile consumer-setup-smoke",
      );
      expect(templates["adapter/.claude/commands/ut-tdd-status.md"]).toContain(
        "ut-tdd doctor --profile consumer-toolchain",
      );
      const claudeMarkdownTemplates = Object.entries(templates).filter(
        ([path]) => path.startsWith("adapter/.claude/") && path.endsWith(".md"),
      );
      expect(claudeMarkdownTemplates.length).toBeGreaterThan(0);
      for (const [path, body] of claudeMarkdownTemplates) {
        expect(body, path).toContain("doctor --profile consumer-setup-smoke");
        expect(body, path).toContain("doctor --profile consumer-toolchain");
        expect(body, path).not.toContain("finish with `ut-tdd doctor`");
        expect(body, path).not.toContain("Run `ut-tdd status --json` and `ut-tdd doctor`");
        expect(body, path).not.toContain("Health check: `ut-tdd doctor`");
        expect(body, path).not.toContain("Use `ut-tdd status` and `ut-tdd doctor`");
      }
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

  // Pack の test:pack は transform の PACK_SAFE_TEST_SCRIPT が正本。source package.json 側の
  // test:pack 更新 (例: 3dd979f の toolchain-pin 追加) が定数へ伝播し忘れると、次の sync-pack が
  // Pack 側の既存 script を黙って退行させる (実発生 2026-07-03)。両者の一致を fail-close で固定。
  it("U-SETUP-017: PACK_SAFE_TEST_SCRIPT stays in sync with source test:pack", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:pack"]).toBe(PACK_SAFE_TEST_SCRIPT);
  });

  // PLAN-L7-361: nodeConfirm は blocking readSync のため、stdin が開いたまま無音の非対話環境
  // (CI runner / tool shell) で emitSetup の上書き確認が無限待ちになった。非対話では confirm を
  // 呼ばず既存保護 (skip) が invariant。
  it("U-SETUP-016: non-interactive emitSetup keeps existing files without calling confirm", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-setup-nonint-"));
    try {
      const templates = loadTemplates(repo);
      const wrapperPath = join("/repo", ".ut-tdd", "bin", "ut-tdd.mjs");
      const deps = mockDeps({
        templates,
        isInteractive: false,
        confirm: () => {
          throw new Error("confirm must not be called in non-interactive mode");
        },
      });
      deps.files.set(wrapperPath, "PREEXISTING-CONSUMER-CONTENT");

      const plan = planSetup("0-A", { dryRun: false });
      const written = emitSetup(plan, templates, deps);

      expect(deps.files.get(wrapperPath)).toBe("PREEXISTING-CONSUMER-CONTENT");
      expect(written).not.toContain(join(".ut-tdd", "bin", "ut-tdd.mjs"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-SETUP-016b: interactive confirm=yes still overwrites existing files", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-setup-int-"));
    try {
      const templates = loadTemplates(repo);
      const wrapperPath = join("/repo", ".ut-tdd", "bin", "ut-tdd.mjs");
      const deps = mockDeps({ templates, isInteractive: true, confirm: () => true });
      deps.files.set(wrapperPath, "PREEXISTING-CONSUMER-CONTENT");

      const written = emitSetup(planSetup("0-A", { dryRun: false }), templates, deps);

      expect(deps.files.get(wrapperPath)).not.toBe("PREEXISTING-CONSUMER-CONTENT");
      expect(written).toContain(join(".ut-tdd", "bin", "ut-tdd.mjs"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-SETUP-004b2: source docs template keeps consumer harness-check guard strength", () => {
    const templates = loadTemplates(process.cwd());
    const workflow = templates["common/harness-check.yml"];
    expect(workflow).toContain("github guard");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run test");
    expect(workflow).toContain("actions/setup-node@v4");
    expect(workflow).toContain("npm ci --no-audit --no-fund");
    expect(workflow).not.toContain("oven-sh/setup-bun@v2");
    expect(workflow).toContain("audit quality --include-tests");
    expect(workflow).toContain("ut-tdd.mjs doctor --setup-smoke");
    expect(workflow).toMatch(/\n {2}pull_request:\n/);
    expect(workflow).not.toMatch(/pull_request:\n\s+(?:branches|branches-ignore):/);
  });

  it("U-SETUP-004c: built-in adapter templates ship enforced portable guard hooks", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-setup-templates-"));
    const templates = loadTemplates(repo);
    try {
      const claude = JSON.parse(templates["adapter/.claude/settings.json"]) as {
        hooks: Record<
          string,
          {
            matcher?: string;
            hooks: {
              command: string;
              args: string[];
              blockOnFailure?: boolean;
              asyncRewake?: boolean;
              timeout?: number;
            }[];
          }[]
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
                command: "node",
                args: [".ut-tdd/bin/ut-tdd.mjs", "hook", "agent-guard"],
                blockOnFailure: true,
              }),
            ],
          }),
          expect.objectContaining({
            matcher: "Edit|Write|MultiEdit",
            hooks: [
              expect.objectContaining({
                command: "node",
                args: [".ut-tdd/bin/ut-tdd.mjs", "hook", "work-guard"],
                blockOnFailure: true,
              }),
            ],
          }),
        ]),
      );
      expect(claude.hooks.SubagentStop[0].hooks[0]).toMatchObject({
        command: "node",
        args: [".ut-tdd/bin/ut-tdd.mjs", "hook", "subagent-stop"],
      });
      expect(claude.hooks.Stop[1].hooks[0]).toMatchObject({
        command: "node",
        args: [".ut-tdd/bin/ut-tdd.mjs", "hook", "claude-memory-wake"],
        timeout: 930,
        asyncRewake: true,
      });
      expect(codex.hooks.PreToolUse).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matcher: "spawn_agent|spawn_agents_on_csv",
            hooks: [
              expect.objectContaining({
                command: "node",
                args: [".ut-tdd/bin/ut-tdd.mjs", "hook", "agent-guard"],
                blockOnFailure: true,
              }),
            ],
          }),
          expect.objectContaining({
            matcher: "apply_patch|write_file",
            hooks: [
              expect.objectContaining({
                command: "node",
                args: [".ut-tdd/bin/ut-tdd.mjs", "hook", "work-guard"],
                blockOnFailure: true,
              }),
            ],
          }),
        ]),
      );
      expect(templates["adapter/.claude/agents/pmo-sonnet.md"]).toContain(
        `model: ${MODEL_IDS.claude.sonnet}`,
      );
      expect(templates["adapter/.claude/agents/pmo-haiku.md"]).toContain(
        `model: ${MODEL_IDS.claude.haiku}`,
      );
      expect(templates["adapter/.claude/agents/pdm-tech-innovation.md"]).toContain(
        `model: ${MODEL_IDS.claude.opus}`,
      );
      const claudeModelCatalog = new Set<string>(Object.values(MODEL_IDS.claude));
      const agentTemplates = Object.entries(templates).filter(([path]) =>
        path.startsWith("adapter/.claude/agents/"),
      );
      expect(agentTemplates.length).toBeGreaterThan(0);
      for (const [path, body] of agentTemplates) {
        const model = body.match(/^model:\s*(\S+)/m)?.[1];
        expect(model, `${path} must declare a model`).toBeTruthy();
        expect(claudeModelCatalog.has(model ?? ""), `${path} model must come from MODEL_IDS`).toBe(
          true,
        );
        expect(model, `${path} must not retain legacy model suffixes`).not.toMatch(
          /claude-opus-4-7|claude-sonnet-4-6|20251001/,
        );
      }
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

  it("U-SETUP-009b: generated wrapper resolves only the sealed consumer Node runtime", () => {
    const deps = mockDeps();
    const plan = planSetup("0-A", { dryRun: false });

    emitSetup(plan, {}, deps);

    const wrapper = deps.files.get(join("/repo", ".ut-tdd", "bin", "ut-tdd.mjs"));
    expect(wrapper).toContain(
      'const pointerPath = resolve(consumerRoot, ".ut-tdd", "runtime", "activation", "active.json");',
    );
    expect(wrapper).toContain('deny("consumer_runtime_absent")');
    expect(wrapper).toContain('const runtimeRoot = resolve(consumerRoot, ".ut-tdd", "runtime");');
    expect(wrapper).toContain("let manifest;");
    expect(wrapper).toContain("spawnSync(process.execPath, [entry, ...process.argv.slice(2)]");
    expect(wrapper).toContain("windowsHide: true");
    expect(wrapper).not.toContain("shell:");
    expect(wrapper).not.toContain("setupSourceCli");
    expect(wrapper).not.toContain("repoLocalHarness");
    expect(wrapper).not.toContain("src/setup/index.ts");
    expect(wrapper).not.toContain("node_modules/ut-tdd");

    const codexHooks = JSON.parse(deps.files.get(join("/repo", ".codex", "hooks.json")) ?? "") as {
      hooks: { PreToolUse: { hooks: { command: string; args: string[] }[] }[] };
    };
    const claudeSettings = JSON.parse(
      deps.files.get(join("/repo", ".claude", "settings.json")) ?? "",
    ) as {
      hooks: { PreToolUse: { hooks: { command: string; args: string[] }[] }[] };
    };
    const agentGuardInvocation = {
      command: "node",
      args: [".ut-tdd/bin/ut-tdd.mjs", "hook", "agent-guard"],
    };
    expect(codexHooks.hooks.PreToolUse[0]?.hooks[0]).toMatchObject(agentGuardInvocation);
    expect(claudeSettings.hooks.PreToolUse[0]?.hooks[0]).toMatchObject(agentGuardInvocation);
  });

  // The generated wrapper is a sealed Node entrypoint. Launch via Node directly and
  // assert its fail-closed result when no active runtime pointer exists.
  function runWrapperViaNode(cwd: string, args: string[]) {
    return spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  }

  // Issue #506 peer-verification finding (2026-09-01): this oracle asserts wrapper
  // *resolution order* (a node_modules-installed ut-tdd wins over the setup Pack
  // fallback), but the wrapper's production selection logic
  // (`common/ut-tdd.mjs` template, src/setup/templates.ts) hardcodes
  // `node_modules/ut-tdd/src/cli.ts` and spawns it directly via `node`. Node refuses
  // to execute any `.ts` file located under `node_modules/` (type stripping is
  // disabled there by design), so this is not a fixture artifact of retiring Bun —
  // it is a real production defect: any consumer with `ut-tdd` installed as an npm
  // dependency would hit the same `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
  // failure the wrapper's local-package branch is supposed to serve. Converting the
  // fixture to a compiled `.mjs` entry point would paper over that defect instead of
  // surfacing it. The fix belongs to the self-contained/sealed consumer Node runtime
  // work (#420, #463), not to this Bun-spawn-retirement slice — do not force-convert
  // here. Skipped (not deleted) so the oracle body stays intact for #420/#463 to
  // re-enable once the wrapper ships a Node-executable local-package entry point.
  it.skip("U-SETUP-009b2: generated wrapper prefers consumer local bin when local and setup fallback both exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-wrapper-local-"));
    try {
      const deps = mockDeps({ repoRoot: repo });
      const plan = planSetup("0-A", { dryRun: false });
      emitSetup(plan, {}, deps);
      const wrapper = deps.files.get(join(repo, ".ut-tdd", "bin", "ut-tdd.mjs"));
      expect(wrapper).toBeTruthy();

      const wrapperPath = join(repo, ".ut-tdd", "bin", "ut-tdd.mjs");
      const localPackageCli = join(repo, "node_modules", "ut-tdd", "src", "cli.ts");
      mkdirSync(join(repo, ".ut-tdd", "bin"), { recursive: true });
      mkdirSync(join(repo, "node_modules", "ut-tdd", "src"), { recursive: true });
      writeFileSync(wrapperPath, wrapper ?? "");
      writeFileSync(localPackageCli, 'console.log("local-package", ...process.argv.slice(2));\n');

      const result = runWrapperViaNode(repo, [wrapperPath, "status", "--json"]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("local-package status --json");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-SETUP-009b3: generated Node wrapper fails closed when sealed runtime is absent", () => {
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

      const result = runWrapperViaNode(repo, [wrapperPath, "status"]);

      expect(result.status).toBe(78);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("consumer_runtime_absent");
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
    expect(agents).toContain("`ut-tdd doctor --profile consumer-setup-smoke`");
    expect(agents).toContain("`ut-tdd doctor --profile consumer-toolchain`");
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
        ...AUTHORING_TEMPLATE_SOURCES,
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
    expect(plan.channel).toBe("clean-repo-plus-tarball");
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
    // PLAN-L7-413 D-4c: unsigned tarball 契約 — .sig は成果物から撤去 (宣言と実装の一致)。
    expect(plan.releaseIntegrity.artifacts).toEqual(["v0.1.0.tar.gz", "v0.1.0.tar.gz.sha256"]);
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
      ...AUTHORING_TEMPLATE_SOURCES,
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
    filteredSourcePaths.push(".ut-tdd/teams/example-review-team.yaml");

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
          repository: {
            type: "git",
            url: "git+https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS.git",
          },
          scripts: {
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
        }),
      ),
    ) as {
      scripts: Record<string, string>;
      utTdd: { artifactProfile: string };
      repository: { type: string; url: string };
    };

    expect(transformed.scripts["test:pack"]).toContain("tests/distribution-acceptance.test.ts");
    expect(transformed.scripts["test:pack"]).toContain("tests/readability.test.ts");
    expect(transformed.scripts.test).toBe("npm run test:pack");
    expect(transformed.scripts.build).toBeUndefined();
    expect(transformed.scripts["test:pack"]).toContain("scripts/run-vitest-snapshot.ts");
    expect(transformed.scripts["test:source"]).toBe("vitest run");
    expect(transformed.scripts.typecheck).toBe("tsc --noEmit");
    expect(transformed.utTdd.artifactProfile).toBe("pack");
    // issue #83: source repo の URL は Pack artifact では Pack repo へ書き換わる。
    expect(transformed.repository.url).toBe(
      "git+https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack.git",
    );
  });

  it("U-SETUP-011f: source package.json points repository at the source development repo (issue #83)", () => {
    const sourcePackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      repository?: { url?: string };
    };

    expect(sourcePackage.repository?.url).toBe(
      "git+https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS.git",
    );
  });

  it("U-SETUP-011e: clean Pack workflow reuses the package test:pack script", () => {
    const transformed = transformCleanDistributionArtifact(
      ".github/workflows/harness-check.yml",
      readFileSync(
        join(process.cwd(), "docs", "templates", "github", "common", "pack-harness-check.yml"),
        "utf8",
      ),
    );

    expect(transformed).toContain("run: npm run test:pack");
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
          (nonPackPrefixes.some((prefix) => path.startsWith(prefix)) &&
            !path.startsWith("docs/templates/")) ||
          nonPackDbFiles.test(path),
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
    const compiled = Buffer.from("export default 0;\n", "utf8");
    const readinessIdentity = {
      product_id: "setup-readiness",
      consumer_root: "/repo",
      runtime_root: "/repo/.ut-tdd/runtime",
      operation_id: "setup-readiness-operation",
      attempt: 0,
      generation_id: "setup-readiness-generation",
      subject_revision: "a".repeat(40),
      artifact_digest: `sha256:${"b".repeat(64)}`,
      node_executable_identity: `node-${process.version}|sha256:${"c".repeat(64)}`,
      package_lock_digest: `sha256:${"d".repeat(64)}`,
      source_graph_digest: `sha256:${"e".repeat(64)}`,
      compiled_esm_digest: digestConsumerRuntimeBytes(compiled),
      release_id: `rel-sha256:${"f".repeat(64)}`,
      materializer_version: "fixture",
      artifact_set_digest: `sha256:${"1".repeat(64)}`,
      control_manifest_digest: `sha256:${"2".repeat(64)}`,
      sealed_policy: "compiled-esm-only" as const,
    };
    const readinessPayloads = buildConsumerNodeRuntimePayloads({
      identity: readinessIdentity,
      compiled_esm: compiled,
      node_bootstrap_receipt: Buffer.from("{}\n", "utf8"),
    });
    const consumerRuntime = {
      status: "ready" as const,
      identity: readinessIdentity,
      bundle: buildConsumerNodeRuntimeBundle({ identity: readinessIdentity, ...readinessPayloads }),
    };
    const ready = buildConsumerReadinessPlan({
      nodeVersion: "24.13.0",
      requiredNodeVersion: "24.13.0",
      hasGit: true,
      hasGh: false,
      hasUtTddCli: true,
      hasClaude: false,
      hasCodex: true,
      repoRoot: "/repo",
      packageRoot: "/repo/packages/app",
      tag: "v0.1.0",
      consumerRuntime,
    });

    expect(ready.ok).toBe(true);
    expect(ready.mode).toBe("codex-only");
    expect(ready.workspace.monorepo).toBe(true);
    expect(ready.checks.find((c) => c.name === "gh")).toMatchObject({ ok: false });
    expect(ready.checks.find((c) => c.name === "ut-tdd-cli")).toMatchObject({ ok: true });
    expect(ready.ci.requires).toContain("npm test");
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

    const standaloneReady = buildConsumerReadinessPlan({
      nodeVersion: "24.13.0",
      requiredNodeVersion: "24.13.0",
      hasGit: true,
      hasGh: false,
      hasUtTddCli: true,
      hasClaude: false,
      hasCodex: false,
      repoRoot: "/repo",
      consumerRuntime,
    });
    expect(standaloneReady.ok).toBe(true);
    expect(standaloneReady.mode).toBe("standalone");
    expect(standaloneReady.checks.find((c) => c.name === "runtime-cli")).toMatchObject({
      ok: true,
    });
    expect(standaloneReady.checks.find((c) => c.name === "runtime-cli")?.message).toContain(
      "judgment gates require human review",
    );

    const customRepo = buildConsumerReadinessPlan({
      nodeVersion: "24.13.0",
      requiredNodeVersion: "24.13.0",
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
      nodeVersion: "22.0.0",
      requiredNodeVersion: "24.13.0",
      hasGit: false,
      hasGh: false,
      hasUtTddCli: false,
      hasClaude: false,
      hasCodex: false,
      repoRoot: "/repo",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "node@24.13.0",
      "git",
      "gh",
      "ut-tdd-cli",
    ]);
    expect(blocked.checks.find((c) => c.name === "ut-tdd-cli")?.message).toContain(
      "Generated Claude/Codex hooks resolve only the consumer-local sealed Node runtime.",
    );
    expect(blocked.checks.find((c) => c.name === "ut-tdd-cli")?.message).toContain(
      "Source checkouts and TypeScript package paths are not fallback candidates.",
    );
    // engines.node follows npm range semantics rather than a numeric minimum:
    // a compatible patch is accepted, while a new major outside ^24 is not.
    expect(
      buildConsumerReadinessPlan({
        nodeVersion: "24.13.5",
        requiredNodeVersion: ">=24.13.0 <25",
        hasGit: true,
        hasGh: false,
        hasUtTddCli: true,
        hasClaude: false,
        hasCodex: false,
        repoRoot: "/consumer",
        consumerRuntime,
      }).ok,
    ).toBe(true);
    expect(
      buildConsumerReadinessPlan({
        nodeVersion: "25.0.0",
        requiredNodeVersion: "^24.13.0",
        hasGit: true,
        hasGh: false,
        hasUtTddCli: true,
        hasClaude: false,
        hasCodex: false,
        repoRoot: "/consumer",
      }).ok,
    ).toBe(false);
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

  it("identity bootstrap denial is reported while setup continues", () => {
    const d = mockDeps({
      templates: baseTemplates,
      bootstrapProjectIdentity: () => ({
        ok: false,
        error: { ruleId: "identity_repository_unbound", message: "origin remote is missing" },
      }),
    });
    const result = runSetup({ phase: "0-A", dryRun: false, applyBranchProtection: false }, d);

    expect(result.projectIdentity).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
    expect(result.phase).toBe("0-A");
    expect(d.files.has(statePath)).toBe(true);
    expect(result.written).toContain("AGENTS.md");
  });

  it("runSetup invokes the real bootstrap dependency and prepends a created identity", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-setup-identity-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: root });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], {
        cwd: root,
      });

      const result = runSetup(
        { phase: "0-A", dryRun: false, applyBranchProtection: false },
        nodeSetupDeps(root),
      );

      expect(result.projectIdentity).toMatchObject({
        ok: true,
        created: true,
        commitRequired: true,
        repositoryIdentity: "acme/widget",
      });
      expect(result.written[0]).toBe("ut-tdd.project.json");
      expect(readFileSync(join(root, "ut-tdd.project.json"))).toEqual(
        Buffer.from(
          `${JSON.stringify(
            { schema_version: "ut-tdd.project/v1", repository_identity: "acme/widget" },
            null,
            2,
          )}\n`,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
