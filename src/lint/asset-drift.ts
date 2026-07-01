import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export type AssetType = "agent" | "skill" | "prompt";

export interface AssetDoc {
  path: string;
  type: AssetType;
  id: string;
  text: string;
}

export interface AssetDriftInput {
  assets: AssetDoc[];
  skillRootExists: boolean;
  skillDocCount: number;
  allowlist: string[];
  enrolledRootCount: number;
}

export interface AssetDriftViolation {
  kind:
    | "legacy-source-path-residue"
    | "legacy-command-residue"
    | "legacy-runtime-name-residue"
    | "empty-docs-skills"
    | "missing-allowlisted-agent";
  path?: string;
  detail: string;
}

export interface AssetDriftResult {
  ok: boolean;
  checkedAssets: number;
  violations: AssetDriftViolation[];
}

const LEGACY_SOURCE_PATH_PATTERNS = [
  /~\/ai-dev-kit-vscode/,
  /ai-dev-kit-vscode/,
  /C:\\Users\\micro\\ai-dev-kit-vscode/i,
];

const LEGACY_RUNTIME_NAME = ["he", "lix"].join("");
const LEGACY_RUNTIME_ENV_PREFIX = LEGACY_RUNTIME_NAME.toUpperCase();
const LEGACY_COMMAND_PATTERNS = [
  new RegExp(String.raw`\b${LEGACY_RUNTIME_NAME}\s+(codex|claude|plan|gate|handover)\b`, "i"),
];
const LEGACY_RUNTIME_NAME_PATTERNS = [
  new RegExp(String.raw`\bpmo-${LEGACY_RUNTIME_NAME}-`, "i"),
  new RegExp(String.raw`\b${LEGACY_RUNTIME_ENV_PREFIX}(_|\b)`),
];

function hasNonGitkeepFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (entry) => entry.isFile() && entry.name !== ".gitkeep",
  );
}

function loadAssetFiles(repoRoot: string, relDir: string, type: AssetType): AssetDoc[] {
  const dir = join(repoRoot, relDir);
  if (!existsSync(dir)) return [];
  const pending = [dir];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path);
      }
    }
  }
  return files
    .map((path) => ({
      path: relative(repoRoot, path).replace(/\\/g, "/"),
      type,
      id: basename(path, ".md"),
      text: readFileSync(path, "utf8"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function loadAssetDriftInput(repoRoot: string): AssetDriftInput {
  const agentRoot = join(repoRoot, ".claude", "agents");
  const agentMemoryRoot = join(repoRoot, ".claude", "agent-memory");
  const skillRoot = join(repoRoot, "docs", "skills");
  const promptRoot = join(repoRoot, "docs", "templates", "prompts");
  const skillDocs = loadAssetFiles(repoRoot, join("docs", "skills"), "skill");
  const extraSkillFiles = hasNonGitkeepFile(skillRoot) ? 1 : 0;
  return {
    assets: [
      ...loadAssetFiles(repoRoot, join(".claude", "agents"), "agent"),
      ...loadAssetFiles(repoRoot, join(".claude", "agent-memory"), "agent"),
      ...skillDocs,
      ...loadAssetFiles(repoRoot, join("docs", "templates", "prompts"), "prompt"),
    ],
    skillRootExists: existsSync(skillRoot),
    skillDocCount: skillDocs.length + extraSkillFiles,
    allowlist: [],
    enrolledRootCount: [agentRoot, agentMemoryRoot, skillRoot, promptRoot].filter((p) =>
      existsSync(p),
    ).length,
  };
}

export function analyzeAssetDrift(input: AssetDriftInput): AssetDriftResult {
  const violations: AssetDriftViolation[] = [];
  const assetById = new Map(input.assets.filter((a) => a.type === "agent").map((a) => [a.id, a]));

  for (const asset of input.assets) {
    for (const pattern of LEGACY_SOURCE_PATH_PATTERNS) {
      if (pattern.test(asset.text)) {
        violations.push({
          kind: "legacy-source-path-residue",
          path: asset.path,
          detail: "legacy source personal workspace path residue",
        });
        break;
      }
    }
    for (const pattern of LEGACY_COMMAND_PATTERNS) {
      if (pattern.test(asset.text)) {
        violations.push({
          kind: "legacy-command-residue",
          path: asset.path,
          detail: "legacy runtime command delegation residue",
        });
        break;
      }
    }
    for (const pattern of LEGACY_RUNTIME_NAME_PATTERNS) {
      if (pattern.test(asset.text)) {
        violations.push({
          kind: "legacy-runtime-name-residue",
          path: asset.path,
          detail: "legacy runtime name residue",
        });
        break;
      }
    }
  }

  if (input.enrolledRootCount === 0) {
    return {
      ok: true,
      checkedAssets: 0,
      violations: [],
    };
  }

  if (!input.skillRootExists || input.skillDocCount === 0) {
    violations.push({
      kind: "empty-docs-skills",
      path: "docs/skills",
      detail: "docs/skills has no curated non-.gitkeep asset",
    });
  }

  for (const id of input.allowlist) {
    if (!assetById.has(id)) {
      violations.push({
        kind: "missing-allowlisted-agent",
        path: `.claude/agents/${id}.md`,
        detail: "guard allowlist references a missing agent definition",
      });
    }
  }

  return {
    ok: violations.length === 0,
    checkedAssets: input.assets.length,
    violations,
  };
}

export function assetDriftMessages(result: AssetDriftResult): string[] {
  if (result.ok) {
    return [
      `asset-drift - OK (agent/skill/prompt docs=${result.checkedAssets}, legacy_source_path_residue=0, legacy_command_residue=0, legacy_runtime_name_residue=0, allowlist_missing=0)`,
    ];
  }
  return result.violations.map((v) => {
    const loc = v.path ? `${v.path}: ` : "";
    return `asset-drift - violation: ${loc}${v.kind} (${v.detail})`;
  });
}
