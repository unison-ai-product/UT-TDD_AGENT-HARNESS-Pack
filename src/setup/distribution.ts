import { COMMON_FILES } from "./templates";

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

export const DEFAULT_PACK_REPO = "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack";
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

// Clean Pack excludes source-only governance docs, so its default `test` script
// must stay on this distributable smoke suite instead of raw `vitest run`.
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

function shellQuotePath(path: string): string {
  return `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function gitAddPathspecCommands(
  repoDir: string,
  artifactPaths: readonly string[],
): string[] {
  const commands: string[] = [];
  const chunkSize = 80;
  for (let i = 0; i < artifactPaths.length; i += chunkSize) {
    const chunk = artifactPaths
      .slice(i, i + chunkSize)
      .map(shellQuotePath)
      .join(" ");
    commands.push(`git -C ${repoDir} add -- ${chunk}`);
  }
  return commands;
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
  const cleanRepo = input.cleanRepo ?? DEFAULT_PACK_REPO;
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
  cleanRepo?: string;
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
  const cleanRepo = input.cleanRepo ?? DEFAULT_PACK_REPO;
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
      tagPin: `github:${cleanRepo}#${tag}`,
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
      ...gitAddPathspecCommands(input.stagingDir, input.exportPlan.artifactPaths),
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
