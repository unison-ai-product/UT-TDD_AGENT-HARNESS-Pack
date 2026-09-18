import { satisfies, valid, validRange } from "semver";
import {
  AUTHORING_TEMPLATE_ARTIFACT_PATHS,
  AUTHORING_TEMPLATE_INVENTORY,
  type AuthoringTemplateInventoryEntry,
  authoringArtifactPath,
  authoringSourcePath,
  validateAuthoringTemplateInventory,
} from "./authoring-template-inventory.ts";
import {
  type ConsumerNodeRuntimeReadinessInput,
  type ConsumerRuntimeDenyReason,
  validateConsumerReadiness,
} from "./consumer-node-runtime.ts";
import { COMMON_FILES } from "./templates.ts";

export interface CleanDistributionPlan {
  ok: boolean;
  channel: "clean-repo-plus-tarball";
  sourceTag: string;
  cleanRepo: string;
  artifactPaths: string[];
  excludedPaths: string[];
  missingRequired: string[];
  denylistViolations: string[];
  authoringInventory: {
    ok: boolean;
    missingFamilies: string[];
    duplicateFamilies: string[];
    unknownFamilies: string[];
    duplicateArtifactPaths: string[];
    missingArtifactPaths: string[];
  };
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
  /** Consumer-local sealed runtime is the authority when supplied by setup. */
  consumerRuntime?: { ok: boolean; reason?: ConsumerRuntimeDenyReason };
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

/** package/release-plan が共有する、release artifact の安全なファイル名変換。 */
export function releaseArtifactStem(sourceTag: string): string {
  return sourceTag.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function releaseArtifactFileNames(sourceTag: string): {
  tarball: string;
  checksum: string;
  manifest: string;
} {
  const stem = releaseArtifactStem(sourceTag);
  const tarball = `${stem}.tar.gz`;
  return {
    tarball,
    checksum: `${tarball}.sha256`,
    manifest: `${stem}.manifest.json`,
  };
}

const CLEAN_REQUIRED_PATHS = [
  "README.md",
  "LICENSE",
  "package.json",
  ".node-version",
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
  // toolchain-pin (doctor) reads .node-version; the Pack CI runs the same check.
  ".node-version",
  ".github/workflows/harness-check.yml",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "biome.json",
  "package-lock.json",
  "docs/governance/README.md",
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

function isAllowedCleanPath(
  path: string,
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): boolean {
  const p = normalizeDistributionPath(path);
  if (CLEAN_ALLOW_FILES.has(p)) return true;
  return (
    CLEAN_ALLOW_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
    authoringArtifactPath(p, inventory) !== null ||
    authoringSourcePath(p, inventory) !== null
  );
}

export function cleanDistributionArtifactPath(
  path: string,
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): string {
  const p = normalizeDistributionPath(path);
  const authoring = authoringArtifactPath(p, inventory);
  if (authoring !== null) return authoring;
  if (p.startsWith("docs/skills/")) return `skills/${p.slice("docs/skills/".length)}`;
  return p;
}

export function cleanDistributionSourcePath(
  artifactPath: string,
  sourcePaths: Iterable<string>,
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): string {
  const artifact = normalizeDistributionPath(artifactPath);
  if (artifact === ".github/workflows/harness-check.yml") {
    return "docs/templates/github/common/pack-harness-check.yml";
  }
  const sources = new Set([...sourcePaths].map(normalizeDistributionPath));
  const authoring = authoringSourcePath(artifact, inventory);
  if (authoring !== null) {
    // The destination itself is the only valid source once the artifact is already in a
    // clean Pack checkout. In a source checkout, the explicit source path is required.
    if (sources.has(artifact)) return artifact;
    return authoring;
  }
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
  "node scripts/run-vitest-snapshot.ts tests/setup.test.ts tests/distribution-acceptance.test.ts tests/skill-recommend.test.ts tests/skill-scaffold.test.ts tests/dependency-drift.test.ts tests/readability.test.ts tests/toolchain-pin.test.ts --reporter=dot";

// Source repo's package.json points at the source development repo (issue #83);
// the clean Pack artifact must keep pointing at the public Pack repo instead.
export const PACK_REPOSITORY_URL =
  "git+https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack.git";

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
  scripts.test = "npm run test:pack";
  // PLAN-L7-522 §2.1.1: source の build script remains the rollback route, but
  // generated consumers must not retain a reachable non-Node build path.
  delete scripts.build;
  const utTdd = {
    ...((parsed.utTdd as Record<string, unknown> | undefined) ?? {}),
    artifactProfile: "pack",
  };
  const repository = { type: "git", url: PACK_REPOSITORY_URL };
  return `${JSON.stringify({ ...parsed, scripts, utTdd, repository }, null, 2)}\n`;
}

function shellQuotePath(path: string): string {
  return `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function gitAddPathspecCommands(
  repoDir: string,
  artifactPaths: readonly string[],
  removedPaths: readonly string[] = [],
): string[] {
  const commands: string[] = [];
  const chunkSize = 80;
  const addCommands = (verb: string, paths: readonly string[]): void => {
    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths
        .slice(i, i + chunkSize)
        .map(shellQuotePath)
        .join(" ");
      commands.push(`git -C ${repoDir} ${verb} -- ${chunk}`);
    }
  };
  addCommands("add", artifactPaths);
  addCommands("rm --ignore-unmatch", removedPaths);
  return commands;
}

/**
 * PLAN-L7-522 §2.2 (S1-a): readiness の runtime 検査は Node authority を見る。
 * 判定基準は consumer package root の `engines.node` であり、ここで別の pin を持たない
 * (第二の正本を作らない)。`required` が空なら fail-close する。
 */
function satisfiesRequiredNode(version: string | null, required: string | null): boolean {
  const observed = version?.trim();
  const range = required?.trim();
  return Boolean(
    observed && range && valid(observed) && validRange(range) && satisfies(observed, range),
  );
}

export function buildCleanDistributionPlan(input: {
  paths: readonly string[];
  sourceTag?: string;
  cleanRepo?: string;
  authoringInventory?: readonly AuthoringTemplateInventoryEntry[];
}): CleanDistributionPlan {
  const sourceTag = input.sourceTag ?? "unreleased";
  const cleanRepo = input.cleanRepo ?? DEFAULT_PACK_REPO;
  const inventory = input.authoringInventory ?? AUTHORING_TEMPLATE_INVENTORY;
  const inventoryResult = validateAuthoringTemplateInventory(inventory);
  const normalized = [...new Set(input.paths.map(normalizeDistributionPath))].sort();
  const includedSourcePaths = normalized.filter((path) => isAllowedCleanPath(path, inventory));
  // Projection must be resolved before the output deny fence: the team source is intentionally
  // under .ut-tdd, but its destination is a normal docs/templates artifact.
  const artifactPaths = [
    ...new Set(
      includedSourcePaths
        .map((path) => cleanDistributionArtifactPath(path, inventory))
        .filter((path) => !isDeniedCleanPath(path)),
    ),
  ].sort();
  // D-2 fail-close (PLAN-L7-413 followup): violation は **最終出荷集合 (artifactPaths)** を
  // deny で監視する。include filter の退行や remap の denied 空間衝突で denied path が
  // 出荷側に達したときのみ fire する出力ガード。denied な入力 path 自体は通常の除外
  // (excludedPaths) — 全 denied 入力を fail にすると full repo walk (.ut-tdd/ 等常在) と
  // 意図的 carve-out (src/web/ は tracked .gitkeep を持つ) で plan が恒常 blocked になる
  // (PR #42 の過剰 fail-close、cli-surface 実 repo 回帰で検出)。「denied 入力が出荷されない」
  // 側の fence は tests/distribution-acceptance.test.ts の D-2 テストが固定する。
  const denylistViolations = artifactPaths.filter(isDeniedCleanPath);
  const artifactSet = new Set(artifactPaths);
  const missingRequired = [...CLEAN_REQUIRED_PATHS, ...AUTHORING_TEMPLATE_ARTIFACT_PATHS].filter(
    (path, index, required) => required.indexOf(path) === index && !artifactSet.has(path),
  );
  const includedSourceSet = new Set(includedSourcePaths);
  // A path can pass the source allowlist and still be removed by the output deny fence
  // (for example the tracked `src/web/` carve-out). Report that source as excluded too;
  // otherwise callers see neither an artifact nor an exclusion for a denied input.
  const excludedPaths = normalized.filter(
    (path) =>
      !includedSourceSet.has(path) ||
      isDeniedCleanPath(cleanDistributionArtifactPath(path, inventory)),
  );
  const authoringInventory = {
    ok: inventoryResult.ok,
    missingFamilies: [...inventoryResult.missingFamilies],
    duplicateFamilies: [...inventoryResult.duplicateFamilies],
    unknownFamilies: [...inventoryResult.unknownFamilies],
    duplicateArtifactPaths: [...inventoryResult.duplicateArtifactPaths],
    missingArtifactPaths: [...inventoryResult.missingArtifactPaths],
  };
  return {
    ok: inventoryResult.ok && missingRequired.length === 0 && denylistViolations.length === 0,
    channel: "clean-repo-plus-tarball",
    sourceTag,
    cleanRepo,
    artifactPaths,
    excludedPaths,
    missingRequired,
    denylistViolations,
    authoringInventory,
    releaseIntegrity: {
      required: true,
      artifacts: [`${sourceTag}.tar.gz`, `${sourceTag}.tar.gz.sha256`],
    },
  };
}

export function buildConsumerReadinessPlan(input: {
  nodeVersion: string | null;
  requiredNodeVersion: string | null;
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
  consumerRuntime?: ConsumerNodeRuntimeReadinessInput;
}): ConsumerReadinessPlan {
  const nodeOk = satisfiesRequiredNode(input.nodeVersion, input.requiredNodeVersion);
  const mode =
    input.hasClaude && input.hasCodex
      ? "hybrid"
      : input.hasClaude
        ? "claude-only"
        : input.hasCodex
          ? "codex-only"
          : "standalone";
  // check 名は評価の意味論と一致させる。bare version の `engines.node` は npm 意味論で
  // 厳密一致なので `node>=x` と表示してはならない。
  const nodeCheckName = input.requiredNodeVersion
    ? `node@${input.requiredNodeVersion}`
    : "node engines.node (missing)";
  // `hasUtTddCli` is an observation only.  Readiness is granted exclusively
  // by the consumer-local sealed runtime and its receipt chain.
  const sealedRuntime = validateConsumerReadiness(input.consumerRuntime);
  const checks = [
    {
      name: nodeCheckName,
      ok: nodeOk,
      message: nodeOk
        ? `Node ${input.nodeVersion}`
        : input.requiredNodeVersion
          ? `Install a Node version satisfying ${input.requiredNodeVersion} before setup (observed ${input.nodeVersion ?? "none"})`
          : "package.json engines.node is missing; cannot verify the Node runtime",
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
      ok: sealedRuntime.ok,
      message: sealedRuntime.ok
        ? "consumer-local sealed Node runtime is available for projected hooks"
        : (input.utTddCliMessage ??
          [
            "Generated Claude/Codex hooks resolve only the consumer-local sealed Node runtime.",
            `Runtime admission: ${sealedRuntime.reason ?? "consumer_runtime_absent"}.`,
            "Source checkouts and TypeScript package paths are not fallback candidates.",
          ].join(" ")),
    },
    {
      name: "runtime-cli",
      ok: true,
      message:
        input.hasClaude || input.hasCodex
          ? `mode=${mode}`
          : "mode=standalone; setup can continue, but judgment gates require human review or a later Claude/Codex login",
    },
  ];
  const packageRoot = input.packageRoot ?? input.repoRoot;
  const tag = input.tag ?? "v0.1.0";
  const cleanRepo = input.cleanRepo ?? DEFAULT_PACK_REPO;
  return {
    ok: nodeOk && input.hasGit && sealedRuntime.ok,
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
        "actions/setup-node@v4",
        "npm ci --no-audit --no-fund",
        "npm run typecheck",
        "npm test",
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
        "node .ut-tdd/bin/ut-tdd.mjs setup --dry-run",
        "node .ut-tdd/bin/ut-tdd.mjs setup --solo",
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
    ...(sealedRuntime ? { consumerRuntime: sealedRuntime } : {}),
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
      "tarball and GitHub release publication remain separate human-approved operations",
    ],
    publishRequiresPoApproval: true,
    destructiveRemoteMutation: false,
  };
}
