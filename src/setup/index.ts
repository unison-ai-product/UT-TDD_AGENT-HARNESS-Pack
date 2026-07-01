/**
 * setup — ut-tdd setup solo/team。参加規模を検出 → solo(0-A)/team(0-B) を提案 →
 * 人間確認 → 確定 phase を記録 → phase 別の GitHub 設定を出し分け生成。
 *
 * 設計 (①): docs/design/harness/L6-function-design/setup-solo-team.md (PLAN-L6-05 add-design)。
 * テスト設計 (③): docs/test-design/harness/L7-unit-test-design.md §1.7 U-SETUP-001〜007。
 * PLAN: PLAN-L7-03-setup-solo-team (add-impl)。
 *
 * セキュリティ不変条件 (CLAUDE.md エスカレーション境界):
 *   ① token を読まない・state/docs/log に記録しない (gh 認証状態に委ねる seam)。
 *   ② branch protection の実適用は --apply + 対話 + admin/auth/confirm 全充足時のみ (非対話は封鎖)。
 *   ③ 既定は emit-only (スクリプト + 手順生成、適用は人間)。
 *   ④ 検出不能は solo に安全フォールバック (緩い側に倒す)。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_GITHUB_TEMPLATES, COMMON_FILES, type TemplateSet } from "./templates";

export type SetupPhase = "0-A" | "0-B"; // 0-A=solo / 0-B=team

/** 検出結果 (生信号、判定しない)。token は含めない。 */
export interface ProjectScale {
  ownerType: "User" | "Organization" | "unknown";
  collaborators: number | null; // 取得不可は null
  hasCodeowners: boolean;
  hasBranchProtection: boolean | null; // 取得不可は null
}

export interface PhaseRecommendation {
  phase: SetupPhase;
  reason: string;
  confidence: "high" | "low";
}

export interface GeneratedFile {
  path: string; // 対象 repo 相対 path
  category: "A" | "B"; // §9.1 種別
  purpose: string;
}

export interface GithubAction {
  kind: "branch-protection";
  script_path: string;
  applied: boolean; // 既定 false (適用は applyBranchProtection)
}

export interface SetupPlan {
  phase: SetupPhase;
  files: GeneratedFile[];
  actions: GithubAction[];
  dryRun: boolean;
  teams?: TeamSlugs; // CODEOWNERS render 用 (impl: 設計 §2.2 type に team 反映を materialize)
}

export interface SetupState {
  phase: SetupPhase;
  decidedAt: string;
  decidedBy: "flag" | "confirm" | "fallback";
  signals: ProjectScale; // 4 フィールドのみ (recordSetupState で strip)
}

export interface TeamSlugs {
  tl: string;
  qa: string;
  po: string;
}

export interface SetupArgs {
  phase?: SetupPhase;
  dryRun: boolean;
  applyBranchProtection: boolean;
  teams?: TeamSlugs;
}

export interface SetupResult {
  phase: SetupPhase;
  written: string[];
  branchProtection: { applied: boolean; reason: string };
}

export interface CleanDistributionPlan {
  ok: boolean;
  channel: "clean-repo-plus-signed-tarball";
  sourceTag: string;
  cleanRepo: string;
  artifactPaths: string[];
  excludedPaths: string[];
  missingRequired: string[];
  denylistViolations: string[];
  releaseIntegrity: {
    required: boolean;
    artifacts: string[];
  };
}

export interface ConsumerReadinessPlan {
  ok: boolean;
  checks: { name: string; ok: boolean; message: string }[];
  mode: "standalone" | "claude-only" | "codex-only" | "hybrid";
  workspace: {
    repoRoot: string;
    packageRoot: string;
    monorepo: boolean;
  };
  ci: {
    workflow: string;
    requires: string[];
    forkPullRequestSecrets: "not-required";
  };
  rollback: {
    managedPaths: string[];
    backupRequired: boolean;
    commands: string[];
  };
  contracts: {
    semver: string;
    tagPin: string;
    stable: string[];
  };
  smokeScenarios: string[];
}

/** gh 実行 seam (raw token 非依存 = gh の認証状態に委ねる)。test=mock。 */
export type GhRunner = (args: string[]) => { ok: boolean; stdout: string };
/** 対話確認 seam。test=mock、非対話では呼ばれない。 */
export type Confirm = (message: string) => boolean;

/** I/O・clock・gh・confirm・templates を注入 (session-log の deps パターン踏襲)。 */
export interface SetupDeps {
  repoRoot: string;
  now: () => string;
  gh: GhRunner;
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
  confirm: Confirm;
  isInteractive: boolean;
  templates: TemplateSet;
}

const CODEOWNERS_TARGET = join(".github", "CODEOWNERS");
const STATE_PATH = join(".ut-tdd", "state", "setup.json");
const BP_SCRIPT = join("scripts", "setup-branch-protection.sh");
const MANAGED_START = "<!-- UT-TDD:managed:start -->";
const MANAGED_END = "<!-- UT-TDD:managed:end -->";
const PACK_REPO = "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack";
const SETUP_SOURCE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const MERGEABLE_ADAPTER_DOCS = new Set(["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md")]);
const CLEAN_REQUIRED_PATHS = [
  "README.md",
  "LICENSE",
  "package.json",
  "src/cli.ts",
  "src/setup/index.ts",
  ...COMMON_FILES.filter((entry) => entry.template.startsWith("adapter/")).map(
    (entry) => `docs/templates/${entry.template}`,
  ),
];
const CLEAN_DENY_PREFIXES = [
  ".ut-tdd/",
  "docs/plans/",
  "docs/design/harness/",
  "docs/test-design/",
  "docs/handover/",
  "docs/archive/",
  "src/web/",
  "vendor/",
  "legacy local state/",
];
const CLEAN_DENY_FILES = new Set([
  "docs/governance/conditional-backfill-decision-audit-2026-06-22.md",
  "docs/governance/forward-convergence-legacy-debt-audit.md",
  "docs/governance/reverse-fullback-backprop-audit-2026-06-22.md",
  "docs/governance/runtime-parity-l0-l3-design-audit-2026-06-02.md",
  "docs/governance/ut-tdd-agent-harness-extraction-plan_v0.1.md",
]);
const CLEAN_DENY_PATTERNS = [
  /^docs\/governance\/.*-audit(?:-|\.md$)/i,
  /^docs\/governance\/.*legacy-debt.*\.md$/i,
  /^docs\/governance\/.*runtime-parity.*\.md$/i,
  /^docs\/governance\/.*extraction-plan.*\.md$/i,
];
const CLEAN_ALLOW_PREFIXES = [
  "docs/process/",
  "docs/reference/",
  "docs/skills/",
  "docs/templates/adapter/",
  "docs/templates/github/",
  "scripts/",
  "skills/",
  "src/",
  "tests/",
];
const CLEAN_ALLOW_FILES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".github/workflows/harness-check.yml",
  "LICENSE",
  "README.md",
  "biome.json",
  "bun.lock",
  "docs/governance/README.md",
  "docs/governance/ai-dev-team-concept_v1.1.md",
  "docs/governance/ai-dev-team-operations_v1.1.md",
  "docs/governance/audit-framework.md",
  "docs/governance/coding-rules.md",
  "docs/governance/ddd-tdd-rules.md",
  "docs/governance/document-system-map.md",
  "docs/governance/gate-design.md",
  "docs/governance/recovery-workflow.md",
  "docs/governance/repository-structure.md",
  "docs/governance/ut-tdd-agent-harness-concept_v3.1.md",
  "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
]);

/**
 * U-SETUP-001: gh で owner 種別 / collaborator 数 / 既存 protection を読む。**never throws**。
 * gh 不在/未認証/権限不足 → unknown/null。token は読まない (gh 認証状態に委譲)。
 */
export function detectProjectScale(deps: SetupDeps): ProjectScale {
  const hasCodeowners = readNonEmpty(deps, join(deps.repoRoot, CODEOWNERS_TARGET));
  let ownerType: ProjectScale["ownerType"] = "unknown";
  let collaborators: number | null = null;
  let hasBranchProtection: boolean | null = null;
  try {
    // gh は repos/{owner}/{repo} placeholder を current repo に自動解決する
    const repo = deps.gh(["api", "repos/{owner}/{repo}"]);
    if (repo.ok) {
      try {
        const t = (JSON.parse(repo.stdout) as { owner?: { type?: string } })?.owner?.type;
        if (t === "User" || t === "Organization") ownerType = t;
      } catch {
        // parse 失敗 → unknown 維持
      }
      const collab = deps.gh(["api", "repos/{owner}/{repo}/collaborators"]);
      if (collab.ok) {
        try {
          const arr = JSON.parse(collab.stdout);
          if (Array.isArray(arr)) collaborators = arr.length;
        } catch {
          // 維持
        }
      }
      // protection: 200=保護あり / 404 等=なし。repo 取得できた = gh は使えるので false に確定
      hasBranchProtection = deps.gh(["api", "repos/{owner}/{repo}/branches/main/protection"]).ok;
    }
  } catch {
    // never throws — 不明信号のまま返す
  }
  return { ownerType, collaborators, hasCodeowners, hasBranchProtection };
}

/**
 * U-SETUP-002: 純関数。org / collaborators>1 / 既存 CODEOWNERS / 既存 protection → team(0-B)。
 * User かつ collaborators<=1 → solo(0-A)。不明信号 (null 単独含む) → solo(0-A) low (安全フォールバック)。
 */
export function recommendPhase(scale: ProjectScale): PhaseRecommendation {
  if (
    scale.ownerType === "Organization" ||
    (scale.collaborators ?? 0) > 1 ||
    scale.hasCodeowners ||
    scale.hasBranchProtection === true
  ) {
    return { phase: "0-B", reason: teamReason(scale), confidence: "high" };
  }
  if (scale.ownerType === "User" && scale.collaborators !== null && scale.collaborators <= 1) {
    return {
      phase: "0-A",
      reason: "個人 owner + collaborator 1 名以下 = solo",
      confidence: "high",
    };
  }
  return {
    phase: "0-A",
    reason: "信号不足 (owner/collaborator 不明)、安全側 solo に倒す",
    confidence: "low",
  };
}

function teamReason(s: ProjectScale): string {
  const why: string[] = [];
  if (s.ownerType === "Organization") why.push("org 所有");
  if ((s.collaborators ?? 0) > 1) why.push(`collaborator ${s.collaborators} 名`);
  if (s.hasCodeowners) why.push("既存 CODEOWNERS");
  if (s.hasBranchProtection === true) why.push("既存 branch protection");
  return `team 構成の信号: ${why.join(" / ")}`;
}

/**
 * U-SETUP-003: 純関数。0-A=共通(A)のみ。0-B=共通(A)+CODEOWNERS(B)+branch-protection script。
 * actions.applied は常に false (適用は applyBranchProtection)。teams は CODEOWNERS render に反映。
 */
export function planSetup(
  phase: SetupPhase,
  opts: { teams?: TeamSlugs; dryRun: boolean },
): SetupPlan {
  const files: GeneratedFile[] = COMMON_FILES.map((c) => ({ ...c.file }));
  const actions: GithubAction[] = [];
  if (phase === "0-B") {
    const teamNote = opts.teams
      ? ` (tl=${opts.teams.tl} qa=${opts.teams.qa} po=${opts.teams.po})`
      : "";
    files.push({ path: CODEOWNERS_TARGET, category: "B", purpose: `CODEOWNERS${teamNote}` });
    files.push({
      path: BP_SCRIPT,
      category: "B",
      purpose: "branch protection 適用スクリプト (emit-only)",
    });
    actions.push({ kind: "branch-protection", script_path: BP_SCRIPT, applied: false });
  }
  return {
    phase,
    files,
    actions,
    dryRun: opts.dryRun,
    ...(opts.teams ? { teams: opts.teams } : {}),
  };
}

/** 内部 helper (独立契約でない、U-SETUP-004 に内包): plan + templates → {path, content}[]。token 非埋込。 */
function renderArtifacts(
  plan: SetupPlan,
  templates: TemplateSet,
): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const f of plan.files) {
    const name = templateNameFor(f.path);
    let content = templates[name] ?? BUILTIN_GITHUB_TEMPLATES[name] ?? "";
    content = content.replace(/\{\{UT_TDD_SOURCE_CLI_JSON\}\}/g, JSON.stringify(SETUP_SOURCE_CLI));
    if (f.path === CODEOWNERS_TARGET && plan.teams) {
      content = content
        .replace(/\{\{TL_TEAM\}\}/g, plan.teams.tl)
        .replace(/\{\{QA_TEAM\}\}/g, plan.teams.qa)
        .replace(/\{\{PO_TEAM\}\}/g, plan.teams.po);
    }
    out.push({ path: f.path, content });
  }
  return out;
}

function templateNameFor(targetPath: string): string {
  const common = COMMON_FILES.find((entry) => entry.file.path === targetPath);
  if (common) return common.template;
  if (targetPath === CODEOWNERS_TARGET) return "team/CODEOWNERS";
  if (targetPath === BP_SCRIPT) return "team/setup-branch-protection.sh";
  if (targetPath === "AGENTS.md") return "adapter/AGENTS.md";
  if (targetPath === "CLAUDE.md") return "adapter/CLAUDE.md";
  if (targetPath === join(".claude", "CLAUDE.md")) return "adapter/.claude/CLAUDE.md";
  if (targetPath === join(".claude", "settings.json")) return "adapter/.claude/settings.json";
  return `common/${basename(targetPath)}`;
}

function mergeManagedBlock(existing: string | null, rendered: string): string | null {
  if (existing === null) return rendered;
  const start = rendered.indexOf(MANAGED_START);
  const end = rendered.indexOf(MANAGED_END);
  if (start === -1 || end === -1 || end < start) return null;
  const managed = rendered.slice(start, end + MANAGED_END.length);
  const existingStart = existing.indexOf(MANAGED_START);
  const existingEnd = existing.indexOf(MANAGED_END);
  if (existingStart !== -1 && existingEnd !== -1 && existingEnd >= existingStart) {
    const next =
      existing.slice(0, existingStart) + managed + existing.slice(existingEnd + MANAGED_END.length);
    return next.endsWith("\n") ? next : `${next}\n`;
  }
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${prefix}\n${managed}\n`;
}

function normalizeDistributionPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isDeniedCleanPath(path: string): boolean {
  const p = normalizeDistributionPath(path);
  return (
    CLEAN_DENY_FILES.has(p) ||
    CLEAN_DENY_PATTERNS.some((pattern) => pattern.test(p)) ||
    CLEAN_DENY_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))
  );
}

function isAllowedCleanPath(path: string): boolean {
  const p = normalizeDistributionPath(path);
  if (CLEAN_ALLOW_FILES.has(p)) return true;
  return CLEAN_ALLOW_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function cleanDistributionArtifactPath(path: string): string {
  const p = normalizeDistributionPath(path);
  if (p.startsWith("docs/skills/")) return `skills/${p.slice("docs/skills/".length)}`;
  return p;
}

export function cleanDistributionSourcePath(
  artifactPath: string,
  sourcePaths: Iterable<string>,
): string {
  const artifact = normalizeDistributionPath(artifactPath);
  if (artifact === ".github/workflows/harness-check.yml") {
    return "docs/templates/github/common/pack-harness-check.yml";
  }
  const sources = new Set([...sourcePaths].map(normalizeDistributionPath));
  if (sources.has(artifact)) return artifact;
  if (artifact.startsWith("skills/")) {
    const legacy = `docs/skills/${artifact.slice("skills/".length)}`;
    if (sources.has(legacy)) return legacy;
  }
  return artifact;
}

export const PACK_SAFE_TEST_SCRIPT =
  "vitest run tests/setup.test.ts tests/distribution-acceptance.test.ts tests/skill-recommend.test.ts tests/skill-scaffold.test.ts tests/dependency-drift.test.ts tests/readability.test.ts --reporter=dot";

export function transformCleanDistributionArtifact(artifactPath: string, content: string): string {
  const artifact = normalizeDistributionPath(artifactPath);
  if (artifact !== "package.json") return content;
  const parsed = JSON.parse(content) as {
    scripts?: Record<string, string>;
    [key: string]: unknown;
  };
  const scripts = { ...(parsed.scripts ?? {}) };
  scripts["test:source"] ??= scripts.test ?? "vitest run";
  scripts["test:pack"] = PACK_SAFE_TEST_SCRIPT;
  scripts.test = PACK_SAFE_TEST_SCRIPT;
  return `${JSON.stringify({ ...parsed, scripts }, null, 2)}\n`;
}

export interface PackSyncPlan {
  ok: boolean;
  mode: "non-destructive-sync-plan";
  cleanRepo: string;
  sourceTag: string;
  branch: string;
  stagingDir: string;
  artifactCount: number;
  excludedCount: number;
  missingRequired: string[];
  denylistViolations: string[];
  copyPlan: { sourcePath: string; artifactPath: string }[];
  commands: string[];
  checks: string[];
  publishRequiresPoApproval: true;
  destructiveRemoteMutation: false;
}

function hasMinimumBun(version: string, minimum = "1.3.0"): boolean {
  const parse = (v: string): number[] => {
    const match = v.match(/\d+(?:\.\d+){0,2}/)?.[0] ?? "0";
    return match.split(".").map((n) => Number.parseInt(n, 10));
  };
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

export function buildCleanDistributionPlan(input: {
  paths: string[];
  sourceTag?: string;
  cleanRepo?: string;
}): CleanDistributionPlan {
  const sourceTag = input.sourceTag ?? "unreleased";
  const cleanRepo = input.cleanRepo ?? PACK_REPO;
  const normalized = [...new Set(input.paths.map(normalizeDistributionPath))].sort();
  const includedSourcePaths = normalized.filter(
    (path) => isAllowedCleanPath(path) && !isDeniedCleanPath(path),
  );
  const artifactPaths = [...new Set(includedSourcePaths.map(cleanDistributionArtifactPath))].sort();
  const artifactSet = new Set(artifactPaths);
  const missingRequired = CLEAN_REQUIRED_PATHS.filter((path) => !artifactSet.has(path));
  const denylistViolations = artifactPaths.filter(isDeniedCleanPath);
  const includedSourceSet = new Set(includedSourcePaths);
  const excludedPaths = normalized.filter((path) => !includedSourceSet.has(path));
  return {
    ok: missingRequired.length === 0 && denylistViolations.length === 0,
    channel: "clean-repo-plus-signed-tarball",
    sourceTag,
    cleanRepo,
    artifactPaths,
    excludedPaths,
    missingRequired,
    denylistViolations,
    releaseIntegrity: {
      required: true,
      artifacts: [`${sourceTag}.tar.gz`, `${sourceTag}.tar.gz.sha256`, `${sourceTag}.tar.gz.sig`],
    },
  };
}

export function buildConsumerReadinessPlan(input: {
  bunVersion: string | null;
  hasGit: boolean;
  hasGh: boolean;
  hasUtTddCli?: boolean;
  utTddCliMessage?: string;
  hasClaude: boolean;
  hasCodex: boolean;
  repoRoot: string;
  packageRoot?: string;
  tag?: string;
}): ConsumerReadinessPlan {
  const bunOk = Boolean(input.bunVersion && hasMinimumBun(input.bunVersion));
  const mode =
    input.hasClaude && input.hasCodex
      ? "hybrid"
      : input.hasClaude
        ? "claude-only"
        : input.hasCodex
          ? "codex-only"
          : "standalone";
  const runtimeOk = input.hasClaude || input.hasCodex;
  const checks = [
    {
      name: "bun>=1.3",
      ok: bunOk,
      message: bunOk ? `Bun ${input.bunVersion}` : "Install Bun 1.3 or newer before setup",
    },
    {
      name: "git",
      ok: input.hasGit,
      message: input.hasGit ? "git available" : "Install git before tag-pin updates",
    },
    {
      name: "gh",
      ok: input.hasGh,
      message: input.hasGh
        ? "gh available"
        : "Install gh for GitHub setup; local setup can continue",
    },
    {
      name: "ut-tdd-cli",
      ok: input.hasUtTddCli ?? true,
      message:
        (input.hasUtTddCli ?? true)
          ? "project-local UT-TDD wrapper, package bin, or source setup entrypoint is available for projected hooks"
          : (input.utTddCliMessage ??
            [
              "Generated Claude/Codex hooks call `bun .ut-tdd/bin/ut-tdd.mjs ...` so each project can use its own pinned UT-TDD package.",
              "Add UT-TDD as a project dependency before setup and verify `node_modules/.bin/ut-tdd --help` or `bun .ut-tdd/bin/ut-tdd.mjs --help` in the consumer repo.",
              "Do not rely on a global `bun link` when multiple projects on one PC may pin different harness versions.",
              "Bun itself must still resolve on the hook shell PATH.",
            ].join(" ")),
    },
    {
      name: "runtime-cli",
      ok: runtimeOk,
      message: runtimeOk
        ? `mode=${mode}`
        : "Install or login to claude or codex before review gates",
    },
  ];
  const packageRoot = input.packageRoot ?? input.repoRoot;
  const tag = input.tag ?? "v0.1.0";
  return {
    ok: bunOk && input.hasGit && (input.hasUtTddCli ?? true) && runtimeOk,
    checks,
    mode,
    workspace: {
      repoRoot: input.repoRoot,
      packageRoot,
      monorepo:
        normalizeDistributionPath(packageRoot) !== normalizeDistributionPath(input.repoRoot),
    },
    ci: {
      workflow: ".github/workflows/harness-check.yml",
      requires: [
        "actions/checkout@v4",
        "oven-sh/setup-bun@v2",
        "bun install --frozen-lockfile",
        "bun run typecheck",
        "bun run test",
      ],
      forkPullRequestSecrets: "not-required",
    },
    rollback: {
      managedPaths: [
        ...COMMON_FILES.map((entry) => normalizeDistributionPath(entry.file.path)),
        ".ut-tdd/state/setup.json",
      ],
      backupRequired: true,
      commands: [
        `git switch ${tag}`,
        "bun .ut-tdd/bin/ut-tdd.mjs setup --dry-run",
        "bun .ut-tdd/bin/ut-tdd.mjs setup --solo",
      ],
    },
    contracts: {
      semver: "0.x may add capabilities; breaking public contract changes require migration notes",
      tagPin: `github:${PACK_REPO}#${tag}`,
      stable: [
        "CLI surface",
        "adapter managed markers",
        ".ut-tdd state schema",
        "project-local .ut-tdd/bin/ut-tdd.mjs wrapper",
        "Claude/Codex adapter hook templates",
        "Claude subagent and slash-command templates",
        "hook event schema",
        "team yaml schema",
      ],
    },
    smokeScenarios: [
      "clean repo -> setup --dry-run -> doctor",
      "brownfield repo -> setup twice -> consumer lines preserved",
      "tag bump -> setup --dry-run -> rollback command available",
      "consumer CI -> harness-check green without repository secrets",
      "monorepo package root -> adapter paths remain repo-root scoped",
    ],
  };
}

/**
 * U-SETUP-004: render → 書込。dryRun は書かず path 一覧を返すのみ。既存上書きは confirm 経由。
 * 生成内容に token を埋め込まない (render は templates と team slug のみ)。書いた path を返す。
 */
export function buildPackSyncPlan(input: {
  exportPlan: CleanDistributionPlan;
  sourcePaths: string[];
  stagingDir: string;
  branch?: string;
}): PackSyncPlan {
  const branch = input.branch ?? "main";
  const sourcePathSet = new Set(input.sourcePaths.map(normalizeDistributionPath));
  const copyPlan = input.exportPlan.artifactPaths.map((artifactPath) => ({
    sourcePath: cleanDistributionSourcePath(artifactPath, sourcePathSet),
    artifactPath,
  }));
  return {
    ok: input.exportPlan.ok,
    mode: "non-destructive-sync-plan",
    cleanRepo: input.exportPlan.cleanRepo,
    sourceTag: input.exportPlan.sourceTag,
    branch,
    stagingDir: input.stagingDir,
    artifactCount: input.exportPlan.artifactPaths.length,
    excludedCount: input.exportPlan.excludedPaths.length,
    missingRequired: input.exportPlan.missingRequired,
    denylistViolations: input.exportPlan.denylistViolations,
    copyPlan,
    commands: [
      `git clone https://github.com/${input.exportPlan.cleanRepo}.git ${input.stagingDir}`,
      `git -C ${input.stagingDir} switch ${branch}`,
      "copy only copyPlan.sourcePath files from source repo to copyPlan.artifactPath in the staging repo",
      `git -C ${input.stagingDir} status --short`,
      `git -C ${input.stagingDir} add -- .`,
      `git -C ${input.stagingDir} commit -m "chore: sync clean pack ${input.exportPlan.sourceTag}"`,
      `git -C ${input.stagingDir} tag -a ${input.exportPlan.sourceTag} -m "${input.exportPlan.sourceTag}"`,
      `git -C ${input.stagingDir} push origin ${branch} --follow-tags`,
    ],
    checks: [
      "denylistViolations.length === 0",
      "missingRequired.length === 0",
      "git status --short shows only intended clean Pack files",
      "Pack CI passes before release publication",
      "signature tarball and GitHub release publication remain separate human-approved operations",
    ],
    publishRequiresPoApproval: true,
    destructiveRemoteMutation: false,
  };
}

export function emitSetup(plan: SetupPlan, templates: TemplateSet, deps: SetupDeps): string[] {
  const rendered = renderArtifacts(plan, templates);
  if (plan.dryRun) return rendered.map((r) => r.path);
  const written: string[] = [];
  for (const r of rendered) {
    const abs = join(deps.repoRoot, r.path);
    const existing = deps.readText(abs);
    const exists = existing !== null;
    if (exists && MERGEABLE_ADAPTER_DOCS.has(r.path)) {
      const merged = mergeManagedBlock(existing, r.content);
      if (merged === null) continue;
      if (merged !== existing) {
        deps.writeText(abs, merged);
        written.push(r.path);
      }
      continue;
    }
    if (exists && !deps.confirm(`${r.path} は既存です。上書きしますか？`)) continue;
    deps.writeText(abs, r.content);
    written.push(r.path);
  }
  return written;
}

/**
 * U-SETUP-005: setup.json を上書き (単一ファイル = 確定値 SSoT、append しない)。
 * signals は 4 フィールドのみ strip (認証情報混入経路を遮断)。
 */
export function recordSetupState(state: SetupState, deps: SetupDeps): void {
  const stripped: SetupState = {
    phase: state.phase,
    decidedAt: state.decidedAt,
    decidedBy: state.decidedBy,
    signals: {
      ownerType: state.signals.ownerType,
      collaborators: state.signals.collaborators,
      hasCodeowners: state.signals.hasCodeowners,
      hasBranchProtection: state.signals.hasBranchProtection,
    },
  };
  deps.writeText(join(deps.repoRoot, STATE_PATH), `${JSON.stringify(stripped, null, 2)}\n`);
}

/**
 * U-SETUP-006: apply≠true → emit-only (既定)。isInteractive≠true → non-interactive で gh 非実行。
 * 対話下でのみ gh 認証 + admin + 人間 confirm 全充足で gh api 実行。欠落 → 実行せず emit-only に戻す。
 */
export function applyBranchProtection(
  plan: SetupPlan,
  deps: SetupDeps,
  opts: { apply: boolean },
): { applied: boolean; reason: string } {
  if (opts.apply !== true) return { applied: false, reason: "emit-only" };
  // ガバナンス: 非対話での無人適用を precondition で封鎖
  if (deps.isInteractive !== true) return { applied: false, reason: "non-interactive" };
  const action = plan.actions.find((a) => a.kind === "branch-protection");
  if (!action) return { applied: false, reason: "no-action" };
  if (!deps.gh(["auth", "status"]).ok) return { applied: false, reason: "not-authenticated" };
  const repo = deps.gh(["api", "repos/{owner}/{repo}"]);
  let admin = false;
  try {
    admin =
      (JSON.parse(repo.stdout) as { permissions?: { admin?: boolean } })?.permissions?.admin ===
      true;
  } catch {
    admin = false;
  }
  if (!repo.ok || !admin) return { applied: false, reason: "not-admin" };
  if (
    !deps.confirm(
      "main の branch protection を適用します (本番 merge ゲート変更)。よろしいですか？",
    )
  ) {
    return { applied: false, reason: "declined" };
  }
  // emit-only script と同じ PUT を gh 経由で適用 (token は gh 認証に委譲、harness は保持しない)
  const r = deps.gh([
    "api",
    "-X",
    "PUT",
    "repos/{owner}/{repo}/branches/main/protection",
    "-H",
    "Accept: application/vnd.github+json",
    "-F",
    "required_status_checks[strict]=true",
    "-f",
    "required_status_checks[checks][][context]=harness-check",
    "-F",
    "enforce_admins=true",
    "-F",
    "required_pull_request_reviews[required_approving_review_count]=1",
    "-F",
    "restrictions=null",
  ]);
  return r.ok ? { applied: true, reason: "applied" } : { applied: false, reason: "gh-failed" };
}

/**
 * U-SETUP-007: orchestration。phase = フラグ > confirm(recommend(detect)) > fallback(solo)。
 * 確定 → record → plan → emit → (apply は opt-in)。非対話+フラグ無し → 0-A。
 * invariant: --apply-branch-protection は対話のみ有効 (applyBranchProtection の precondition が保証)。
 * invariant: dryRun=true は副作用ゼロ (state 非書込・remote 非適用、branchProtection.reason="dry-run")。
 */
export function runSetup(args: SetupArgs, deps: SetupDeps): SetupResult {
  const scale = detectProjectScale(deps);
  let phase: SetupPhase;
  let decidedBy: SetupState["decidedBy"];
  if (args.phase) {
    phase = args.phase;
    decidedBy = "flag";
  } else if (deps.isInteractive) {
    const rec = recommendPhase(scale);
    const ok = deps.confirm(
      `検出: owner=${scale.ownerType}, collaborators=${scale.collaborators ?? "?"}, ` +
        `CODEOWNERS=${scale.hasCodeowners ? "あり" : "なし"} → 推奨 ${rec.phase} (${rec.reason})。` +
        `${rec.phase === "0-B" ? "team" : "solo"} 設定を生成しますか？`,
    );
    phase = ok ? rec.phase : "0-A";
    decidedBy = "confirm";
  } else {
    phase = "0-A"; // 非対話 + フラグ無し → 安全フォールバック
    decidedBy = "fallback";
  }

  // dry-run は副作用ゼロ契約 (CLI help「書き込まない」)。state 書込も remote 適用も行わない。
  // emit は plan.dryRun で既に非書込だが、record/apply は dryRun を見ないため runSetup 側で封鎖する。
  if (!args.dryRun) {
    recordSetupState({ phase, decidedAt: deps.now(), decidedBy, signals: scale }, deps);
  }
  const plan = planSetup(phase, { teams: args.teams, dryRun: args.dryRun });
  const written = emitSetup(plan, deps.templates, deps);
  const branchProtection = args.dryRun
    ? { applied: false, reason: "dry-run" }
    : applyBranchProtection(plan, deps, { apply: args.applyBranchProtection });
  return { phase, written, branchProtection };
}

// ── node 実 deps (real I/O / gh / confirm / templates) ──────────────────────

function readNonEmpty(deps: SetupDeps, path: string): boolean {
  const t = deps.readText(path);
  return t !== null && t.trim().length > 0;
}

/** gh CLI 実行。失敗 (不在/未認証/非0) は {ok:false}。token は扱わない (gh 認証に委譲)。 */
export function nodeGh(args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout };
  } catch (e) {
    const stdout = (e as { stdout?: string })?.stdout;
    return { ok: false, stdout: typeof stdout === "string" ? stdout : "" };
  }
}

/** 対話確認 (isInteractive 時のみ呼ばれる)。stdin から 1 行同期読取。 */
function nodeConfirm(message: string): boolean {
  process.stderr.write(`${message} [y/N] `);
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(0, buf, 0, 16, null);
    const ans = buf.toString("utf8", 0, n).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } catch {
    return false;
  }
}

/** docs/templates/github/{common,team}/ 配下を TemplateSet (相対名→内容) に読み込む。 */
export function loadTemplates(repoRoot: string): TemplateSet {
  const set: TemplateSet = { ...BUILTIN_GITHUB_TEMPLATES };
  const walk = (root: string, dir: string, prefix = ""): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(root, abs, prefix);
      else set[`${prefix}${relative(root, abs).split(sep).join("/")}`] = readFileSync(abs, "utf8");
    }
  };
  const githubRoot = join(repoRoot, "docs", "templates", "github");
  walk(githubRoot, githubRoot);
  const adapterRoot = join(repoRoot, "docs", "templates", "adapter");
  walk(adapterRoot, adapterRoot, "adapter/");
  return set;
}

export function nodeSetupDeps(repoRoot: string): SetupDeps {
  return {
    repoRoot,
    now: () => new Date().toISOString(),
    gh: nodeGh,
    readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeText: (p, c) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    confirm: nodeConfirm,
    isInteractive: Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY) && !process.env.CI,
    templates: loadTemplates(repoRoot),
  };
}
