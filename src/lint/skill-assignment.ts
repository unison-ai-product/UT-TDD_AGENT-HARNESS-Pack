import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

export const VALID_SKILL_LAYERS = [
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8",
  "L9",
  "L10",
  "L11",
  "L12",
  "L13",
  "L14",
] as const;

export const VALID_SKILL_DRIVE_MODELS = [
  "Forward",
  "Discovery",
  "Scrum",
  "Reverse",
  "Recovery",
  "Incident",
  "Refactor",
  "Retrofit",
  "Add-feature",
  "Research",
] as const;

/**
 * skill category (skill-index.md §2):
 * - workflow: indexed by layer / drive model.
 * - domain/project: indexed by category and metadata as situation-pull skills.
 */
export const VALID_SKILL_CATEGORIES = ["workflow", "domain", "project"] as const;

/** If layer / drive model is empty, domain/project category can still make the skill indexable. */
const INDEXABLE_CATEGORIES = new Set<string>(["domain", "project"]);
const DEFAULT_SKILL_ROOTS = ["skills", "docs/skills"] as const;

export interface SkillAssignmentDoc {
  path: string;
  metadata: Record<string, unknown>;
}

export interface SkillAssignmentViolation {
  path: string;
  kind:
    | "missing-skill-type"
    | "unknown-layer"
    | "unknown-drive-model"
    | "unknown-category"
    | "not-indexable";
  value?: string;
}

export interface SkillAssignmentResult {
  ok: boolean;
  checked: number;
  violations: SkillAssignmentViolation[];
}

function skillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(path));
    else if (entry.isFile() && /\.(md|ya?ml)$/i.test(entry.name)) out.push(path);
  }
  return out.sort();
}

function markdownFrontmatter(content: string): string {
  if (!content.startsWith("---")) return "";
  const end = content.indexOf("\n---", 3);
  return end < 0 ? "" : content.slice(3, end);
}

function parseMetadata(path: string): Record<string, unknown> {
  const content = readFileSync(path, "utf8");
  const raw = /\.md$/i.test(path) ? markdownFrontmatter(content) : content;
  if (!raw.trim()) return {};
  const parsed = parseYaml(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

export function loadSkillAssignmentDocs(repoRoot: string): SkillAssignmentDoc[] {
  const rootRel =
    DEFAULT_SKILL_ROOTS.find((root) => existsSync(join(repoRoot, root))) ?? "docs/skills";
  const root = join(repoRoot, rootRel);
  return skillFiles(root).map((path) => ({
    path: relative(repoRoot, path).replace(/\\/g, "/"),
    metadata: parseMetadata(path),
  }));
}

export function analyzeSkillAssignments(docs: SkillAssignmentDoc[]): SkillAssignmentResult {
  const violations: SkillAssignmentViolation[] = [];
  const validLayers = new Set<string>(VALID_SKILL_LAYERS);
  const validDriveModels = new Set<string>(VALID_SKILL_DRIVE_MODELS);
  const validCategories = new Set<string>(VALID_SKILL_CATEGORIES);

  for (const doc of docs) {
    const skillType = doc.metadata.skill_type;
    if (typeof skillType !== "string" || skillType.trim().length === 0) {
      violations.push({ path: doc.path, kind: "missing-skill-type" });
    }

    const appliesTo =
      doc.metadata.applies_to && typeof doc.metadata.applies_to === "object"
        ? (doc.metadata.applies_to as Record<string, unknown>)
        : {};
    const layers = stringList(appliesTo.layers);
    for (const layer of layers) {
      if (!validLayers.has(layer)) {
        violations.push({ path: doc.path, kind: "unknown-layer", value: layer });
      }
    }

    const driveModels = stringList(appliesTo.drive_models);
    for (const driveModel of driveModels) {
      if (!validDriveModels.has(driveModel)) {
        violations.push({
          path: doc.path,
          kind: "unknown-drive-model",
          value: driveModel,
        });
      }
    }

    const category = typeof doc.metadata.category === "string" ? doc.metadata.category.trim() : "";
    if (category.length > 0 && !validCategories.has(category)) {
      violations.push({ path: doc.path, kind: "unknown-category", value: category });
    }

    const indexable =
      layers.length > 0 || driveModels.length > 0 || INDEXABLE_CATEGORIES.has(category);
    if (!indexable) {
      violations.push({ path: doc.path, kind: "not-indexable" });
    }
  }

  return {
    ok: docs.length > 0 && violations.length === 0,
    checked: docs.length,
    violations,
  };
}

export function skillAssignmentMessages(result: SkillAssignmentResult): string[] {
  if (result.ok) {
    return [`skill-assignment - OK (checked=${result.checked}, indexable by L+drive or category)`];
  }
  if (result.checked === 0) {
    return ["skill-assignment - violation: skills or docs/skills has no skill definitions"];
  }
  return result.violations.map((v) => {
    const value = v.value ? ` value=${v.value}` : "";
    return `skill-assignment - violation: ${v.path}: ${v.kind}${value}`;
  });
}
