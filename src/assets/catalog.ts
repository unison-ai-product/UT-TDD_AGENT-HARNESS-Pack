import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { upsertSearchReference } from "../search/index.ts";
import { resolveSkillFiles } from "../shared/embedded-skills.ts";
import type { HarnessDb } from "../state-db/index.ts";
import { upsertRow } from "../state-db/index.ts";

export interface CatalogAutomationAssetsInput {
  repoRoot?: string;
  db: HarnessDb;
}

export interface AssetCatalogFinding {
  kind:
    | "asset-drift"
    | "empty-catalog"
    | "invalid-root"
    | "optional-root-empty"
    | "invalid-skill-metadata"
    | "duplicate-skill-id";
  severity: "error" | "warn" | "info";
  subject_id: string;
  evidence_path: string;
}

export interface AssetCatalogResult {
  ok: boolean;
  assets: string[];
  findings: AssetCatalogFinding[];
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  path: string;
  skill_type: string;
  category: string;
  applies_layers: string[];
  applies_drive_models: string[];
}

export interface SkillCatalogResult {
  ok: boolean;
  entries: SkillCatalogEntry[];
  findings: AssetCatalogFinding[];
  scannedRoots: string[];
  optionalRoots: string[];
}

interface AssetSource {
  type: "skill" | "command";
  root: string;
}

const DEFAULT_SKILL_ROOTS = ["skills", "docs/skills"] as const;

function defaultSkillRoot(repoRoot: string): string {
  return DEFAULT_SKILL_ROOTS.find((root) => existsSync(join(repoRoot, root))) ?? "docs/skills";
}

function assetSources(repoRoot: string): AssetSource[] {
  return [
    { type: "skill", root: defaultSkillRoot(repoRoot) },
    { type: "command", root: "docs/commands" },
  ];
}

function normalizeRel(path: string): string {
  return path.replaceAll("\\", "/");
}

function assetFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...assetFiles(path));
    else if (name.isFile() && /\.(md|ya?ml)$/i.test(name.name)) out.push(path);
  }
  return out.sort();
}

function frontmatterValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?`, "m"));
  return match?.[1]?.trim() ?? "";
}

function markdownFrontmatter(content: string): string {
  if (!content.startsWith("---")) return "";
  const end = content.indexOf("\n---", 3);
  return end < 0 ? "" : content.slice(3, end);
}

function metadataFromContent(path: string, content: string): Record<string, unknown> {
  const raw = /\.md$/i.test(path) ? markdownFrontmatter(content) : content;
  if (!raw.trim()) return {};
  const parsed = parseYaml(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function metadataResultFromContent(
  path: string,
  content: string,
): { ok: true; metadata: Record<string, unknown> } | { ok: false; message: string } {
  try {
    return { ok: true, metadata: metadataFromContent(path, content) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

function filenameStem(path: string): string {
  return (
    path
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.replace(/\.(md|ya?ml)$/i, "") ?? path
  );
}

function skillCatalogEntry(
  repoRoot: string,
  path: string,
): SkillCatalogEntry | AssetCatalogFinding {
  const rel = normalizeRel(relative(repoRoot, path));
  const content = readFileSync(path, "utf8");
  const metadata = metadataResultFromContent(path, content);
  if (!metadata.ok) {
    return {
      kind: "invalid-skill-metadata",
      severity: "error",
      subject_id: rel,
      evidence_path: rel,
    };
  }
  const appliesTo =
    metadata.metadata.applies_to && typeof metadata.metadata.applies_to === "object"
      ? (metadata.metadata.applies_to as Record<string, unknown>)
      : {};
  const name =
    (typeof metadata.metadata.name === "string" ? metadata.metadata.name.trim() : "") ||
    filenameStem(path);
  const skillType =
    typeof metadata.metadata.skill_type === "string" ? metadata.metadata.skill_type.trim() : "";
  const category =
    typeof metadata.metadata.category === "string" ? metadata.metadata.category.trim() : "";
  return {
    id: `skill:${name}`,
    name,
    path: rel,
    skill_type: skillType,
    category,
    applies_layers: stringList(appliesTo.layers).sort(),
    applies_drive_models: stringList(appliesTo.drive_models).sort(),
  };
}

export function scanSkillCatalog(
  input: { repoRoot?: string; root?: string; optionalRoots?: string[] } = {},
): SkillCatalogResult {
  const repoRoot = input.repoRoot ?? process.cwd();
  const roots = input.root ? [input.root] : [defaultSkillRoot(repoRoot)];
  const root = roots[0] ?? "docs/skills";
  const optionalRoots = [...(input.optionalRoots ?? [])].sort();
  const findings: AssetCatalogFinding[] = [];
  const entries: SkillCatalogEntry[] = [];

  const primaryFiles = input.root
    ? assetFiles(join(repoRoot, roots[0] ?? "")).filter((path) => /\.md$/i.test(path))
    : resolveSkillFiles(repoRoot)
        .map((entry) => entry.absolutePath)
        .filter((path) => /\.md$/i.test(path));
  for (const path of primaryFiles) {
    const entry = skillCatalogEntry(repoRoot, path);
    if ("kind" in entry) findings.push(entry);
    else entries.push(entry);
  }

  for (const optionalRoot of optionalRoots) {
    const absoluteRoot = join(repoRoot, optionalRoot);
    const files = assetFiles(absoluteRoot).filter((path) => /\.md$/i.test(path));
    if (files.length === 0) {
      findings.push({
        kind: "optional-root-empty",
        severity: "info",
        subject_id: optionalRoot,
        evidence_path: optionalRoot,
      });
      continue;
    }
    for (const path of files) {
      const entry = skillCatalogEntry(repoRoot, path);
      if ("kind" in entry) findings.push(entry);
      else entries.push(entry);
    }
  }

  const seen = new Map<string, SkillCatalogEntry>();
  for (const entry of entries) {
    const previous = seen.get(entry.id);
    if (previous != null) {
      findings.push({
        kind: "duplicate-skill-id",
        severity: "error",
        subject_id: entry.id,
        evidence_path: `${previous.path},${entry.path}`,
      });
      continue;
    }
    seen.set(entry.id, entry);
  }

  if (entries.length === 0) {
    findings.push({
      kind: "empty-catalog",
      severity: "warn",
      subject_id: "skill_catalog",
      evidence_path: root,
    });
  }

  return {
    ok: !findings.some(
      (finding) => finding.severity === "error" || finding.kind === "empty-catalog",
    ),
    entries: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.subject_id.localeCompare(b.subject_id),
    ),
    scannedRoots: roots,
    optionalRoots,
  };
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

function recordFinding(db: HarnessDb, finding: AssetCatalogFinding): void {
  upsertRow(db, {
    table: "findings",
    primaryKey: "finding_id",
    row: {
      finding_id: `finding:${finding.kind}:${finding.subject_id}`.replace(
        /[^A-Za-z0-9._:-]+/g,
        "-",
      ),
      kind: finding.kind,
      severity: finding.severity,
      subject_id: finding.subject_id,
      source: "asset-catalog",
      status: "open",
      evidence_path: finding.evidence_path,
    },
  });
}

const LEGACY_RUNTIME_NAME = ["he", "lix"].join("");
const LEGACY_RUNTIME_ENV_PREFIX = LEGACY_RUNTIME_NAME.toUpperCase();
const LEGACY_DRIFT_PATTERNS = [
  new RegExp(String.raw`\b${LEGACY_RUNTIME_NAME}\s+(codex|claude|plan|gate|handover)\b`, "i"),
  new RegExp(String.raw`\bpmo-${LEGACY_RUNTIME_NAME}-`, "i"),
  new RegExp(String.raw`\b${LEGACY_RUNTIME_ENV_PREFIX}(_|\b)`),
];

function driftStatus(content: string): "current" | "drift" {
  return LEGACY_DRIFT_PATTERNS.some((pattern) => pattern.test(content)) ? "drift" : "current";
}

export function catalogAutomationAssets(input: CatalogAutomationAssetsInput): AssetCatalogResult {
  const repoRoot = input.repoRoot ?? process.cwd();
  const indexedAt = new Date().toISOString();
  const assets: string[] = [];
  const findings: AssetCatalogFinding[] = [];
  const sources = assetSources(repoRoot);

  for (const source of sources) {
    const files =
      source.type === "skill"
        ? resolveSkillFiles(repoRoot).map((entry) => entry.absolutePath)
        : assetFiles(join(repoRoot, source.root));
    for (const path of files) {
      const rel = normalizeRel(relative(repoRoot, path));
      if (
        source.type !== "skill" &&
        !sources.some((allowed) => rel === allowed.root || rel.startsWith(`${allowed.root}/`))
      ) {
        const finding: AssetCatalogFinding = {
          kind: "invalid-root",
          severity: "error",
          subject_id: rel,
          evidence_path: rel,
        };
        findings.push(finding);
        recordFinding(input.db, finding);
        continue;
      }
      const content = readFileSync(path, "utf8");
      const metadata = metadataFromContent(path, content);
      const appliesTo =
        metadata.applies_to && typeof metadata.applies_to === "object"
          ? (metadata.applies_to as Record<string, unknown>)
          : {};
      const name =
        (typeof metadata.name === "string" ? metadata.name : "") ||
        frontmatterValue(content, "name") ||
        rel
          .split("/")
          .at(-1)
          ?.replace(/\.(md|ya?ml)$/i, "") ||
        rel;
      const status = driftStatus(content);
      const assetId = `${source.type}:${name}`;
      const category = source.type === "skill" ? String(metadata.category ?? "").trim() : "";
      const domainTags = source.type === "skill" ? stringList(metadata.domain_tags) : [];
      const industry =
        source.type === "skill" && typeof metadata.industry === "string"
          ? metadata.industry.trim()
          : "";
      const baseTrigger =
        frontmatterValue(content, "triggers") || frontmatterValue(content, "description");
      // domain_tags / industry は situation 索引子なので trigger に畳み込み、scoreSkill の
      // metadata 重なり (de-saturate) と FTS tokens の双方へ流す (skill-index.md §5)。
      const trigger = [baseTrigger, domainTags.join(" "), industry].filter(Boolean).join(" ");
      const role = frontmatterValue(content, "role");
      const capability =
        frontmatterValue(content, "description") || `${source.type} metadata from ${rel}`;
      const skillType = source.type === "skill" ? String(metadata.skill_type ?? "") : "";
      const appliesLayers =
        source.type === "skill" ? stringList(appliesTo.layers).sort().join(",") : "";
      const appliesDriveModels =
        source.type === "skill" ? stringList(appliesTo.drive_models).sort().join(",") : "";
      upsertRow(input.db, {
        table: "automation_assets",
        primaryKey: "asset_id",
        row: {
          asset_id: assetId,
          asset_type: source.type,
          path: rel,
          trigger,
          role,
          capability,
          skill_type: skillType,
          category,
          applies_layers: appliesLayers,
          applies_drive_models: appliesDriveModels,
          drift_status: status,
          indexed_at: indexedAt,
        },
      });
      upsertSearchReference(input.db, {
        subject_type: "automation_asset",
        subject_id: assetId,
        path: rel,
        title: name,
        tokens: `${source.type} ${trigger} ${role} ${capability} ${skillType} ${category} ${appliesLayers} ${appliesDriveModels}`,
        summary: `${source.type} ${status}`,
        updated_at: indexedAt,
      });
      assets.push(assetId);
      if (status === "drift") {
        const finding: AssetCatalogFinding = {
          kind: "asset-drift",
          severity: "warn",
          subject_id: assetId,
          evidence_path: rel,
        };
        findings.push(finding);
        recordFinding(input.db, finding);
      }
    }
  }

  if (assets.length === 0) {
    const finding: AssetCatalogFinding = {
      kind: "empty-catalog",
      severity: "warn",
      subject_id: "automation_assets",
      evidence_path: "",
    };
    findings.push(finding);
    recordFinding(input.db, finding);
  }

  return {
    ok: findings.every((finding) => finding.severity !== "error" && finding.kind !== "asset-drift"),
    assets: assets.sort(),
    findings: findings.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.subject_id.localeCompare(b.subject_id),
    ),
  };
}
