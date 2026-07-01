/**
 * Pure skill.v1 scaffold generator.
 *
 * The generator returns content, target path, and self-lint findings without
 * writing files. The CLI owns collision handling and filesystem writes.
 */

import {
  analyzeSkillAssignments,
  VALID_SKILL_CATEGORIES,
  VALID_SKILL_DRIVE_MODELS,
  VALID_SKILL_LAYERS,
} from "../lint/skill-assignment";

export type SkillCategory = (typeof VALID_SKILL_CATEGORIES)[number];

export interface ScaffoldSkillInput {
  name: string;
  category: SkillCategory;
  skillType?: string;
  layers?: string[];
  driveModels?: string[];
  domainTags?: string[];
  industry?: string;
  description?: string;
}

export interface ScaffoldSkillDeps {
  /** Return true when the repo-relative output path already exists. */
  exists?: (relPath: string) => boolean;
  /** Consumer-owned output root for category=project skills. */
  projectSkillRoot?: string;
}

export interface ScaffoldSkillResult {
  ok: boolean;
  path: string;
  content: string;
  category: SkillCategory;
  findings: string[];
}

const PRODUCT_SKILL_ROOT = "docs/skills";
const DEFAULT_PROJECT_SKILL_ROOT = ".ut-tdd/skills";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort();
}

function yamlList(values: string[]): string {
  return values.map((v) => `  - ${v}`).join("\n");
}

/** Output root by distribution boundary: product skills vs consumer-owned skills. */
export function skillOutputRoot(category: SkillCategory, deps: ScaffoldSkillDeps = {}): string {
  if (category === "project") return deps.projectSkillRoot ?? DEFAULT_PROJECT_SKILL_ROOT;
  return PRODUCT_SKILL_ROOT;
}

export function scaffoldSkill(
  input: ScaffoldSkillInput,
  deps: ScaffoldSkillDeps = {},
): ScaffoldSkillResult {
  const findings: string[] = [];
  const name = slugify(input.name);
  const category = input.category;
  const skillType = (input.skillType ?? category).trim() || category;
  const layers = uniqueSorted(input.layers ?? []);
  const driveModels = uniqueSorted(input.driveModels ?? []);
  const domainTags = uniqueSorted(input.domainTags ?? []);
  const industry = (input.industry ?? "").trim();
  const description = (input.description ?? `${name} skill`).trim();

  if (!name) findings.push("invalid-name: name must produce a non-empty slug");
  if (!VALID_SKILL_CATEGORIES.includes(category)) {
    findings.push(`unknown-category: ${input.category}`);
  }
  for (const layer of layers) {
    if (!VALID_SKILL_LAYERS.includes(layer as (typeof VALID_SKILL_LAYERS)[number])) {
      findings.push(`unknown-layer: ${layer}`);
    }
  }
  for (const driveModel of driveModels) {
    if (
      !VALID_SKILL_DRIVE_MODELS.includes(driveModel as (typeof VALID_SKILL_DRIVE_MODELS)[number])
    ) {
      findings.push(`unknown-drive-model: ${driveModel}`);
    }
  }

  const root = skillOutputRoot(category, deps);
  const path = `${root}/${name || "skill"}.md`;
  if (deps.exists?.(path)) {
    findings.push(`name-collision: ${path} already exists (not overwritten)`);
  }

  const lines: string[] = ["---", "schema_version: skill.v1", `name: ${name}`];
  lines.push(`skill_type: ${skillType}`);
  lines.push(`category: ${category}`);
  if (layers.length > 0 || driveModels.length > 0) {
    lines.push("applies_to:");
    if (layers.length > 0) lines.push("  layers:", ...layers.map((v) => `    - ${v}`));
    if (driveModels.length > 0) {
      lines.push("  drive_models:", ...driveModels.map((v) => `    - ${v}`));
    }
  }
  if (domainTags.length > 0) lines.push("domain_tags:", yamlList(domainTags));
  if (industry) lines.push(`industry: ${industry}`);
  lines.push(`triggers: ${description}`);
  lines.push("---", "");
  lines.push(`# ${name}`, "", description, "", "## When to load this skill", "", "- TODO", "");
  const content = lines.join("\n");

  const metadata: Record<string, unknown> = {
    skill_type: skillType,
    category,
    applies_to: { layers, drive_models: driveModels },
  };
  const lint = analyzeSkillAssignments([{ path, metadata }]);
  if (!lint.ok) {
    for (const violation of lint.violations) {
      findings.push(`self-lint:${violation.kind}${violation.value ? `:${violation.value}` : ""}`);
    }
  }

  return { ok: findings.length === 0, path, content, category, findings };
}
