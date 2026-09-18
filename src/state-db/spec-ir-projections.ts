import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { isValidSubDocForLayer, V_MODEL_PAIRS } from "../schema/index.ts";
import { isSecretLike } from "../secret.ts";
import { stableId } from "../stable-id.ts";
import {
  canonicalPlanRevision,
  resolvePlanRevisionIdentity,
} from "./github-review-lane-provenance.ts";
import type { HarnessDb } from "./index.ts";

type SpecIrSourceKind =
  | "plan"
  | "design_doc"
  | "test_design"
  | "reference_doc"
  | "schedule_doc"
  | "activation_profile"
  | "document_catalog"
  | "document_scale_profile"
  | "typed_spec"
  | "agent_contracts"
  | "refactor_qa_release_contract";

interface SpecIrSource {
  kind: SpecIrSourceKind;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  sourceHash: string;
}

interface TypedSpecDeclaration {
  id: string;
  kind: string;
  traces_from: string[];
  traces_to: string[];
  tests: string[];
}

export interface SpecDefRow {
  spec_id: string;
  spec_kind: string;
  layer: string;
  sub_doc: string;
  owner_artifact_id: string;
  owner_path: string;
  section_anchor: string;
  title: string;
  lifecycle_status: string;
  plan_id: string;
  source_path: string;
  source_hash: string;
  indexed_at: string;
}

export interface SpecRelationRow {
  relation_id: string;
  from_spec_id: string;
  to_spec_id: string;
  relation_kind: string;
  plan_id: string;
  status: string;
  source: string;
  evidence_path: string;
  indexed_at: string;
}

export interface ScheduleEntryRow {
  schedule_entry_id: string;
  plan_id: string;
  layer: string;
  sub_doc: string;
  v_pair: string;
  predecessor_plan_ids: string;
  current_location: string;
  rag: string;
  status: string;
  blocked_reason: string;
  source_path: string;
  plan_revision?: string;
  source_hash: string;
  indexed_at: string;
}

export interface ActivationEntryRow {
  activation_entry_id: string;
  profile_id: string;
  target_kind: string;
  target_id: string;
  scope_status: string;
  target_version: string;
  defer_reason: string;
  enabled: number;
  source_path: string;
  plan_id: string;
  indexed_at: string;
}

export interface ActivationScheduleReviewRow {
  activation_schedule_review_id: string;
  profile_id: string;
  plan_id: string;
  schedule_entry_id: string;
  activation_entry_id: string;
  target_kind: string;
  target_id: string;
  scope_status: string;
  enabled: number;
  target_version: string;
  defer_reason: string;
  current_location: string;
  rag: string;
  schedule_status: string;
  layer: string;
  sub_doc: string;
  v_pair: string;
  source_path: string;
  indexed_at: string;
}

export interface DocumentCatalogEntryRow {
  document_catalog_entry_id: string;
  doc_type_id: string;
  layer: string;
  sub_doc: string;
  category: string;
  requirement_class: string;
  applicability: string;
  default_status: string;
  source_doc_family: string;
  authoring_source_path: string;
  projection_table: string;
  profile_controlled: number;
  skip_reason_required: number;
  source_path: string;
  indexed_at: string;
}

export interface DocumentScaleProfileEntryRow {
  document_scale_profile_entry_id: string;
  profile_id: string;
  doc_type_id: string;
  decision: string;
  detail_override: string;
  status_override: string;
  reason: string;
  required_plan_id: string | null;
  row_digest: string;
  source_path: string;
  indexed_at: string;
}

export interface DocumentScaleProfileReviewRow {
  document_scale_profile_review_id: string;
  profile_id: string;
  doc_type_id: string;
  document_scale_profile_entry_id: string;
  document_catalog_entry_id: string;
  decision: string;
  detail_override: string;
  status_override: string;
  reason: string;
  required_plan_id: string;
  catalog_layer: string;
  catalog_sub_doc: string;
  requirement_class: string;
  catalog_default_status: string;
  catalog_profile_controlled: number;
  catalog_skip_reason_required: number;
  source_path: string;
  indexed_at: string;
}

export interface SpecRagClosureEntryRow {
  spec_rag_entry_id: string;
  spec_id: string;
  spec_kind: string;
  layer: string;
  sub_doc: string;
  rag: "red" | "yellow" | "green";
  closure_status: string;
  requires_test: number;
  upstream_count: number;
  downstream_count: number;
  test_count: number;
  finding_count: number;
  impact_summary: string;
  source_path: string;
  indexed_at: string;
}

export interface DetectorRouteCandidateRow {
  route_candidate_id: string;
  source_table: string;
  source_id: string;
  detector_id: string;
  finding_kind: string;
  severity: string;
  subject_kind: string;
  subject_id: string;
  filing_target_id: string;
  target_layer: string;
  target_sub_doc: string;
  candidate_status: string;
  reason: string;
  evidence_path: string;
  computed_at: string;
}

export interface AgentContractRow {
  agent_contract_id: string;
  target_path: string;
  defines: string;
  read_first: string;
  done_when: string;
  source_path: string;
  source_hash: string;
  indexed_at: string;
}

export interface SpecIrFindingRow {
  finding_id: string;
  kind: string;
  severity: "error" | "warn" | "info";
  subject_id: string;
  source: string;
  status: string;
  evidence_path: string;
}

export interface SpecIrProjection {
  spec_defs: SpecDefRow[];
  spec_relations: SpecRelationRow[];
  schedule_entries: ScheduleEntryRow[];
  activation_entries: ActivationEntryRow[];
  activation_schedule_reviews: ActivationScheduleReviewRow[];
  document_catalog_entries: DocumentCatalogEntryRow[];
  document_scale_profile_entries: DocumentScaleProfileEntryRow[];
  document_scale_profile_reviews: DocumentScaleProfileReviewRow[];
  spec_rag_closure_entries: SpecRagClosureEntryRow[];
  detector_route_candidates: DetectorRouteCandidateRow[];
  agent_contracts: AgentContractRow[];
  findings: SpecIrFindingRow[];
}

export interface TypedSpecTraceClosureResult {
  typedSpecCount: number;
  relationCount: number;
  findings: SpecIrFindingRow[];
  ok: boolean;
}

export interface TypedSpecSourceSnapshot {
  path: string;
  content: string;
}

export interface TypedSpecLedgerBodySyncResult {
  typedSpecCount: number;
  ledgerRowCount: number;
  findings: SpecIrFindingRow[];
  ok: boolean;
}

export interface TypedSpecOwnedArtifactDispersalResult {
  typedSpecCount: number;
  dispersedSpecCount: number;
  findings: SpecIrFindingRow[];
  ok: boolean;
}

export interface TypedSpecPhaseLayerAlignmentResult {
  typedSpecCount: number;
  alignedSpecCount: number;
  findings: SpecIrFindingRow[];
  ok: boolean;
}

export interface AgentContractIntegrityResult {
  contractCount: number;
  findings: SpecIrFindingRow[];
  ok: boolean;
}

export interface DesignDocCrossIntegrityResult {
  checked_docs: number;
  duplicate_definitions: string[];
  dependency_cycles: string[];
  findings: SpecIrFindingRow[];
  ok: boolean;
}

interface SpecIrProjectionDeps {
  nowIso: () => string;
  recordProjectionEvent: (
    db: HarnessDb,
    event: { table: string; id: string; row: Record<string, unknown> },
  ) => void;
}

function stableHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function markdownFrontmatter(content: string): string {
  if (!content.startsWith("---")) return "";
  const end = content.indexOf("\n---", 3);
  return end < 0 ? "" : content.slice(3, end);
}

function metadataFromContent(content: string): Record<string, unknown> {
  const raw = markdownFrontmatter(content);
  if (!raw.trim()) return {};
  return parseYamlObject(raw) ?? {};
}

function parseYamlObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function projectedPlanRevision(source: SpecIrSource, repoRoot?: string): string {
  const planId = sourcePlanId(source);
  return repoRoot
    ? (canonicalPlanRevision(repoRoot, planId) ?? "")
    : (resolvePlanRevisionIdentity(source.content, planId)?.token ?? "");
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  return typeof value === "string" && value.trim() !== ""
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function dependencyValues(metadata: Record<string, unknown>): string[] {
  const dependencies =
    metadata.dependencies && typeof metadata.dependencies === "object"
      ? (metadata.dependencies as Record<string, unknown>)
      : {};
  return [
    stringField(dependencies.parent),
    ...stringList(dependencies.requires),
    ...stringList(metadata.parent_design),
  ].filter(Boolean);
}

function referenceValues(metadata: Record<string, unknown>): string[] {
  return [
    ...dependencyValues(metadata),
    stringField(metadata.pair_artifact),
    ...stringList(metadata.references),
  ].filter(Boolean);
}

function planIdFromReference(value: string): string {
  const normalized = normalizePath(value);
  const match = normalized.match(/(PLAN-[A-Z0-9-]+[A-Za-z0-9-]*)/);
  return match?.[1] ?? "";
}

function planShortId(planId: string): string {
  return planId.match(/^(PLAN-(?:L\d+|REVERSE|RECOVERY|DISCOVERY)-\d+)/)?.[1] ?? planId;
}

function firstHeading(content: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function typedSpecId(value: string): string {
  return value.trim().replace(/`/g, "");
}

function typedSpecDeclarations(source: SpecIrSource): TypedSpecDeclaration[] {
  if (source.kind === "reference_doc") return [];
  const blocks: unknown[] = [];
  const metadataSpec =
    source.metadata.spec && typeof source.metadata.spec === "object"
      ? (source.metadata.spec as Record<string, unknown>)
      : null;
  if (metadataSpec) blocks.push(metadataSpec);
  for (const match of source.content.matchAll(/```ya?ml\s*\n([\s\S]*?)\n```/g)) {
    const parsed = parseYamlObject(match[1]);
    if (!parsed) continue;
    const spec = parsed.spec;
    if (spec && typeof spec === "object" && !Array.isArray(spec)) blocks.push(spec);
  }
  const declarations: TypedSpecDeclaration[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const defines = (block as Record<string, unknown>).defines;
    if (!Array.isArray(defines)) continue;
    for (const item of defines) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const raw = item as Record<string, unknown>;
      declarations.push({
        id: typedSpecId(stringField(raw.id)),
        kind: stringField(raw.kind),
        traces_from: stringList(raw.traces_from).map(typedSpecId),
        traces_to: stringList(raw.traces_to).map(typedSpecId),
        tests: stringList(raw.tests).map(typedSpecId),
      });
    }
  }
  return declarations;
}

function inferLayerFromPath(path: string): string {
  return path.match(/(?:^|\/)L(\d+)[-/]/)?.[0]?.match(/L\d+/)?.[0] ?? "";
}

function inferSubDocFromPath(path: string): string {
  const name = basename(path, ".md");
  const suffix = path.match(/(?:^|\/)L\d+-([^/]+)\//)?.[1] ?? "";
  if (name === "function") return "function";
  if (name === "data") return "data";
  if (name === "architecture") return "architecture";
  if (name === "physical-data") return "physical-data";
  if (name === "function-spec") return "function-spec";
  if (suffix === "requirements" && name.includes("screen")) return "screen";
  return name;
}

function sourceKind(path: string): SpecIrSourceKind | null {
  if (path === "docs/governance/vmodel-upgrade-schedule.md") return "schedule_doc";
  if (path === "docs/governance/vmodel-activation-profiles.md") return "activation_profile";
  if (path === "docs/governance/vmodel-document-catalog.md") return "document_catalog";
  if (path === "docs/governance/vmodel-document-scale-profiles.md") {
    return "document_scale_profile";
  }
  if (path === "docs/governance/vmodel-typed-spec-definitions.md") return "typed_spec";
  if (path === "docs/governance/vmodel-agent-contracts.md") return "agent_contracts";
  if (path === "docs/governance/vmodel-refactor-qa-release-gates.md") {
    return "refactor_qa_release_contract";
  }
  if (path.startsWith("docs/plans/")) return "plan";
  if (path.startsWith("docs/design/harness/")) return "design_doc";
  if (path.startsWith("docs/test-design/harness/")) return "test_design";
  if (
    path.startsWith("docs/governance/") ||
    path.startsWith("docs/adr/") ||
    path.startsWith("docs/process/") ||
    path.startsWith("docs/migration/")
  ) {
    return "reference_doc";
  }
  return null;
}

function walkMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root)
    .map((name) => join(root, name))
    .sort();
  const files: string[] = [];
  for (const entry of entries) {
    const stat = statSync(entry);
    if (stat.isDirectory()) files.push(...walkMarkdown(entry));
    if (stat.isFile() && entry.endsWith(".md")) files.push(entry);
  }
  return files;
}

export function loadSpecIrSources(repoRoot: string): SpecIrSource[] {
  const scheduleSource = join(repoRoot, "docs", "governance", "vmodel-upgrade-schedule.md");
  const activationProfileSource = join(
    repoRoot,
    "docs",
    "governance",
    "vmodel-activation-profiles.md",
  );
  const documentCatalogSource = join(repoRoot, "docs", "governance", "vmodel-document-catalog.md");
  const documentScaleProfileSource = join(
    repoRoot,
    "docs",
    "governance",
    "vmodel-document-scale-profiles.md",
  );
  const typedSpecSource = join(repoRoot, "docs", "governance", "vmodel-typed-spec-definitions.md");
  const agentContractSource = join(repoRoot, "docs", "governance", "vmodel-agent-contracts.md");
  const refactorQaReleaseContractSource = join(
    repoRoot,
    "docs",
    "governance",
    "vmodel-refactor-qa-release-gates.md",
  );
  const canonicalSourcePaths = [
    ...(existsSync(scheduleSource) ? [scheduleSource] : []),
    ...(existsSync(activationProfileSource) ? [activationProfileSource] : []),
    ...(existsSync(documentCatalogSource) ? [documentCatalogSource] : []),
    ...(existsSync(documentScaleProfileSource) ? [documentScaleProfileSource] : []),
    ...(existsSync(typedSpecSource) ? [typedSpecSource] : []),
    ...(existsSync(agentContractSource) ? [agentContractSource] : []),
    ...(existsSync(refactorQaReleaseContractSource) ? [refactorQaReleaseContractSource] : []),
    ...walkMarkdown(join(repoRoot, "docs", "plans")),
    ...walkMarkdown(join(repoRoot, "docs", "design", "harness")),
    ...walkMarkdown(join(repoRoot, "docs", "test-design", "harness")),
  ];
  const uniqueCanonicalPaths = new Set(canonicalSourcePaths);
  const referencedPaths = new Set<string>();
  for (const absolutePath of uniqueCanonicalPaths) {
    const path = normalizePath(relative(repoRoot, absolutePath));
    if (!path.startsWith("docs/plans/")) continue;
    const metadata = metadataFromContent(readFileSync(absolutePath, "utf8"));
    for (const ref of referenceValues(metadata)) {
      const refPath = normalizePath(ref);
      if (planIdFromReference(refPath)) continue;
      const refKind = sourceKind(refPath);
      if (!refKind) continue;
      const refAbsolutePath = join(repoRoot, refPath);
      if (existsSync(refAbsolutePath)) referencedPaths.add(refAbsolutePath);
    }
  }
  const sourcePaths = [...uniqueCanonicalPaths, ...referencedPaths];
  return [...new Set(sourcePaths)].flatMap((absolutePath) => {
    const path = normalizePath(relative(repoRoot, absolutePath));
    const kind = sourceKind(path);
    if (!kind) return [];
    const content = readFileSync(absolutePath, "utf8");
    return [
      {
        kind,
        path,
        content,
        metadata: metadataFromContent(content),
        sourceHash: stableHash(content),
      },
    ];
  });
}

function sourceLayer(source: SpecIrSource): string {
  return stringField(source.metadata.layer) || inferLayerFromPath(source.path);
}

function sourceSubDoc(source: SpecIrSource): string {
  return stringField(source.metadata.sub_doc) || inferSubDocFromPath(source.path);
}

function sourcePlanId(source: SpecIrSource): string {
  return stringField(source.metadata.plan_id);
}

function sourceStatus(source: SpecIrSource): string {
  return stringField(source.metadata.status) || "active";
}

/**
 * PLAN-L7-429: doc_type frontmatter がメタ doc (README index / verification roadmap) を宣言する
 * design doc は L1-L6 design document catalog の実体ではないため、spec_kind を
 * design_meta_doc に分類して sub_doc 検証の対象外とする。
 */
const META_DOC_TYPES = new Set(["index", "verification-roadmap"]);

function isMetaDesignDoc(source: SpecIrSource): boolean {
  return META_DOC_TYPES.has(stringField(source.metadata.doc_type));
}

function shouldValidateDesignSubDoc(def: SpecDefRow): boolean {
  return (
    def.spec_kind === "design_doc" &&
    def.section_anchor === "document" &&
    ["L1", "L2", "L3", "L4", "L5", "L6"].includes(def.layer) &&
    def.owner_path.startsWith("docs/design/harness/")
  );
}

function sourceTitle(source: SpecIrSource): string {
  return (
    stringField(source.metadata.title) || firstHeading(source.content) || basename(source.path)
  );
}

function splitMarkdownTableLine(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^`|`$/g, ""));
}

function markdownTableRows(content: string, requiredHeaders: string[]): Record<string, string>[] {
  const lines = content.split(/\r?\n/);
  const rows: Record<string, string>[] = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];
    if (!headerLine.trim().startsWith("|") || !separatorLine.match(/^\s*\|?\s*:?-{3,}/)) {
      continue;
    }
    const headers = splitMarkdownTableLine(headerLine).map((header) =>
      header.toLowerCase().replace(/`/g, ""),
    );
    if (!requiredHeaders.every((header) => headers.includes(header))) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];
      if (!line.trim().startsWith("|")) break;
      const cells = splitMarkdownTableLine(line);
      const row: Record<string, string> = {};
      headers.forEach((header, cellIndex) => {
        row[header] = cells[cellIndex] ?? "";
      });
      rows.push(row);
    }
  }
  return rows;
}

function parseScheduleAuthoringRows(
  sources: SpecIrSource[],
  indexedAt: string,
  repoRoot?: string,
): ScheduleEntryRow[] {
  const rows: ScheduleEntryRow[] = [];
  const planRevisions = new Map(
    sources
      .filter((source) => source.kind === "plan" && sourcePlanId(source))
      .map((source) => [sourcePlanId(source), projectedPlanRevision(source, repoRoot)]),
  );
  for (const source of sources.filter((item) => item.kind === "schedule_doc")) {
    for (const row of markdownTableRows(source.content, ["plan_id", "current_location"])) {
      const planId = row.plan_id ?? "";
      if (!planId) continue;
      const planRevision = planRevisions.get(planId);
      if (!planRevision) continue;
      const layer = row.layer ?? "";
      const status = row.status || "active";
      const rawPredecessors = row.predecessor_plan_ids || row.predecessors || "";
      const predecessors = rawPredecessors
        .split(/[|,]/)
        .map((item) => planIdFromReference(item.trim()) || item.trim())
        .filter(Boolean)
        .sort();
      rows.push({
        schedule_entry_id: stableId("schedule-entry", planId),
        plan_id: planId,
        layer,
        sub_doc: row.sub_doc ?? "",
        v_pair: row.v_pair || (V_MODEL_PAIRS as Record<string, string>)[layer] || "",
        predecessor_plan_ids: predecessors.join("|"),
        current_location: row.current_location ?? "",
        rag: row.rag || (status === "confirmed" || status === "completed" ? "green" : "yellow"),
        status,
        blocked_reason: row.blocked_reason ?? "",
        source_path: source.path,
        plan_revision: planRevision,
        source_hash: source.sourceHash,
        indexed_at: indexedAt,
      });
    }
  }
  return rows;
}

export function parseSpecDefs(sources: SpecIrSource[], indexedAt: string): SpecDefRow[] {
  const defs: SpecDefRow[] = [];
  for (const source of sources) {
    const planId = sourcePlanId(source);
    const ownerArtifactId = planId || source.path;
    const layer = sourceLayer(source);
    const subDoc = sourceSubDoc(source);
    const documentSpecId = stableId("spec", `${source.path}#document`);
    const documentSpecKind =
      source.kind === "design_doc" && isMetaDesignDoc(source) ? "design_meta_doc" : source.kind;
    defs.push({
      spec_id: documentSpecId,
      spec_kind: documentSpecKind,
      layer,
      sub_doc: subDoc,
      owner_artifact_id: ownerArtifactId,
      owner_path: source.path,
      section_anchor: "document",
      title: sourceTitle(source),
      lifecycle_status: sourceStatus(source),
      plan_id: planId,
      source_path: source.path,
      source_hash: source.sourceHash,
      indexed_at: indexedAt,
    });
    for (const declaration of typedSpecDeclarations(source)) {
      const declaredId = declaration.id || stableId("typed-spec-missing-id", source.path);
      defs.push({
        spec_id: declaredId,
        spec_kind: declaration.kind || "typed-spec-missing-kind",
        layer,
        sub_doc: subDoc,
        owner_artifact_id: declaredId,
        owner_path: source.path,
        section_anchor: `spec.defines:${declaredId}`,
        title: declaredId,
        lifecycle_status: sourceStatus(source),
        plan_id: planId,
        source_path: source.path,
        source_hash: source.sourceHash,
        indexed_at: indexedAt,
      });
    }
    if (source.kind === "plan" || source.kind === "reference_doc") continue;
    for (const match of source.content.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
      const title = match[2].trim();
      const anchor = slug(title);
      if (!anchor || anchor === "document") continue;
      defs.push({
        spec_id: stableId("spec", `${source.path}#${anchor}`),
        spec_kind: "section",
        layer,
        sub_doc: subDoc,
        owner_artifact_id: ownerArtifactId,
        owner_path: source.path,
        section_anchor: anchor,
        title,
        lifecycle_status: sourceStatus(source),
        plan_id: planId,
        source_path: source.path,
        source_hash: source.sourceHash,
        indexed_at: indexedAt,
      });
    }
  }
  return defs;
}

/**
 * PLAN-L7-429: PLAN frontmatter の requires / pair_artifact のうち、loadSpecIrSources が
 * spec-ir ソースとして取り込まない artifact 種別 (実装・テスト・runtime 証跡・research・
 * skill・ルート設定ファイル) への参照は spec 依存 relation ではなく evidence 参照であり、
 * relation 解決の対象外とする (orphan-relation を発火させない)。`pair_artifact: self` は
 * PLAN-REVERSE-12 の規定通り unresolved orphan のまま残す (ここでは除外しない)。
 * evidence path の実在欠落検出 (spec-ir-missing-evidence 相当) は本 PLAN の外 (§7 残リスク)。
 */
const EVIDENCE_REFERENCE_PREFIXES = [
  "src/",
  "tests/",
  "scripts/",
  "skills/",
  ".ut-tdd/",
  ".claude/",
  ".github/",
  "docs/research/",
];

const EVIDENCE_REFERENCE_PATHS = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "package.json",
  "docs/improvement-backlog.md",
]);

function isEvidenceReference(path: string): boolean {
  return (
    EVIDENCE_REFERENCE_PATHS.has(path) ||
    EVIDENCE_REFERENCE_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

export function parseSpecRelations(
  sources: SpecIrSource[],
  defs: SpecDefRow[],
  indexedAt: string,
): { relations: SpecRelationRow[]; findings: SpecIrFindingRow[] } {
  const byPlanId = new Map(defs.filter((def) => def.plan_id).map((def) => [def.plan_id, def]));
  const byPlanShortId = new Map<string, SpecDefRow | null>();
  for (const def of defs.filter((item) => item.plan_id)) {
    const shortId = planShortId(def.plan_id);
    const existing = byPlanShortId.get(shortId);
    byPlanShortId.set(shortId, existing && existing.spec_id !== def.spec_id ? null : def);
  }
  const byPath = new Map(
    defs.filter((def) => def.section_anchor === "document").map((def) => [def.owner_path, def]),
  );
  const bySpecId = new Map(defs.map((def) => [def.spec_id, def]));
  const relations: SpecRelationRow[] = [];
  const findings: SpecIrFindingRow[] = [];
  const resolvePlanDef = (planId: string): SpecDefRow | undefined => {
    const exact = byPlanId.get(planId);
    if (exact) return exact;
    const short = byPlanShortId.get(planId);
    return short ?? undefined;
  };
  const addRelation = (input: {
    source: SpecIrSource;
    from: SpecDefRow;
    to: SpecDefRow | undefined;
    relationKind: string;
    evidencePath: string;
  }) => {
    const { source, from, to, relationKind, evidencePath } = input;
    if (!to) {
      const subject = `${from.spec_id}:${relationKind}:${evidencePath}`;
      findings.push({
        finding_id: stableId("finding:spec-ir-orphan-relation", subject),
        kind: "spec-ir-orphan-relation",
        severity: "warn",
        subject_id: subject,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: source.path,
      });
      return;
    }
    const relationId = stableId("spec-relation", `${from.spec_id}:${relationKind}:${to.spec_id}`);
    relations.push({
      relation_id: relationId,
      from_spec_id: from.spec_id,
      to_spec_id: to.spec_id,
      relation_kind: relationKind,
      plan_id: sourcePlanId(source),
      status: "active",
      source: source.path,
      evidence_path: evidencePath,
      indexed_at: indexedAt,
    });
  };
  for (const source of sources.filter((item) => item.kind === "plan")) {
    const planId = sourcePlanId(source);
    const from = byPlanId.get(planId);
    if (!from) continue;
    for (const ref of dependencyValues(source.metadata)) {
      const targetPlanId = planIdFromReference(ref);
      if (!targetPlanId && isEvidenceReference(normalizePath(ref))) continue;
      const target = targetPlanId ? resolvePlanDef(targetPlanId) : byPath.get(normalizePath(ref));
      addRelation({ source, from, to: target, relationKind: "requires", evidencePath: ref });
    }
    const pairArtifact = normalizePath(stringField(source.metadata.pair_artifact));
    if (pairArtifact && !isEvidenceReference(pairArtifact)) {
      addRelation({
        source,
        from,
        to: byPath.get(pairArtifact),
        relationKind: "pairs",
        evidencePath: pairArtifact,
      });
    }
  }
  for (const source of sources) {
    for (const declaration of typedSpecDeclarations(source)) {
      const from = bySpecId.get(declaration.id);
      if (!from) continue;
      for (const ref of declaration.traces_from) {
        addRelation({
          source,
          from,
          to: bySpecId.get(ref),
          relationKind: "traces_from",
          evidencePath: ref,
        });
      }
      for (const ref of declaration.traces_to) {
        addRelation({
          source,
          from,
          to: bySpecId.get(ref),
          relationKind: "traces_to",
          evidencePath: ref,
        });
      }
      for (const ref of declaration.tests) {
        addRelation({
          source,
          from,
          to: bySpecId.get(ref),
          relationKind: "tests",
          evidencePath: ref,
        });
      }
    }
  }
  return { relations, findings };
}

export function parseScheduleEntries(
  sources: SpecIrSource[],
  indexedAt: string,
  repoRoot?: string,
): ScheduleEntryRow[] {
  const authoredRows = parseScheduleAuthoringRows(sources, indexedAt, repoRoot);
  const authoredPlanIds = new Set(authoredRows.map((row) => row.plan_id));
  const fallbackRows = sources
    .filter((source) => source.kind === "plan" && sourcePlanId(source))
    .filter((source) => !authoredPlanIds.has(sourcePlanId(source)))
    .filter((source) => Boolean(projectedPlanRevision(source, repoRoot)))
    .map((source) => {
      const planId = sourcePlanId(source);
      const status = sourceStatus(source);
      const layer = sourceLayer(source);
      const predecessors = dependencyValues(source.metadata)
        .map(planIdFromReference)
        .filter(Boolean)
        .sort();
      const rag = status === "confirmed" || status === "completed" ? "green" : "yellow";
      return {
        schedule_entry_id: stableId("schedule-entry", planId),
        plan_id: planId,
        layer,
        sub_doc: sourceSubDoc(source),
        v_pair: (V_MODEL_PAIRS as Record<string, string>)[layer] ?? "",
        predecessor_plan_ids: predecessors.join("|"),
        current_location: `${layer || "unknown"}:${status}`,
        rag,
        status,
        blocked_reason: "",
        source_path: source.path,
        plan_revision: projectedPlanRevision(source, repoRoot),
        source_hash: source.sourceHash,
        indexed_at: indexedAt,
      };
    });
  return [...authoredRows, ...fallbackRows];
}

function boolFromField(value: string, fallback: boolean): number {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "enabled", "有効"].includes(normalized)) return 1;
  if (["0", "false", "no", "n", "disabled", "無効"].includes(normalized)) return 0;
  return fallback ? 1 : 0;
}

function parseActivationAuthoringRows(
  sources: SpecIrSource[],
  indexedAt: string,
): ActivationEntryRow[] {
  const rows: ActivationEntryRow[] = [];
  for (const source of sources.filter((item) => item.kind === "activation_profile")) {
    for (const row of markdownTableRows(source.content, ["profile_id", "target_id"])) {
      const profileId = row.profile_id ?? "";
      const targetId = row.target_id ?? "";
      if (!profileId || !targetId) continue;
      const targetKind = row.target_kind || "plan";
      const scopeStatus = row.scope_status || "in_scope";
      const planId = row.plan_id || (targetKind === "plan" ? targetId : "");
      rows.push({
        activation_entry_id: stableId("activation-entry", `${profileId}:${targetKind}:${targetId}`),
        profile_id: profileId,
        target_kind: targetKind,
        target_id: targetId,
        scope_status: scopeStatus,
        target_version: row.target_version || "",
        defer_reason: row.defer_reason || "",
        enabled: boolFromField(row.enabled ?? "", scopeStatus === "in_scope"),
        source_path: source.path,
        plan_id: planId,
        indexed_at: indexedAt,
      });
    }
  }
  return rows;
}

export function parseActivationEntries(
  sources: SpecIrSource[],
  indexedAt: string,
): ActivationEntryRow[] {
  const authoredRows = parseActivationAuthoringRows(sources, indexedAt);
  const authoredPlanIds = new Set(authoredRows.map((row) => row.plan_id).filter(Boolean));
  const fallbackRows = sources
    .filter((source) => source.kind === "plan" && sourcePlanId(source))
    .filter((source) => !authoredPlanIds.has(sourcePlanId(source)))
    .map((source) => {
      const planId = sourcePlanId(source);
      const drive = stringField(source.metadata.drive) || "unknown";
      const mode = stringField(source.metadata.route_mode) || "forward";
      const archived = sourceStatus(source) === "archived";
      return {
        activation_entry_id: stableId("activation-entry", `${planId}:${drive}:${mode}`),
        profile_id: `drive:${drive}:mode:${mode}`,
        target_kind: "plan",
        target_id: planId,
        scope_status: archived ? "out_of_scope" : "in_scope",
        target_version: source.sourceHash,
        defer_reason: archived ? "archived plan is out of active projection scope" : "",
        enabled: archived ? 0 : 1,
        source_path: source.path,
        plan_id: planId,
        indexed_at: indexedAt,
      };
    });
  return [...authoredRows, ...fallbackRows];
}

export function joinActivationScheduleReviews(input: {
  activations: ActivationEntryRow[];
  schedules: ScheduleEntryRow[];
  indexedAt: string;
}): ActivationScheduleReviewRow[] {
  const scheduleByPlanId = new Map(input.schedules.map((schedule) => [schedule.plan_id, schedule]));
  return input.activations.map((activation) => {
    const schedule = scheduleByPlanId.get(activation.plan_id);
    return {
      activation_schedule_review_id: stableId(
        "activation-schedule-review",
        `${activation.activation_entry_id}:${schedule?.schedule_entry_id ?? "missing-schedule"}`,
      ),
      profile_id: activation.profile_id,
      plan_id: activation.plan_id,
      schedule_entry_id: schedule?.schedule_entry_id ?? "",
      activation_entry_id: activation.activation_entry_id,
      target_kind: activation.target_kind,
      target_id: activation.target_id,
      scope_status: activation.scope_status,
      enabled: activation.enabled,
      target_version: activation.target_version,
      defer_reason: activation.defer_reason,
      current_location: schedule?.current_location ?? "",
      rag: schedule?.rag ?? "",
      schedule_status: schedule?.status ?? "",
      layer: schedule?.layer ?? "",
      sub_doc: schedule?.sub_doc ?? "",
      v_pair: schedule?.v_pair ?? "",
      source_path: activation.source_path || schedule?.source_path || "",
      indexed_at: input.indexedAt,
    };
  });
}

export function parseDocumentCatalogEntries(
  sources: SpecIrSource[],
  indexedAt: string,
): DocumentCatalogEntryRow[] {
  const rows: DocumentCatalogEntryRow[] = [];
  for (const source of sources.filter((item) => item.kind === "document_catalog")) {
    for (const row of markdownTableRows(source.content, ["doc_type_id", "layer", "sub_doc"])) {
      const docTypeId = row.doc_type_id ?? "";
      if (!docTypeId) continue;
      const layer = row.layer ?? "";
      const subDoc = row.sub_doc ?? "";
      rows.push({
        document_catalog_entry_id: stableId("document-catalog-entry", docTypeId),
        doc_type_id: docTypeId,
        layer,
        sub_doc: subDoc,
        category: row.category ?? "",
        requirement_class: row.requirement_class ?? "",
        applicability: row.applicability || "in_scope",
        default_status: row.default_status || "required",
        source_doc_family: row.source_doc_family ?? "",
        authoring_source_path: normalizePath(row.authoring_source_path ?? ""),
        projection_table: row.projection_table ?? "",
        profile_controlled: boolFromField(row.profile_controlled ?? "", false),
        skip_reason_required: boolFromField(row.skip_reason_required ?? "", false),
        source_path: source.path,
        indexed_at: indexedAt,
      });
    }
  }
  return rows;
}

export function parseDocumentScaleProfileEntries(
  sources: SpecIrSource[],
  indexedAt: string,
): DocumentScaleProfileEntryRow[] {
  const rows: DocumentScaleProfileEntryRow[] = [];
  for (const source of sources.filter((item) => item.kind === "document_scale_profile")) {
    for (const row of markdownTableRows(source.content, ["profile_id", "doc_type_id"])) {
      const profileId = row.profile_id ?? "";
      const docTypeId = row.doc_type_id ?? "";
      if (!profileId || !docTypeId) continue;
      rows.push({
        document_scale_profile_entry_id: stableId(
          "document-scale-profile-entry",
          `${profileId}:${docTypeId}`,
        ),
        profile_id: profileId,
        doc_type_id: docTypeId,
        decision: row.decision ?? "",
        detail_override: row.detail_override ?? "",
        status_override: row.status_override ?? "",
        reason: row.reason ?? "",
        required_plan_id: row.required_plan_id || null,
        row_digest: profileEntryDigest(row),
        source_path: source.path,
        indexed_at: indexedAt,
      });
    }
  }
  return rows;
}

function profileEntryDigest(row: Record<string, string>): string {
  const headers = [
    "profile_id",
    "doc_type_id",
    "decision",
    "detail_override",
    "status_override",
    "reason",
    "required_plan_id",
  ];
  return createHash("sha256")
    .update(JSON.stringify(headers.map((header) => [header, row[header] ?? ""])))
    .digest("hex");
}

export function joinDocumentScaleProfileReviews(input: {
  profileEntries: DocumentScaleProfileEntryRow[];
  catalogEntries: DocumentCatalogEntryRow[];
  indexedAt: string;
}): DocumentScaleProfileReviewRow[] {
  const catalogByDocType = new Map(input.catalogEntries.map((entry) => [entry.doc_type_id, entry]));
  return input.profileEntries.map((profileEntry) => {
    const catalog = catalogByDocType.get(profileEntry.doc_type_id);
    return {
      document_scale_profile_review_id: stableId(
        "document-scale-profile-review",
        `${profileEntry.document_scale_profile_entry_id}:${
          catalog?.document_catalog_entry_id ?? "missing-catalog"
        }`,
      ),
      profile_id: profileEntry.profile_id,
      doc_type_id: profileEntry.doc_type_id,
      document_scale_profile_entry_id: profileEntry.document_scale_profile_entry_id,
      document_catalog_entry_id: catalog?.document_catalog_entry_id ?? "",
      decision: profileEntry.decision,
      detail_override: profileEntry.detail_override,
      status_override: profileEntry.status_override,
      reason: profileEntry.reason,
      required_plan_id: profileEntry.required_plan_id ?? "",
      catalog_layer: catalog?.layer ?? "",
      catalog_sub_doc: catalog?.sub_doc ?? "",
      requirement_class: catalog?.requirement_class ?? "",
      catalog_default_status: catalog?.default_status ?? "",
      catalog_profile_controlled: catalog?.profile_controlled ?? 0,
      catalog_skip_reason_required: catalog?.skip_reason_required ?? 0,
      source_path: profileEntry.source_path || catalog?.source_path || "",
      indexed_at: input.indexedAt,
    };
  });
}

function agentContractBlocks(source: SpecIrSource): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const match of source.content.matchAll(/```ya?ml\s*\n([\s\S]*?)\n```/g)) {
    const parsed = parseYamlObject(match[1]);
    if (!parsed) continue;
    blocks.push(parsed);
  }
  return blocks;
}

export function parseAgentContractRows(
  sources: SpecIrSource[],
  indexedAt: string,
): AgentContractRow[] {
  const rows: AgentContractRow[] = [];
  for (const source of sources.filter((item) => item.kind === "agent_contracts")) {
    for (const block of agentContractBlocks(source)) {
      const contracts = block.agent_contracts;
      if (!Array.isArray(contracts)) continue;
      for (const item of contracts) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const raw = item as Record<string, unknown>;
        const contractId = stringField(raw.contract_id);
        const targetPath = normalizePath(stringField(raw.target_path));
        rows.push({
          agent_contract_id:
            contractId || stableId("agent-contract-missing-id", `${source.path}:${targetPath}`),
          target_path: targetPath,
          defines: stringList(raw.defines).map(typedSpecId).sort().join("|"),
          read_first: stringList(raw.read_first).map(normalizePath).sort().join("|"),
          done_when: stringList(raw.done_when).sort().join("|"),
          source_path: source.path,
          source_hash: source.sourceHash,
          indexed_at: indexedAt,
        });
      }
    }
  }
  return rows;
}

function splitPipeList(value: string): string[] {
  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function agentContractFinding(input: {
  kind: string;
  subjectId: string;
  evidencePath: string;
}): SpecIrFindingRow {
  return {
    finding_id: stableId(`finding:${input.kind}`, input.subjectId),
    kind: input.kind,
    severity: "warn",
    subject_id: input.subjectId,
    source: "agent-contract-integrity",
    status: "open",
    evidence_path: input.evidencePath,
  };
}

export function analyzeAgentContractIntegrity(input: {
  contracts: AgentContractRow[];
  sources: TypedSpecSourceSnapshot[];
  knownDoctorGateIds?: readonly string[];
}): AgentContractIntegrityResult {
  const sourcePaths = new Set(input.sources.map((source) => normalizePath(source.path)));
  const knownDoctorGateIds = new Set(input.knownDoctorGateIds ?? []);
  const contractCounts = new Map<string, number>();
  const findings: SpecIrFindingRow[] = [];

  for (const contract of input.contracts) {
    contractCounts.set(
      contract.agent_contract_id,
      (contractCounts.get(contract.agent_contract_id) ?? 0) + 1,
    );
    if (!contract.agent_contract_id.startsWith("VAGENT-")) {
      findings.push(
        agentContractFinding({
          kind: "agent-contract-invalid-id",
          subjectId: contract.agent_contract_id,
          evidencePath: contract.source_path,
        }),
      );
    }
    if (!contract.target_path || !sourcePaths.has(normalizePath(contract.target_path))) {
      findings.push(
        agentContractFinding({
          kind: "agent-contract-target-missing",
          subjectId: contract.agent_contract_id,
          evidencePath: contract.source_path,
        }),
      );
    }
    if (splitPipeList(contract.defines).length === 0) {
      findings.push(
        agentContractFinding({
          kind: "agent-contract-defines-missing",
          subjectId: contract.agent_contract_id,
          evidencePath: contract.source_path,
        }),
      );
    }
    for (const readFirst of splitPipeList(contract.read_first)) {
      if (sourcePaths.has(normalizePath(readFirst))) continue;
      findings.push(
        agentContractFinding({
          kind: "agent-contract-read-first-missing",
          subjectId: `${contract.agent_contract_id}:${readFirst}`,
          evidencePath: contract.source_path,
        }),
      );
    }
    if (splitPipeList(contract.done_when).length === 0) {
      findings.push(
        agentContractFinding({
          kind: "agent-contract-done-when-missing",
          subjectId: contract.agent_contract_id,
          evidencePath: contract.source_path,
        }),
      );
    }
    for (const doneWhen of splitPipeList(contract.done_when)) {
      const match = doneWhen.match(/^doctor:([a-z0-9-]+)$/);
      if (!match) {
        findings.push(
          agentContractFinding({
            kind: "agent-contract-done-when-invalid",
            subjectId: `${contract.agent_contract_id}:${doneWhen}`,
            evidencePath: contract.source_path,
          }),
        );
        continue;
      }
      if (knownDoctorGateIds.size > 0 && !knownDoctorGateIds.has(match[1])) {
        findings.push(
          agentContractFinding({
            kind: "agent-contract-doctor-gate-unknown",
            subjectId: `${contract.agent_contract_id}:${match[1]}`,
            evidencePath: contract.source_path,
          }),
        );
      }
    }
  }

  for (const [contractId, count] of contractCounts) {
    if (count <= 1) continue;
    findings.push(
      agentContractFinding({
        kind: "agent-contract-duplicate-id",
        subjectId: contractId,
        evidencePath:
          input.contracts.find((contract) => contract.agent_contract_id === contractId)
            ?.source_path ?? "",
      }),
    );
  }

  return {
    contractCount: input.contracts.length,
    findings,
    ok: findings.length === 0,
  };
}

function isTypedSpecDef(def: SpecDefRow): boolean {
  return def.section_anchor.startsWith("spec.defines:");
}

function traceKey(from: string, kind: string, to: string): string {
  return `${from}\u0000${kind}\u0000${to}`;
}

function typedSpecFinding(input: {
  kind: string;
  subjectId: string;
  evidencePath: string;
  severity?: SpecIrFindingRow["severity"];
}): SpecIrFindingRow {
  return {
    finding_id: stableId(`finding:${input.kind}`, input.subjectId),
    kind: input.kind,
    severity: input.severity ?? "warn",
    subject_id: input.subjectId,
    source: "typed-spec-trace-closure",
    status: "open",
    evidence_path: input.evidencePath,
  };
}

function requiresTypedSpecTest(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  if (normalized.includes("oracle") || normalized.includes("test") || normalized.includes("検証")) {
    return false;
  }
  return (
    normalized.includes("requirement") ||
    normalized.includes("要件") ||
    normalized.includes("source") ||
    normalized.includes("profile") ||
    normalized.includes("projection") ||
    normalized.includes("review") ||
    normalized.includes("charter")
  );
}

interface TypedSpecLedgerRow {
  specId: string;
  ledgerSources: string[];
  vPhase: string;
  sourcePath: string;
}

function listField(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim().replace(/^`|`$/g, ""))
    .filter((item) => item && item !== "-");
}

function parseTypedSpecLedgerRows(sources: TypedSpecSourceSnapshot[]): TypedSpecLedgerRow[] {
  const rows: TypedSpecLedgerRow[] = [];
  for (const source of sources) {
    for (const row of markdownTableRows(source.content, ["spec_id", "ledger_sources", "v_phase"])) {
      const specId = typedSpecId(row.spec_id ?? "");
      if (!specId) continue;
      rows.push({
        specId,
        ledgerSources: listField(row.ledger_sources ?? ""),
        vPhase: stringField(row.v_phase),
        sourcePath: source.path,
      });
    }
    for (const match of source.content.matchAll(/```ya?ml\s*\n([\s\S]*?)\n```/g)) {
      const parsed = parseYamlObject(match[1]);
      if (!parsed) continue;
      const ledger = parsed.typed_spec_ledger;
      if (!Array.isArray(ledger)) continue;
      for (const item of ledger) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const raw = item as Record<string, unknown>;
        const specId = typedSpecId(stringField(raw.spec_id));
        if (!specId) continue;
        rows.push({
          specId,
          ledgerSources: stringList(raw.ledger_sources),
          vPhase: stringField(raw.v_phase),
          sourcePath: source.path,
        });
      }
    }
  }
  return rows;
}

function stripSpecDeclarationBlocks(content: string): string {
  const withoutFrontmatter =
    content.startsWith("---") && content.indexOf("\n---", 3) >= 0
      ? content.slice(content.indexOf("\n---", 3) + 4)
      : content;
  return withoutFrontmatter.replace(/```ya?ml\s*\n([\s\S]*?)\n```/g, (block, body) => {
    const parsed = parseYamlObject(body);
    if (parsed?.spec) {
      return "";
    }
    return block;
  });
}

function stripTypedSpecLedgerTables(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line.includes("spec_id") &&
      line.includes("ledger_sources") &&
      line.includes("v_phase") &&
      lines[index + 1]?.match(/^\s*\|?\s*:?-{3,}/)
    ) {
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        index += 1;
      }
      index -= 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function phaseRank(value: string): number | null {
  const match = value.trim().match(/^L(\d{1,2})$/i);
  if (!match) return null;
  return Number(match[1]);
}

function sourceMatchesLedgerSource(sourcePath: string, ledgerSource: string): boolean {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedLedgerSource = normalizePath(ledgerSource);
  return normalizedSource === normalizedLedgerSource;
}

function sourceOwnerPhases(source: TypedSpecSourceSnapshot | undefined): string[] {
  if (!source) return [];
  const metadata = metadataFromContent(source.content);
  const phases = [
    stringField(metadata.typed_spec_phase_owner),
    stringField(metadata.executed_at_layer),
    stringField(metadata.layer) || inferLayerFromPath(source.path),
  ];
  return [...new Set(phases.filter(Boolean).map((phase) => phase.toUpperCase()))];
}

function phaseMatchesOwner(ledgerPhase: string, ownerPhases: string[]): boolean {
  const normalizedLedgerPhase = ledgerPhase.trim().toUpperCase();
  if (!normalizedLedgerPhase) return false;
  return ownerPhases.some((ownerPhase) => ownerPhase === normalizedLedgerPhase);
}

export function analyzeTypedSpecLedgerBodySync(input: {
  defs: SpecDefRow[];
  relations: SpecRelationRow[];
  sources: TypedSpecSourceSnapshot[];
}): TypedSpecLedgerBodySyncResult {
  const typedDefs = input.defs.filter(isTypedSpecDef);
  const typedIds = new Set(typedDefs.map((def) => def.spec_id));
  const sourceBodyByPath = new Map(
    input.sources.map((source) => [
      source.path,
      stripTypedSpecLedgerTables(stripSpecDeclarationBlocks(source.content)),
    ]),
  );
  const ledgerRows = parseTypedSpecLedgerRows(input.sources);
  const ledgerBySpecId = new Map(ledgerRows.map((row) => [row.specId, row]));
  const ledgerCounts = new Map<string, number>();
  const findings: SpecIrFindingRow[] = [];
  for (const row of ledgerRows) {
    ledgerCounts.set(row.specId, (ledgerCounts.get(row.specId) ?? 0) + 1);
  }

  for (const def of typedDefs) {
    const body = sourceBodyByPath.get(def.source_path) ?? "";
    if (!body.includes(def.spec_id)) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-body-missing",
          subjectId: def.spec_id,
          evidencePath: def.source_path,
        }),
      );
    }
    const row = ledgerBySpecId.get(def.spec_id);
    if (!row) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-ledger-row-missing",
          subjectId: def.spec_id,
          evidencePath: def.source_path,
        }),
      );
      continue;
    }
    if (row.ledgerSources.length === 0) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-ledger-source-missing",
          subjectId: def.spec_id,
          evidencePath: row.sourcePath,
        }),
      );
    }
    if (phaseRank(row.vPhase) === null) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-ledger-phase-missing",
          subjectId: def.spec_id,
          evidencePath: row.sourcePath,
        }),
      );
    }
  }

  for (const [specId, count] of ledgerCounts) {
    if (count <= 1) continue;
    findings.push(
      typedSpecFinding({
        kind: "typed-spec-ledger-duplicate-id",
        subjectId: specId,
        evidencePath: ledgerBySpecId.get(specId)?.sourcePath ?? "",
      }),
    );
  }

  for (const row of ledgerRows) {
    if (!typedIds.has(row.specId)) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-ledger-unknown-id",
          subjectId: row.specId,
          evidencePath: row.sourcePath,
        }),
      );
    }
  }

  for (const relation of input.relations) {
    if (!typedIds.has(relation.from_spec_id) || !typedIds.has(relation.to_spec_id)) continue;
    const fromPhase = phaseRank(ledgerBySpecId.get(relation.from_spec_id)?.vPhase ?? "");
    const toPhase = phaseRank(ledgerBySpecId.get(relation.to_spec_id)?.vPhase ?? "");
    if (fromPhase === null || toPhase === null) continue;
    if (
      (relation.relation_kind === "traces_from" && fromPhase < toPhase) ||
      (relation.relation_kind === "traces_to" && fromPhase > toPhase) ||
      (relation.relation_kind === "tests" && fromPhase > toPhase)
    ) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-phase-direction-invalid",
          subjectId: `${relation.from_spec_id}:${relation.relation_kind}:${relation.to_spec_id}`,
          evidencePath: relation.source,
        }),
      );
    }
  }

  return {
    typedSpecCount: typedDefs.length,
    ledgerRowCount: ledgerRows.length,
    findings,
    ok: findings.length === 0,
  };
}

export function analyzeTypedSpecOwnedArtifactDispersal(input: {
  defs: SpecDefRow[];
  sources: TypedSpecSourceSnapshot[];
}): TypedSpecOwnedArtifactDispersalResult {
  const typedDefs = input.defs.filter(isTypedSpecDef);
  const ledgerRows = parseTypedSpecLedgerRows(input.sources);
  const ledgerBySpecId = new Map(ledgerRows.map((row) => [row.specId, row]));
  const findings: SpecIrFindingRow[] = [];
  let dispersedSpecCount = 0;

  for (const def of typedDefs) {
    const row = ledgerBySpecId.get(def.spec_id);
    if (!row) continue;
    if (row.ledgerSources.some((source) => sourceMatchesLedgerSource(def.source_path, source))) {
      dispersedSpecCount += 1;
      continue;
    }
    findings.push(
      typedSpecFinding({
        kind: "typed-spec-owned-source-mismatch",
        subjectId: def.spec_id,
        evidencePath: def.source_path,
      }),
    );
  }

  return {
    typedSpecCount: typedDefs.length,
    dispersedSpecCount,
    findings,
    ok: findings.length === 0,
  };
}

export function analyzeTypedSpecPhaseLayerAlignment(input: {
  defs: SpecDefRow[];
  sources: TypedSpecSourceSnapshot[];
}): TypedSpecPhaseLayerAlignmentResult {
  const typedDefs = input.defs.filter(isTypedSpecDef);
  const ledgerRows = parseTypedSpecLedgerRows(input.sources);
  const ledgerBySpecId = new Map(ledgerRows.map((row) => [row.specId, row]));
  const sourceByPath = new Map(input.sources.map((source) => [normalizePath(source.path), source]));
  const findings: SpecIrFindingRow[] = [];
  let alignedSpecCount = 0;

  for (const def of typedDefs) {
    const row = ledgerBySpecId.get(def.spec_id);
    if (!row) continue;
    const source = sourceByPath.get(normalizePath(def.source_path));
    const ownerPhases = sourceOwnerPhases(source);
    if (ownerPhases.length === 0) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-owner-phase-missing",
          subjectId: def.spec_id,
          evidencePath: def.source_path,
        }),
      );
      continue;
    }
    if (!phaseMatchesOwner(row.vPhase, ownerPhases)) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-phase-layer-mismatch",
          subjectId: `${def.spec_id}:v_phase:${row.vPhase}:owner:${ownerPhases.join(",")}`,
          evidencePath: def.source_path,
        }),
      );
      continue;
    }
    alignedSpecCount += 1;
  }

  return {
    typedSpecCount: typedDefs.length,
    alignedSpecCount,
    findings,
    ok: findings.length === 0,
  };
}

export function analyzeTypedSpecTraceClosure(input: {
  defs: SpecDefRow[];
  relations: SpecRelationRow[];
}): TypedSpecTraceClosureResult {
  const typedDefs = input.defs.filter(isTypedSpecDef);
  const typedIds = new Set(typedDefs.map((def) => def.spec_id));
  const typedById = new Map(typedDefs.map((def) => [def.spec_id, def]));
  const typedRelations = input.relations.filter(
    (relation) => typedIds.has(relation.from_spec_id) || typedIds.has(relation.to_spec_id),
  );
  const relationKeys = new Set(
    typedRelations.map((relation) =>
      traceKey(relation.from_spec_id, relation.relation_kind, relation.to_spec_id),
    ),
  );
  const testsBySpecId = new Map<string, SpecRelationRow[]>();
  const findings: SpecIrFindingRow[] = [];

  for (const relation of typedRelations) {
    if (relation.relation_kind === "tests") {
      const rows = testsBySpecId.get(relation.from_spec_id) ?? [];
      rows.push(relation);
      testsBySpecId.set(relation.from_spec_id, rows);
    }
    if (relation.relation_kind === "traces_to") {
      const reverse = traceKey(relation.to_spec_id, "traces_from", relation.from_spec_id);
      if (!relationKeys.has(reverse)) {
        findings.push(
          typedSpecFinding({
            kind: "typed-spec-trace-reverse-missing",
            subjectId: `${relation.from_spec_id}:traces_to:${relation.to_spec_id}`,
            evidencePath: relation.source,
          }),
        );
      }
    }
    if (relation.relation_kind === "traces_from") {
      const reverse = traceKey(relation.to_spec_id, "traces_to", relation.from_spec_id);
      const testBacklink = traceKey(relation.to_spec_id, "tests", relation.from_spec_id);
      if (!relationKeys.has(reverse) && !relationKeys.has(testBacklink)) {
        findings.push(
          typedSpecFinding({
            kind: "typed-spec-trace-reverse-missing",
            subjectId: `${relation.from_spec_id}:traces_from:${relation.to_spec_id}`,
            evidencePath: relation.source,
          }),
        );
      }
    }
    if (relation.relation_kind === "tests") {
      const testDef = typedById.get(relation.to_spec_id);
      const testTracesBack = traceKey(relation.to_spec_id, "traces_from", relation.from_spec_id);
      if (!testDef || !relationKeys.has(testTracesBack)) {
        findings.push(
          typedSpecFinding({
            kind: "typed-spec-test-backlink-missing",
            subjectId: `${relation.from_spec_id}:tests:${relation.to_spec_id}`,
            evidencePath: relation.source,
          }),
        );
      }
    }
  }

  for (const def of typedDefs) {
    if (
      requiresTypedSpecTest(def.spec_kind) &&
      (testsBySpecId.get(def.spec_id)?.length ?? 0) === 0
    ) {
      findings.push(
        typedSpecFinding({
          kind: "typed-spec-test-missing",
          subjectId: def.spec_id,
          evidencePath: def.source_path,
        }),
      );
    }
  }

  return {
    typedSpecCount: typedDefs.length,
    relationCount: typedRelations.length,
    findings,
    ok: findings.length === 0,
  };
}

interface SpecFlowEdge {
  from: string;
  to: string;
  relation_kind: string;
}

function typedSpecFlowEdges(relations: SpecRelationRow[], typedIds: Set<string>): SpecFlowEdge[] {
  const edges: SpecFlowEdge[] = [];
  for (const relation of relations) {
    if (!typedIds.has(relation.from_spec_id) || !typedIds.has(relation.to_spec_id)) continue;
    if (relation.relation_kind === "traces_from" || relation.relation_kind === "requires") {
      edges.push({
        from: relation.to_spec_id,
        to: relation.from_spec_id,
        relation_kind: relation.relation_kind,
      });
      continue;
    }
    if (relation.relation_kind === "pairs") continue;
    edges.push({
      from: relation.from_spec_id,
      to: relation.to_spec_id,
      relation_kind: relation.relation_kind,
    });
  }
  return edges;
}

function reachableSpecIds(
  start: string,
  edges: SpecFlowEdge[],
  direction: "upstream" | "downstream",
): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const matches =
      direction === "downstream"
        ? edges.filter((edge) => edge.from === current)
        : edges.filter((edge) => edge.to === current);
    for (const edge of matches) {
      const next = direction === "downstream" ? edge.to : edge.from;
      if (seen.has(next)) continue;
      seen.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
}

function isTypedSpecTestLike(def: SpecDefRow | undefined): boolean {
  if (!def) return false;
  const text = `${def.spec_id} ${def.spec_kind} ${def.title}`.toLowerCase();
  return text.includes("test") || text.includes("oracle");
}

function typedSpecFindingCount(specId: string, findings: SpecIrFindingRow[]): number {
  return findings.filter(
    (finding) => finding.subject_id === specId || finding.subject_id.startsWith(`${specId}:`),
  ).length;
}

export function deriveSpecRagClosureEntries(input: {
  defs: SpecDefRow[];
  relations: SpecRelationRow[];
  closureFindings: SpecIrFindingRow[];
  indexedAt: string;
}): SpecRagClosureEntryRow[] {
  const typedDefs = input.defs.filter(isTypedSpecDef);
  const typedById = new Map(typedDefs.map((def) => [def.spec_id, def]));
  const typedIds = new Set(typedById.keys());
  const flowEdges = typedSpecFlowEdges(input.relations, typedIds);
  return typedDefs.map((def) => {
    const upstream = reachableSpecIds(def.spec_id, flowEdges, "upstream");
    const downstream = reachableSpecIds(def.spec_id, flowEdges, "downstream");
    const testIds = downstream.filter((id) => isTypedSpecTestLike(typedById.get(id)));
    const requiresTest = requiresTypedSpecTest(def.spec_kind);
    const findingCount = typedSpecFindingCount(def.spec_id, input.closureFindings);
    const rag: SpecRagClosureEntryRow["rag"] =
      requiresTest && testIds.length === 0 ? "red" : findingCount > 0 ? "yellow" : "green";
    const closureStatus =
      rag === "green"
        ? "closed"
        : requiresTest && testIds.length === 0
          ? "missing_test"
          : "partial";
    const impactSummary = `upstream=${upstream.length};downstream=${downstream.length};tests=${testIds.length};findings=${findingCount}`;
    return {
      spec_rag_entry_id: stableId("spec-rag-closure", def.spec_id),
      spec_id: def.spec_id,
      spec_kind: def.spec_kind,
      layer: def.layer,
      sub_doc: def.sub_doc,
      rag,
      closure_status: closureStatus,
      requires_test: requiresTest ? 1 : 0,
      upstream_count: upstream.length,
      downstream_count: downstream.length,
      test_count: testIds.length,
      finding_count: findingCount,
      impact_summary: impactSummary,
      source_path: def.source_path,
      indexed_at: input.indexedAt,
    };
  });
}

function normalizeDocumentPath(path: string): string {
  return normalizePath(path).split("#")[0] ?? "";
}

function specDefDocumentPath(def: SpecDefRow): string {
  return normalizeDocumentPath(def.source_path || def.owner_path);
}

function canonicalCycle(nodes: string[]): string {
  const cycle = nodes.at(-1) === nodes[0] ? nodes.slice(0, -1) : [...nodes];
  if (cycle.length === 0) return "";
  let best = cycle;
  for (let i = 1; i < cycle.length; i += 1) {
    const rotated = [...cycle.slice(i), ...cycle.slice(0, i)];
    if (rotated.join("\u0000") < best.join("\u0000")) best = rotated;
  }
  return [...best, best[0]].join(" -> ");
}

export function analyzeDesignDocCrossIntegrity(input: {
  defs: SpecDefRow[];
  relations: SpecRelationRow[];
  catalog_entries: DocumentCatalogEntryRow[];
}): DesignDocCrossIntegrityResult {
  const catalogDocPaths = new Set(
    input.catalog_entries
      .map((entry) => normalizeDocumentPath(entry.authoring_source_path))
      .filter(Boolean),
  );
  const isTargetDoc = (path: string): boolean =>
    catalogDocPaths.size === 0 || catalogDocPaths.has(normalizeDocumentPath(path));
  const targetDefs = input.defs.filter((def) => isTargetDoc(specDefDocumentPath(def)));
  const checkedDocs = new Set(targetDefs.map(specDefDocumentPath).filter(Boolean));
  const defsBySpecId = new Map<string, SpecDefRow[]>();
  const firstDefBySpecId = new Map<string, SpecDefRow>();
  for (const def of targetDefs) {
    const rows = defsBySpecId.get(def.spec_id) ?? [];
    rows.push(def);
    defsBySpecId.set(def.spec_id, rows);
    if (!firstDefBySpecId.has(def.spec_id)) firstDefBySpecId.set(def.spec_id, def);
  }

  const findings: SpecIrFindingRow[] = [];
  const duplicateDefinitions: string[] = [];
  for (const [specId, rows] of defsBySpecId) {
    const sourcePaths = [...new Set(rows.map(specDefDocumentPath).filter(Boolean))].sort();
    if (sourcePaths.length <= 1) continue;
    const subject = `${specId}:${sourcePaths.join("|")}`;
    duplicateDefinitions.push(subject);
    findings.push({
      finding_id: stableId("finding:design-doc-duplicate-definition", subject),
      kind: "design-doc-duplicate-definition",
      severity: "warn",
      subject_id: specId,
      source: "design-doc-cross-integrity",
      status: "open",
      evidence_path: sourcePaths[0],
    });
  }

  const edges = new Map<string, Set<string>>();
  const dependencyRelationKinds = new Set(["requires", "traces_to", "derives", "supersedes"]);
  for (const relation of input.relations) {
    if (!dependencyRelationKinds.has(relation.relation_kind)) continue;
    const from = firstDefBySpecId.get(relation.from_spec_id);
    const to = firstDefBySpecId.get(relation.to_spec_id);
    if (!from || !to) continue;
    const fromPath = specDefDocumentPath(from);
    const toPath = specDefDocumentPath(to);
    if (!fromPath || !toPath || fromPath === toPath) continue;
    if (!isTargetDoc(fromPath) || !isTargetDoc(toPath)) continue;
    const targets = edges.get(fromPath) ?? new Set<string>();
    targets.add(toPath);
    edges.set(fromPath, targets);
  }

  const cycles = new Set<string>();
  const visit = (node: string, stack: string[], seen: Set<string>): void => {
    const nextNodes = [...(edges.get(node) ?? [])].sort();
    for (const next of nextNodes) {
      const existingIndex = stack.indexOf(next);
      if (existingIndex >= 0) {
        cycles.add(canonicalCycle([...stack.slice(existingIndex), next]));
        continue;
      }
      if (seen.has(next)) continue;
      visit(next, [...stack, next], new Set([...seen, next]));
    }
  };
  for (const node of [...edges.keys()].sort()) {
    visit(node, [node], new Set([node]));
  }

  const dependencyCycles = [...cycles].sort();
  for (const cycle of dependencyCycles) {
    findings.push({
      finding_id: stableId("finding:design-doc-dependency-cycle", cycle),
      kind: "design-doc-dependency-cycle",
      severity: "warn",
      subject_id: cycle,
      source: "design-doc-cross-integrity",
      status: "open",
      evidence_path: cycle.split(" -> ")[0] ?? "",
    });
  }

  return {
    checked_docs: checkedDocs.size,
    duplicate_definitions: duplicateDefinitions,
    dependency_cycles: dependencyCycles,
    findings,
    ok: findings.length === 0,
  };
}

export function analyzeSpecIrIntegrity(input: {
  defs: SpecDefRow[];
  relations: SpecRelationRow[];
  relationFindings: SpecIrFindingRow[];
  schedules: ScheduleEntryRow[];
  activations: ActivationEntryRow[];
  activationScheduleReviews: ActivationScheduleReviewRow[];
  documentScaleProfileEntries: DocumentScaleProfileEntryRow[];
  documentScaleProfileReviews: DocumentScaleProfileReviewRow[];
}): SpecIrFindingRow[] {
  const findings = [...input.relationFindings];
  const defIds = new Set(input.defs.map((def) => def.spec_id));
  const planIds = new Set(input.defs.map((def) => def.plan_id).filter(Boolean));
  const schedulePlanCounts = new Map<string, number>();
  const specDefCounts = new Map<string, number>();
  const validScaleProfileDecisions = new Set(["adopt", "conditional", "skip", "defer"]);
  const validScaleProfileDetails = new Set(["lite", "standard", "detailed"]);
  const validScaleProfileStatuses = new Set([
    "minimal",
    "standard",
    "required",
    "skipped",
    "draft",
    "profile_controlled",
  ]);
  for (const def of input.defs) {
    specDefCounts.set(def.spec_id, (specDefCounts.get(def.spec_id) ?? 0) + 1);
    if (shouldValidateDesignSubDoc(def) && !isValidSubDocForLayer(def.layer, def.sub_doc)) {
      findings.push({
        finding_id: stableId(
          "finding:spec-ir-invalid-subdoc",
          `${def.spec_id}:${def.layer}:${def.sub_doc}`,
        ),
        kind: "spec-ir-invalid-subdoc",
        severity: "warn",
        subject_id: def.spec_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: def.source_path,
      });
    }
    if (def.section_anchor.startsWith("spec.defines:")) {
      if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(def.spec_id)) {
        findings.push({
          finding_id: stableId("finding:typed-spec-invalid-id", def.spec_id),
          kind: "typed-spec-invalid-id",
          severity: "warn",
          subject_id: def.spec_id,
          source: "spec-ir-projection",
          status: "open",
          evidence_path: def.source_path,
        });
      }
      if (def.spec_kind === "typed-spec-missing-kind") {
        findings.push({
          finding_id: stableId("finding:typed-spec-kind-missing", def.spec_id),
          kind: "typed-spec-kind-missing",
          severity: "warn",
          subject_id: def.spec_id,
          source: "spec-ir-projection",
          status: "open",
          evidence_path: def.source_path,
        });
      }
    }
    for (const value of Object.values(def)) {
      if (typeof value === "string" && isSecretLike(value)) {
        findings.push({
          finding_id: stableId("finding:spec-ir-secret-like-payload", def.spec_id),
          kind: "spec-ir-secret-like-payload",
          severity: "error",
          subject_id: def.spec_id,
          source: "spec-ir-projection",
          status: "open",
          evidence_path: def.source_path,
        });
      }
    }
  }
  for (const [specId, count] of specDefCounts) {
    if (count <= 1) continue;
    findings.push({
      finding_id: stableId("finding:typed-spec-duplicate-id", specId),
      kind: "typed-spec-duplicate-id",
      severity: "warn",
      subject_id: specId,
      source: "spec-ir-projection",
      status: "open",
      evidence_path: input.defs.find((def) => def.spec_id === specId)?.source_path ?? "",
    });
  }
  for (const relation of input.relations) {
    if (!defIds.has(relation.from_spec_id) || !defIds.has(relation.to_spec_id)) {
      findings.push({
        finding_id: stableId("finding:spec-ir-orphan-relation", relation.relation_id),
        kind: "spec-ir-orphan-relation",
        severity: "warn",
        subject_id: relation.relation_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: relation.evidence_path,
      });
    }
  }
  findings.push(
    ...analyzeTypedSpecTraceClosure({
      defs: input.defs,
      relations: input.relations,
    }).findings,
  );
  for (const schedule of input.schedules) {
    schedulePlanCounts.set(schedule.plan_id, (schedulePlanCounts.get(schedule.plan_id) ?? 0) + 1);
    if (!schedule.current_location.trim()) {
      findings.push({
        finding_id: stableId(
          "finding:schedule-current-location-missing",
          schedule.schedule_entry_id,
        ),
        kind: "schedule-current-location-missing",
        severity: "warn",
        subject_id: schedule.schedule_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: schedule.source_path,
      });
    }
    if (schedule.rag && !["green", "yellow", "red"].includes(schedule.rag)) {
      findings.push({
        finding_id: stableId("finding:schedule-rag-unknown", schedule.schedule_entry_id),
        kind: "schedule-rag-unknown",
        severity: "warn",
        subject_id: schedule.schedule_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: schedule.source_path,
      });
    }
  }
  for (const [planId, count] of schedulePlanCounts) {
    if (count <= 1) continue;
    findings.push({
      finding_id: stableId("finding:schedule-duplicate-plan", planId),
      kind: "schedule-duplicate-plan",
      severity: "warn",
      subject_id: planId,
      source: "spec-ir-projection",
      status: "open",
      evidence_path:
        input.schedules.find((schedule) => schedule.plan_id === planId)?.source_path ?? "",
    });
  }
  for (const activation of input.activations) {
    if (
      (activation.scope_status === "out_of_scope" || activation.scope_status === "deferred") &&
      activation.defer_reason === ""
    ) {
      findings.push({
        finding_id: stableId("finding:activation-reason-missing", activation.activation_entry_id),
        kind: "activation-reason-missing",
        severity: "warn",
        subject_id: activation.activation_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: activation.source_path,
      });
    }
  }
  for (const review of input.activationScheduleReviews) {
    if (review.target_kind === "plan" && !review.schedule_entry_id) {
      findings.push({
        finding_id: stableId("finding:activation-schedule-missing", review.activation_entry_id),
        kind: "activation-schedule-missing",
        severity: "warn",
        subject_id: review.activation_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: review.source_path,
      });
    }
  }
  for (const entry of input.documentScaleProfileEntries) {
    if (!validScaleProfileDecisions.has(entry.decision)) {
      findings.push({
        finding_id: stableId(
          "finding:document-scale-profile-decision-unknown",
          entry.document_scale_profile_entry_id,
        ),
        kind: "document-scale-profile-decision-unknown",
        severity: "warn",
        subject_id: entry.document_scale_profile_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: entry.source_path,
      });
    }
    if (entry.detail_override && !validScaleProfileDetails.has(entry.detail_override)) {
      findings.push({
        finding_id: stableId(
          "finding:document-scale-profile-detail-unknown",
          entry.document_scale_profile_entry_id,
        ),
        kind: "document-scale-profile-detail-unknown",
        severity: "warn",
        subject_id: entry.document_scale_profile_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: entry.source_path,
      });
    }
    if (entry.status_override && !validScaleProfileStatuses.has(entry.status_override)) {
      findings.push({
        finding_id: stableId(
          "finding:document-scale-profile-status-unknown",
          entry.document_scale_profile_entry_id,
        ),
        kind: "document-scale-profile-status-unknown",
        severity: "warn",
        subject_id: entry.document_scale_profile_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: entry.source_path,
      });
    }
    if (["conditional", "skip", "defer"].includes(entry.decision) && entry.reason.trim() === "") {
      findings.push({
        finding_id: stableId(
          "finding:document-scale-profile-reason-missing",
          entry.document_scale_profile_entry_id,
        ),
        kind: "document-scale-profile-reason-missing",
        severity: "warn",
        subject_id: entry.document_scale_profile_entry_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: entry.source_path,
      });
    }
    if (entry.required_plan_id && !planIds.has(entry.required_plan_id)) {
      findings.push({
        finding_id: stableId(
          "finding:document-scale-profile-required-plan-missing",
          `${entry.document_scale_profile_entry_id}:${entry.required_plan_id}`,
        ),
        kind: "document-scale-profile-required-plan-missing",
        severity: "warn",
        subject_id: `${entry.document_scale_profile_entry_id}:${entry.required_plan_id}`,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: entry.source_path,
      });
    }
  }
  for (const review of input.documentScaleProfileReviews) {
    if (!review.document_catalog_entry_id) {
      findings.push({
        finding_id: stableId(
          "finding:document-scale-profile-catalog-missing",
          review.document_scale_profile_review_id,
        ),
        kind: "document-scale-profile-catalog-missing",
        severity: "warn",
        subject_id: review.document_scale_profile_review_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: review.source_path,
      });
    }
    if (
      review.catalog_skip_reason_required === 1 &&
      ["conditional", "skip", "defer"].includes(review.decision) &&
      review.reason.trim() === ""
    ) {
      findings.push({
        finding_id: stableId(
          "finding:document-scale-profile-catalog-reason-missing",
          review.document_scale_profile_review_id,
        ),
        kind: "document-scale-profile-catalog-reason-missing",
        severity: "warn",
        subject_id: review.document_scale_profile_review_id,
        source: "spec-ir-projection",
        status: "open",
        evidence_path: review.source_path,
      });
    }
  }
  return findings;
}

export function deriveDetectorRouteCandidates(
  findings: SpecIrFindingRow[],
  computedAt: string,
): DetectorRouteCandidateRow[] {
  return findings.map((finding) => ({
    route_candidate_id: stableId("detector-route-candidate", finding.finding_id),
    source_table: "findings",
    source_id: finding.finding_id,
    detector_id: "spec-ir-integrity",
    finding_kind: finding.kind,
    severity: finding.severity,
    subject_kind: "spec_ir",
    subject_id: finding.subject_id,
    filing_target_id: "routeFiling:feature_addition",
    target_layer: "L6",
    target_sub_doc: "function-spec",
    candidate_status: "non_ready",
    reason: "Spec IR integrity finding requires routeFiling SSoT evaluation before filing.",
    evidence_path: finding.evidence_path,
    computed_at: computedAt,
  }));
}

export function collectSpecIrProjection(repoRoot: string, indexedAt: string): SpecIrProjection {
  const sources = loadSpecIrSources(repoRoot);
  const defs = parseSpecDefs(sources, indexedAt);
  const relationResult = parseSpecRelations(sources, defs, indexedAt);
  const schedules = parseScheduleEntries(sources, indexedAt, repoRoot);
  const activations = parseActivationEntries(sources, indexedAt);
  const documentCatalogEntries = parseDocumentCatalogEntries(sources, indexedAt);
  const documentScaleProfileEntries = parseDocumentScaleProfileEntries(sources, indexedAt);
  const documentScaleProfileReviews = joinDocumentScaleProfileReviews({
    profileEntries: documentScaleProfileEntries,
    catalogEntries: documentCatalogEntries,
    indexedAt,
  });
  const agentContracts = parseAgentContractRows(sources, indexedAt);
  const activationScheduleReviews = joinActivationScheduleReviews({
    activations,
    schedules,
    indexedAt,
  });
  const typedSpecTraceClosure = analyzeTypedSpecTraceClosure({
    defs,
    relations: relationResult.relations,
  });
  const specRagClosureEntries = deriveSpecRagClosureEntries({
    defs,
    relations: relationResult.relations,
    closureFindings: typedSpecTraceClosure.findings,
    indexedAt,
  });
  const findings = analyzeSpecIrIntegrity({
    defs,
    relations: relationResult.relations,
    relationFindings: relationResult.findings,
    schedules,
    activations,
    activationScheduleReviews,
    documentScaleProfileEntries,
    documentScaleProfileReviews,
  });
  findings.push(
    ...analyzeTypedSpecLedgerBodySync({
      defs,
      relations: relationResult.relations,
      sources,
    }).findings,
  );
  findings.push(
    ...analyzeTypedSpecOwnedArtifactDispersal({
      defs,
      sources,
    }).findings,
  );
  findings.push(
    ...analyzeTypedSpecPhaseLayerAlignment({
      defs,
      sources,
    }).findings,
  );
  findings.push(
    ...analyzeAgentContractIntegrity({
      contracts: agentContracts,
      sources,
    }).findings,
  );
  findings.push(
    ...analyzeDesignDocCrossIntegrity({
      defs,
      relations: relationResult.relations,
      catalog_entries: documentCatalogEntries,
    }).findings,
  );
  return {
    spec_defs: defs,
    spec_relations: relationResult.relations,
    schedule_entries: schedules,
    activation_entries: activations,
    activation_schedule_reviews: activationScheduleReviews,
    document_catalog_entries: documentCatalogEntries,
    document_scale_profile_entries: documentScaleProfileEntries,
    document_scale_profile_reviews: documentScaleProfileReviews,
    spec_rag_closure_entries: specRagClosureEntries,
    agent_contracts: agentContracts,
    detector_route_candidates: deriveDetectorRouteCandidates(findings, indexedAt),
    findings,
  };
}

export function projectSpecIr(repoRoot: string, db: HarnessDb, deps: SpecIrProjectionDeps): void {
  const projection = collectSpecIrProjection(repoRoot, deps.nowIso());
  for (const row of projection.spec_defs) {
    deps.recordProjectionEvent(db, { table: "spec_defs", id: row.spec_id, row: { ...row } });
    if (row.section_anchor.startsWith("spec.defines:")) {
      deps.recordProjectionEvent(db, {
        table: "search_index",
        id: stableId("typed-spec", row.spec_id),
        row: {
          search_id: stableId("typed-spec", row.spec_id),
          subject_type: "typed_spec",
          subject_id: row.spec_id,
          path: row.source_path,
          title: `${row.spec_id} ${row.spec_kind}`,
          tokens: `${row.spec_id} ${row.spec_kind} ${row.layer} ${row.sub_doc} ${row.owner_path}`,
          summary: `typed spec declaration from ${row.owner_path}`,
          updated_at: row.indexed_at,
        },
      });
    }
  }
  for (const row of projection.spec_relations) {
    deps.recordProjectionEvent(db, {
      table: "spec_relations",
      id: row.relation_id,
      row: { ...row },
    });
  }
  for (const row of projection.schedule_entries) {
    deps.recordProjectionEvent(db, {
      table: "schedule_entries",
      id: row.schedule_entry_id,
      row: { ...row },
    });
  }
  for (const row of projection.activation_entries) {
    deps.recordProjectionEvent(db, {
      table: "activation_entries",
      id: row.activation_entry_id,
      row: { ...row },
    });
  }
  for (const row of projection.activation_schedule_reviews) {
    deps.recordProjectionEvent(db, {
      table: "activation_schedule_reviews",
      id: row.activation_schedule_review_id,
      row: { ...row },
    });
    deps.recordProjectionEvent(db, {
      table: "search_index",
      id: stableId("activation-schedule-review", row.activation_schedule_review_id),
      row: {
        search_id: stableId("activation-schedule-review", row.activation_schedule_review_id),
        subject_type: "activation_schedule_review",
        subject_id: row.activation_schedule_review_id,
        path: row.source_path,
        title: `${row.plan_id} ${row.profile_id} ${row.scope_status}`,
        tokens:
          `${row.profile_id} ${row.plan_id} ${row.scope_status} ${row.target_version} ` +
          `${row.layer} ${row.sub_doc} ${row.v_pair} ${row.rag} ${row.schedule_status} ` +
          `${row.current_location} ${row.defer_reason}`,
        summary:
          `activation profile ${row.scope_status}; enabled=${row.enabled}; ` +
          `location=${row.current_location}`,
        updated_at: row.indexed_at,
      },
    });
  }
  for (const row of projection.document_catalog_entries) {
    deps.recordProjectionEvent(db, {
      table: "document_catalog_entries",
      id: row.document_catalog_entry_id,
      row: { ...row },
    });
    deps.recordProjectionEvent(db, {
      table: "search_index",
      id: stableId("document-catalog-entry", row.document_catalog_entry_id),
      row: {
        search_id: stableId("document-catalog-entry", row.document_catalog_entry_id),
        subject_type: "document_catalog_entry",
        subject_id: row.doc_type_id,
        path: row.source_path,
        title: `${row.doc_type_id} ${row.layer} ${row.sub_doc}`,
        tokens:
          `${row.doc_type_id} ${row.layer} ${row.sub_doc} ${row.category} ` +
          `${row.requirement_class} ${row.applicability} ${row.default_status} ` +
          `${row.source_doc_family} ${row.authoring_source_path} ${row.projection_table}`,
        summary:
          `document catalog ${row.default_status}; profile_controlled=${row.profile_controlled}; ` +
          `skip_reason_required=${row.skip_reason_required}`,
        updated_at: row.indexed_at,
      },
    });
  }
  for (const row of projection.document_scale_profile_entries) {
    deps.recordProjectionEvent(db, {
      table: "document_scale_profile_entries",
      id: row.document_scale_profile_entry_id,
      row: { ...row },
    });
  }
  for (const row of projection.document_scale_profile_reviews) {
    deps.recordProjectionEvent(db, {
      table: "document_scale_profile_reviews",
      id: row.document_scale_profile_review_id,
      row: { ...row },
    });
    deps.recordProjectionEvent(db, {
      table: "search_index",
      id: stableId("document-scale-profile-review", row.document_scale_profile_review_id),
      row: {
        search_id: stableId("document-scale-profile-review", row.document_scale_profile_review_id),
        subject_type: "document_scale_profile_review",
        subject_id: `${row.profile_id}:${row.doc_type_id}`,
        path: row.source_path,
        title: `${row.profile_id} ${row.doc_type_id} ${row.decision}`,
        tokens:
          `${row.profile_id} ${row.doc_type_id} ${row.decision} ${row.detail_override} ` +
          `${row.status_override} ${row.required_plan_id} ${row.catalog_layer} ` +
          `${row.catalog_sub_doc} ${row.requirement_class} ${row.catalog_default_status} ` +
          `${row.reason}`,
        summary:
          `document scale profile ${row.decision}; detail=${row.detail_override}; ` +
          `status=${row.status_override}`,
        updated_at: row.indexed_at,
      },
    });
  }
  for (const row of projection.spec_rag_closure_entries) {
    deps.recordProjectionEvent(db, {
      table: "spec_rag_closure_entries",
      id: row.spec_rag_entry_id,
      row: { ...row },
    });
    deps.recordProjectionEvent(db, {
      table: "search_index",
      id: stableId("spec-rag-closure", row.spec_rag_entry_id),
      row: {
        search_id: stableId("spec-rag-closure", row.spec_rag_entry_id),
        subject_type: "spec_rag_closure_entry",
        subject_id: row.spec_id,
        path: row.source_path,
        title: `${row.spec_id} ${row.rag} ${row.closure_status}`,
        tokens:
          `${row.spec_id} ${row.spec_kind} ${row.layer} ${row.sub_doc} ${row.rag} ` +
          `${row.closure_status} ${row.impact_summary}`,
        summary:
          `spec closure RAG ${row.rag}; status=${row.closure_status}; ` +
          `tests=${row.test_count}; findings=${row.finding_count}`,
        updated_at: row.indexed_at,
      },
    });
  }
  for (const row of projection.agent_contracts) {
    deps.recordProjectionEvent(db, {
      table: "agent_contracts",
      id: row.agent_contract_id,
      row: { ...row },
    });
    deps.recordProjectionEvent(db, {
      table: "search_index",
      id: stableId("agent-contract", row.agent_contract_id),
      row: {
        search_id: stableId("agent-contract", row.agent_contract_id),
        subject_type: "agent_contract",
        subject_id: row.agent_contract_id,
        path: row.source_path,
        title: `${row.agent_contract_id} ${row.target_path}`,
        tokens: `${row.agent_contract_id} ${row.target_path} ${row.defines} ${row.read_first} ${row.done_when}`,
        summary: `agent contract for ${row.target_path}`,
        updated_at: row.indexed_at,
      },
    });
  }
  for (const row of projection.findings) {
    deps.recordProjectionEvent(db, { table: "findings", id: row.finding_id, row: { ...row } });
  }
  for (const row of projection.detector_route_candidates) {
    deps.recordProjectionEvent(db, {
      table: "detector_route_candidates",
      id: row.route_candidate_id,
      row: { ...row },
    });
  }
}
