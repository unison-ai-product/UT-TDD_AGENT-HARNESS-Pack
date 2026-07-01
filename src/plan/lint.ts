import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { analyzeG1Trace, g1TraceMessages, g1TraceOk, loadG1TraceDocs } from "../lint/g1-trace";
import { analyzeG3Trace, g3TraceMessages, g3TraceOk, loadDocs } from "../lint/g3-trace";
import { type Frontmatter, frontmatterSchema } from "../schema/frontmatter";
import { routeSignalCandidates } from "../schema/route-map";
import {
  DB_PROJECTION_BACKPROP_REQUIRED_GENERATES,
  DESIGN_LAYERS_REQUIRING_SUB_DOC,
  INTERNAL_ASSET_EXTENSION_PLAN_IDS,
  KIND_LAYER_ENFORCEMENT_DATE,
  MODE_PATTERN,
  READY_DEPENDENCY_STATUSES,
  REQUIRED_AGENT_ROLE_ENFORCEMENT_DATE,
  REQUIRED_REVERSE_FULLBACK_SCOPE_LAYERS,
  REVERSE_FULLBACK_BACKPROP_ENFORCEMENT_DATE,
  REVERSE_R4_CLAIMED_ARTIFACT_ENFORCEMENT_DATE,
  REVERSE_R4_ROUTE_BACKPROP_ENFORCEMENT_DATE,
  REVIEW_PATTERN,
  ROUTE_CERTIFICATE_ENFORCEMENT_DATE,
  SERIAL_MODE_PATTERN,
  SERIAL_REASONS,
  VALID_REVERSE_FULLBACK_SCOPE_DECISIONS,
  VALID_SUB_DOCS,
} from "./lint-policy";
import type {
  LintResult,
  PlanGovernanceDoc,
  PlanGovernanceResult,
  PlanGovernanceViolation,
  PlanScheduleDoc,
  PlanScheduleResult,
  PlanScheduleViolation,
} from "./lint-types";

export type {
  LintResult,
  PlanGovernanceDoc,
  PlanGovernanceResult,
  PlanGovernanceViolation,
  PlanGovernanceViolationReason,
  PlanScheduleDoc,
  PlanScheduleResult,
  PlanScheduleViolation,
} from "./lint-types";

function section(content: string, start: RegExp, end: RegExp): string {
  const m = content.match(start);
  if (!m || m.index === undefined) return "";
  const rest = content.slice(m.index + m[0].length);
  const e = rest.search(end);
  return e < 0 ? rest : rest.slice(0, e);
}

export function extractScheduleSection(content: string): string {
  return section(content, /^##\s*§?3\b[^\n]*工程表[^\n]*\n/m, /^##\s/m);
}

function stepBlocks(schedule: string): { heading: string; body: string }[] {
  const matches = [...schedule.matchAll(/^###\s+Step\s+\d+:\s*(.+)$/gm)];
  return matches.map((m, index) => {
    const start = (m.index ?? 0) + m[0].length;
    const end =
      index + 1 < matches.length ? (matches[index + 1].index ?? schedule.length) : schedule.length;
    return { heading: m[1].trim(), body: schedule.slice(start, end) };
  });
}

export function analyzePlanSchedule(docs: PlanScheduleDoc[]): PlanScheduleResult {
  const violations: PlanScheduleViolation[] = [];
  for (const doc of docs) {
    const schedule = extractScheduleSection(doc.content);
    const steps = stepBlocks(schedule);
    if (steps.length === 0) continue;
    let hasReview = false;
    for (const step of steps) {
      const full = `${step.heading}\n${step.body}`;
      if (!MODE_PATTERN.test(step.heading)) {
        violations.push({ file: doc.file, step: step.heading, reason: "missing_mode" });
      }
      if (SERIAL_MODE_PATTERN.test(step.heading) && !SERIAL_REASONS.some((r) => full.includes(r))) {
        violations.push({
          file: doc.file,
          step: step.heading,
          reason: "missing_serial_reason",
        });
      }
      if (REVIEW_PATTERN.test(step.heading)) hasReview = true;
    }
    if (!hasReview) violations.push({ file: doc.file, reason: "missing_review_step" });
    if (!/^##\s*§?3\.1[^\n]*実装計画/m.test(doc.content)) {
      violations.push({ file: doc.file, reason: "missing_impl_plan" });
    }
  }
  return { violations, checked: docs.length, ok: violations.length === 0 };
}

export function loadPlanScheduleDocs(
  repoRoot: string = process.cwd(),
  target?: string,
): PlanScheduleDoc[] {
  if (target) {
    const p = join(repoRoot, target);
    return [{ file: target, content: readFileSync(p, "utf8") }];
  }
  const plansDir = join(repoRoot, "docs", "plans");
  return readdirSync(plansDir)
    .filter((f) => f.startsWith("PLAN-") && f.endsWith(".md"))
    .map((f) => ({
      file: join("docs", "plans", f),
      content: readFileSync(join(plansDir, f), "utf8"),
    }));
}

export function planScheduleMessages(result: PlanScheduleResult): string[] {
  if (result.violations.length === 0) {
    return [`plan-schedule — OK (§工程表 checked=${result.checked}, §G.4 minimal slice)`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.file}${v.step ? `:${v.step}` : ""}:${v.reason}`)
    .join(", ");
  return [
    `plan-schedule — ⚠ §工程表 violation ${result.violations.length} 件 (${sample})。Step の [並列]/[直列]、直列理由、review Step、§3.1 実装計画を確認 (IMP-081)`,
  ];
}

function markdownFrontmatter(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

function parsePlanFrontmatter(doc: PlanGovernanceDoc): Record<string, unknown> | null {
  const raw = markdownFrontmatter(doc.content);
  if (!raw) return null;
  const parsed = parseYaml(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function normalizePlanRef(ref: string): string {
  const normalized = ref.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return basename.endsWith(".md") ? basename.slice(0, -3) : basename;
}

function normalizeArtifactPath(ref: string): string {
  return ref.replaceAll("\\", "/");
}

function isPlanRef(ref: string): boolean {
  const normalized = ref.replaceAll("\\", "/");
  return normalizePlanRef(normalized).startsWith("PLAN-") || normalized.includes("/docs/plans/");
}

function pathExists(repoRoot: string | undefined, ref: string): boolean {
  if (!repoRoot) return true;
  return existsSync(join(repoRoot, ref));
}

function boolField(value: unknown): boolean {
  return value === true;
}

function generatedArtifacts(raw: Record<string, unknown>): { path: string; type: string }[] {
  if (!Array.isArray(raw.generates)) return [];
  return raw.generates
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const path = stringField(record.artifact_path);
      const type = stringField(record.artifact_type);
      return path && type ? { path: normalizeArtifactPath(path), type } : null;
    })
    .filter((artifact): artifact is { path: string; type: string } => Boolean(artifact));
}

function agentRoles(raw: Record<string, unknown>): Set<string> {
  if (!Array.isArray(raw.agent_slots)) return new Set();
  return new Set(
    raw.agent_slots
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        return stringField((entry as Record<string, unknown>).role);
      })
      .filter((role): role is string => Boolean(role)),
  );
}

function requiredAgentRoleViolations(raw: Record<string, unknown>): string[] {
  const status = stringField(raw.status);
  const updated = stringField(raw.updated) ?? stringField(raw.created) ?? "";
  if (status === "archived" || updated < REQUIRED_AGENT_ROLE_ENFORCEMENT_DATE) return [];

  const kind = stringField(raw.kind);
  const phase = stringField(raw.workflow_phase);
  const roles = agentRoles(raw);
  const missing: string[] = [];
  if ((kind === "poc" || kind === "recovery" || kind === "troubleshoot") && !roles.has("aim")) {
    missing.push(`${kind}:aim`);
  }
  if (kind === "reverse" && phase === "R3" && !roles.has("po")) {
    missing.push("reverse:R3:po");
  }
  return missing;
}

function kindLayerViolations(raw: Record<string, unknown>): string[] {
  const status = stringField(raw.status);
  const updated = stringField(raw.updated) ?? stringField(raw.created) ?? "";
  if (status === "archived" || updated < KIND_LAYER_ENFORCEMENT_DATE) return [];
  if (boolField(raw.master_hub)) return [];

  const kind = stringField(raw.kind);
  const layer = stringField(raw.layer);
  if (!kind || !layer) return [];

  const designLayers = new Set(["L1", "L2", "L3", "L4", "L5", "L6"]);
  const addDesignLayers = new Set(["L3", "L4", "L5", "L6"]);
  const researchLayers = new Set(["L1", "L2", "L3", "L4"]);
  const l7Only = new Set(["impl", "add-impl", "refactor", "retrofit", "troubleshoot"]);

  if (kind === "design" && !designLayers.has(layer)) return [`design:${layer}:expected_L1-L6`];
  if (kind === "add-design" && !addDesignLayers.has(layer)) {
    return [`add-design:${layer}:expected_L3-L6`];
  }
  if (l7Only.has(kind) && layer !== "L7") return [`${kind}:${layer}:expected_L7`];
  if (kind === "research" && !researchLayers.has(layer)) {
    return [`research:${layer}:expected_L1-L4`];
  }
  return [];
}

function versionRouteCertificateViolations(raw: Record<string, unknown>): {
  reason: "version_route_certificate_missing" | "version_route_certificate_mismatch";
  detail: string;
}[] {
  if (!stringField(raw.version_target)) return [];
  if (stringField(raw.status) !== "draft") return [];

  const signal = stringField(raw.route_signal);
  const mode = stringField(raw.route_mode);
  const violations: {
    reason: "version_route_certificate_missing" | "version_route_certificate_mismatch";
    detail: string;
  }[] = [];

  if (!signal) {
    violations.push({
      reason: "version_route_certificate_missing",
      detail: "version_target requires route_signal=version_deferral",
    });
  } else if (signal !== "version_deferral") {
    violations.push({
      reason: "version_route_certificate_mismatch",
      detail: `route_signal=${signal} expected version_deferral`,
    });
  }

  if (!mode) {
    violations.push({
      reason: "version_route_certificate_missing",
      detail: "version_target requires route_mode=version-up",
    });
  } else if (mode !== "version-up") {
    violations.push({
      reason: "version_route_certificate_mismatch",
      detail: `route_mode=${mode} expected version-up`,
    });
  }

  return violations;
}

function routeCertificateViolations(raw: Record<string, unknown>): {
  reason: "route_certificate_missing" | "route_certificate_mismatch";
  detail: string;
}[] {
  const created = stringField(raw.created);
  if (!created || created < ROUTE_CERTIFICATE_ENFORCEMENT_DATE) return [];
  if (stringField(raw.status) === "archived") return [];

  const signal = stringField(raw.route_signal);
  const mode = stringField(raw.route_mode);
  const violations: {
    reason: "route_certificate_missing" | "route_certificate_mismatch";
    detail: string;
  }[] = [];

  if (!signal) {
    violations.push({
      reason: "route_certificate_missing",
      detail: `created>=${ROUTE_CERTIFICATE_ENFORCEMENT_DATE} requires route_signal`,
    });
  }
  if (!mode) {
    violations.push({
      reason: "route_certificate_missing",
      detail: `created>=${ROUTE_CERTIFICATE_ENFORCEMENT_DATE} requires route_mode`,
    });
  }
  if (!signal || !mode) return violations;

  const candidates = routeSignalCandidates(signal);
  if (candidates.length === 0) {
    violations.push({
      reason: "route_certificate_mismatch",
      detail: `route_signal=${signal} has no route candidate`,
    });
  } else if (!candidates.includes(mode)) {
    violations.push({
      reason: "route_certificate_mismatch",
      detail: `route_signal=${signal} candidates=${candidates.join("|")} route_mode=${mode}`,
    });
  }

  return violations;
}

function expectedArtifactTypeForPath(path: string): string | null {
  if (path.startsWith("docs/design/")) return "design_doc";
  if (path.startsWith("docs/test-design/")) return "test_design";
  if (path.startsWith("docs/plans/")) return "markdown_doc";
  return null;
}

function isProgressColorProjectionPlan(
  raw: Record<string, unknown>,
  content: string,
  generatedPaths: string[],
): boolean {
  const layer = stringField(raw.layer);
  const drive = stringField(raw.drive);
  const kind = stringField(raw.kind);
  if (layer !== "L7" || drive !== "db" || (kind !== "impl" && kind !== "add-impl")) return false;

  const touchesProjection =
    generatedPaths.includes("src/schema/harness-db.ts") ||
    generatedPaths.includes("src/state-db/projection-writer.ts");
  if (!touchesProjection) return false;

  const searchable = `${stringField(raw.title) ?? ""}\n${content}`;
  return /artifact_progress|progress color|red\/yellow\/green|赤黄緑|赤\/黄\/緑/i.test(searchable);
}

function hasReverseBackpropEvidence(
  generatedPaths: string[],
  deps: Record<string, unknown>,
): boolean {
  const refs = [...generatedPaths, ...stringArray(deps.requires)];
  return refs.some((ref) => {
    const normalized = normalizeArtifactPath(ref);
    return (
      normalized.includes("/PLAN-REVERSE-") ||
      normalizePlanRef(normalized).startsWith("PLAN-REVERSE-")
    );
  });
}

function isBackpropArtifact(path: string): boolean {
  return (
    path.startsWith("docs/design/") ||
    path.startsWith("docs/governance/") ||
    path.startsWith("docs/test-design/")
  );
}

function reverseFullbackScopeViolations(
  raw: Record<string, unknown>,
  generatedPaths: string[],
): string[] {
  const scope = raw.backprop_scope;
  if (!Array.isArray(scope)) {
    return REQUIRED_REVERSE_FULLBACK_SCOPE_LAYERS.map((layer) => `${layer}:missing`);
  }

  const byLayer = new Map<string, Record<string, unknown>>();
  for (const entry of scope) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const layer = stringField(record.layer);
    if (layer) byLayer.set(layer, record);
  }

  const missing: string[] = [];
  for (const layer of REQUIRED_REVERSE_FULLBACK_SCOPE_LAYERS) {
    const entry = byLayer.get(layer);
    if (!entry) {
      missing.push(`${layer}:missing`);
      continue;
    }
    const decision = stringField(entry.decision);
    const reason = stringField(entry.reason);
    if (!decision || !VALID_REVERSE_FULLBACK_SCOPE_DECISIONS.has(decision)) {
      missing.push(`${layer}:invalid_decision`);
    }
    if (!reason || reason.length < 10) {
      missing.push(`${layer}:missing_reason`);
    }
    if (decision === "updated") {
      const evidencePath = stringField(entry.evidence_path);
      if (!evidencePath || !generatedPaths.includes(normalizeArtifactPath(evidencePath))) {
        missing.push(`${layer}:missing_generated_evidence`);
      }
    }
  }
  return missing;
}

function reverseFullbackNeedsGeneratedBackprop(raw: Record<string, unknown>): boolean {
  const kind = stringField(raw.kind);
  const phase = stringField(raw.workflow_phase);
  const reverseType = stringField(raw.confirmed_reverse_type);
  const status = stringField(raw.status);
  const updated = stringField(raw.updated) ?? stringField(raw.created) ?? "";
  return (
    kind === "reverse" &&
    phase === "R4" &&
    reverseType === "fullback" &&
    (status === "confirmed" || status === "completed") &&
    updated >= REVERSE_FULLBACK_BACKPROP_ENFORCEMENT_DATE
  );
}

function reverseR4NeedsClaimedArtifactConsistency(raw: Record<string, unknown>): boolean {
  const kind = stringField(raw.kind);
  const phase = stringField(raw.workflow_phase);
  const reverseType = stringField(raw.confirmed_reverse_type);
  const status = stringField(raw.status);
  const updated = stringField(raw.updated) ?? stringField(raw.created) ?? "";
  return (
    kind === "reverse" &&
    phase === "R4" &&
    reverseType !== "fullback" &&
    (status === "confirmed" || status === "completed") &&
    updated >= REVERSE_R4_CLAIMED_ARTIFACT_ENFORCEMENT_DATE
  );
}

function reverseR4NeedsRouteBackpropEvidence(raw: Record<string, unknown>): boolean {
  const kind = stringField(raw.kind);
  const phase = stringField(raw.workflow_phase);
  const reverseType = stringField(raw.confirmed_reverse_type);
  const status = stringField(raw.status);
  const updated = stringField(raw.updated) ?? stringField(raw.created) ?? "";
  const route = stringField(raw.forward_routing) ?? "";
  return (
    kind === "reverse" &&
    phase === "R4" &&
    reverseType !== "fullback" &&
    (status === "confirmed" || status === "completed") &&
    updated >= REVERSE_R4_ROUTE_BACKPROP_ENFORCEMENT_DATE &&
    /^L[1-6]\b/.test(route)
  );
}

function hasExplicitNoBackpropDecision(raw: Record<string, unknown>): boolean {
  const decision = stringField(raw.backprop_decision);
  const reason = stringField(raw.backprop_decision_reason);
  return decision === "not_required" && Boolean(reason && reason.length >= 10);
}

function claimedBackpropArtifacts(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(
    /\bdocs\/(?:design|governance|test-design)\/[^\s`'")\]]+/g,
  )) {
    refs.add(normalizeArtifactPath(match[0]).replace(/[.,;:]+$/, ""));
  }
  return [...refs];
}

function schemaIssueSummary(issue: {
  path: (string | number)[];
  code: string;
  received?: unknown;
}): string {
  const path = issue.path.join(".") || "(root)";
  const received =
    typeof issue.received === "string" || typeof issue.received === "number"
      ? `(${String(issue.received)})`
      : "";
  return `${path}:${issue.code}${received}`;
}

export function analyzePlanGovernance(
  docs: PlanGovernanceDoc[],
  repoRoot?: string,
): PlanGovernanceResult {
  const violations: PlanGovernanceViolation[] = [];
  const parsed = new Map<
    string,
    { file: string; content: string; raw: Record<string, unknown>; parsed?: Frontmatter }
  >();
  const byPlanId = new Map<string, string[]>();

  for (const doc of docs) {
    const raw = parsePlanFrontmatter(doc);
    if (!raw) {
      violations.push({ file: doc.file, reason: "missing_frontmatter" });
      continue;
    }
    const schemaResult = frontmatterSchema.safeParse(raw);
    if (!schemaResult.success) {
      violations.push({
        file: doc.file,
        reason: "invalid_frontmatter",
        detail: schemaResult.error.issues.slice(0, 3).map(schemaIssueSummary).join(" | "),
      });
    }
    const planId = stringField(raw.plan_id);
    if (planId) {
      byPlanId.set(planId, [...(byPlanId.get(planId) ?? []), doc.file]);
      parsed.set(doc.file, {
        file: doc.file,
        content: doc.content,
        raw,
        ...(schemaResult.success ? { parsed: schemaResult.data } : {}),
      });
    }
  }

  for (const [planId, files] of byPlanId) {
    if (files.length > 1) {
      for (const file of files)
        violations.push({ file, reason: "duplicate_plan_id", detail: planId });
    }
  }

  const byRef = new Map<
    string,
    { file: string; content: string; raw: Record<string, unknown>; parsed?: Frontmatter }
  >();
  for (const entry of parsed.values()) {
    const planId = stringField(entry.raw.plan_id);
    if (planId) byRef.set(planId, entry);
    byRef.set(normalizePlanRef(entry.file), entry);
  }

  const layerSubDoc = new Map<string, string[]>();
  for (const entry of parsed.values()) {
    const raw = entry.raw;
    const planId = stringField(raw.plan_id) ?? entry.file;
    const kind = stringField(raw.kind);
    const layer = stringField(raw.layer);
    const status = stringField(raw.status);
    const subDoc = stringField(raw.sub_doc);
    const isMasterHub = boolField(raw.master_hub);
    const isInternalAssetExtension = INTERNAL_ASSET_EXTENSION_PLAN_IDS.has(planId);

    const missingRoles = requiredAgentRoleViolations(raw);
    if (missingRoles.length > 0) {
      violations.push({
        file: entry.file,
        reason: "missing_required_agent_role",
        detail: missingRoles.join(", "),
      });
    }
    const invalidKindLayers = kindLayerViolations(raw);
    if (invalidKindLayers.length > 0) {
      violations.push({
        file: entry.file,
        reason: "kind_layer_mismatch",
        detail: invalidKindLayers.join(", "),
      });
    }
    for (const violation of versionRouteCertificateViolations(raw)) {
      violations.push({ file: entry.file, ...violation });
    }
    for (const violation of routeCertificateViolations(raw)) {
      violations.push({ file: entry.file, ...violation });
    }

    if (kind === "design" && layer && DESIGN_LAYERS_REQUIRING_SUB_DOC.has(layer) && !isMasterHub) {
      if (!subDoc) {
        violations.push({ file: entry.file, reason: "missing_sub_doc", detail: planId });
      } else if (!VALID_SUB_DOCS[layer]?.has(subDoc)) {
        violations.push({
          file: entry.file,
          reason: "invalid_sub_doc",
          detail: `${layer}/${subDoc}`,
        });
      } else if (status !== "archived" && !isInternalAssetExtension) {
        const key = `${layer}/${subDoc}`;
        layerSubDoc.set(key, [...(layerSubDoc.get(key) ?? []), entry.file]);
      }
    }

    if (Array.isArray(raw.skip_sub_doc)) {
      for (const skip of raw.skip_sub_doc) {
        if (skip && typeof skip === "object") {
          const reason = stringField((skip as Record<string, unknown>).reason);
          if (!reason || reason.length < 10) {
            violations.push({ file: entry.file, reason: "skip_sub_doc_reason", detail: planId });
          }
        }
      }
    }

    const deps =
      raw.dependencies && typeof raw.dependencies === "object"
        ? (raw.dependencies as Record<string, unknown>)
        : {};
    const generatedArtifactsList = generatedArtifacts(raw);
    const generatedPaths = generatedArtifactsList.map((artifact) => artifact.path);
    for (const artifact of generatedArtifactsList) {
      const expectedType = expectedArtifactTypeForPath(artifact.path);
      if (expectedType && artifact.type !== expectedType) {
        violations.push({
          file: entry.file,
          reason: "artifact_type_mismatch",
          detail: `${artifact.path}: ${artifact.type} != ${expectedType}`,
        });
      }
    }
    if (reverseFullbackNeedsGeneratedBackprop(raw) && !generatedPaths.some(isBackpropArtifact)) {
      violations.push({
        file: entry.file,
        reason: "reverse_fullback_backprop_missing",
        detail: "fullback R4 must generate docs/design, docs/governance, or docs/test-design",
      });
    }
    if (reverseFullbackNeedsGeneratedBackprop(raw)) {
      const missingClaimedArtifacts = claimedBackpropArtifacts(entry.content).filter(
        (path) => !generatedPaths.includes(path),
      );
      if (missingClaimedArtifacts.length > 0) {
        violations.push({
          file: entry.file,
          reason: "reverse_fullback_claimed_artifact_missing",
          detail: missingClaimedArtifacts.join(", "),
        });
      }
      const missingScope = reverseFullbackScopeViolations(raw, generatedPaths);
      if (missingScope.length > 0) {
        violations.push({
          file: entry.file,
          reason: "reverse_fullback_scope_missing",
          detail: missingScope.join(", "),
        });
      }
    }
    if (reverseR4NeedsClaimedArtifactConsistency(raw)) {
      const missingClaimedArtifacts = claimedBackpropArtifacts(entry.content).filter(
        (path) => !generatedPaths.includes(path),
      );
      if (missingClaimedArtifacts.length > 0) {
        violations.push({
          file: entry.file,
          reason: "reverse_r4_claimed_artifact_missing",
          detail: missingClaimedArtifacts.join(", "),
        });
      }
    }
    if (
      reverseR4NeedsRouteBackpropEvidence(raw) &&
      !generatedPaths.some(isBackpropArtifact) &&
      !hasExplicitNoBackpropDecision(raw)
    ) {
      violations.push({
        file: entry.file,
        reason: "reverse_r4_route_backprop_missing",
        detail:
          "R4 route to L1-L6 must generate an upstream artifact or declare backprop_decision=not_required",
      });
    }

    if (isProgressColorProjectionPlan(raw, entry.content, generatedPaths)) {
      const missing = DB_PROJECTION_BACKPROP_REQUIRED_GENERATES.filter(
        (path) => !generatedPaths.includes(path),
      );
      if (!hasReverseBackpropEvidence(generatedPaths, deps)) {
        missing.unshift("docs/plans/PLAN-REVERSE-*.md");
      }
      if (missing.length > 0) {
        violations.push({
          file: entry.file,
          reason: "db_projection_backprop_missing",
          detail: missing.join(", "),
        });
      }
    }

    const parent = stringField(deps.parent);
    if ((kind === "add-design" || kind === "add-impl") && parent) {
      const parentRecord = byRef.get(normalizePlanRef(parent));
      if (!parentRecord) {
        violations.push({ file: entry.file, reason: "parent_missing", detail: parent });
      } else {
        const parentDrive = stringField(parentRecord.raw.drive);
        const drive = stringField(raw.drive);
        if (drive && parentDrive && drive !== parentDrive && parentDrive !== "fullstack") {
          violations.push({
            file: entry.file,
            reason: "parent_drive_mismatch",
            detail: `${drive} != ${parentDrive}`,
          });
        }
      }
    }

    for (const req of stringArray(deps.requires)) {
      if (!isPlanRef(req)) {
        if (!pathExists(repoRoot, req)) {
          violations.push({ file: entry.file, reason: "requires_missing", detail: req });
        }
        continue;
      }
      const required = byRef.get(normalizePlanRef(req));
      if (!required) {
        violations.push({ file: entry.file, reason: "requires_missing", detail: req });
      } else if (!READY_DEPENDENCY_STATUSES.has(stringField(required.raw.status) ?? "")) {
        violations.push({
          file: entry.file,
          reason: "requires_not_ready",
          detail: `${req} status=${stringField(required.raw.status) ?? "-"}`,
        });
      }
    }

    const parentDesign = stringField(raw.parent_design);
    if (
      (kind === "impl" || kind === "add-impl") &&
      parentDesign &&
      !pathExists(repoRoot, parentDesign)
    ) {
      violations.push({ file: entry.file, reason: "parent_design_missing", detail: parentDesign });
    }
  }

  for (const [key, files] of layerSubDoc) {
    if (files.length > 1) {
      for (const file of files)
        violations.push({ file, reason: "duplicate_layer_sub_doc", detail: key });
    }
  }

  return { violations, checked: docs.length, ok: violations.length === 0 };
}

export function planGovernanceMessages(result: PlanGovernanceResult): string[] {
  if (result.violations.length === 0) {
    return [`plan-governance - OK (frontmatter/cross-record checked=${result.checked})`];
  }
  const byReason = new Map<string, number>();
  for (const v of result.violations) byReason.set(v.reason, (byReason.get(v.reason) ?? 0) + 1);
  const summary = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.file}:${v.reason}${v.detail ? `(${v.detail})` : ""}`)
    .join(", ");
  return [
    `plan-governance - violation ${result.violations.length} item(s) across ${result.checked} PLAN(s): ${summary}`,
    `plan-governance - sample: ${sample}`,
  ];
}

export function loadPlanGovernanceDocs(
  repoRoot: string = process.cwd(),
  target?: string,
): PlanGovernanceDoc[] {
  return loadPlanScheduleDocs(repoRoot, target);
}

export function lintPlan(path?: string, repoRoot: string = process.cwd()): LintResult {
  const result = analyzePlanSchedule(loadPlanScheduleDocs(repoRoot, path));
  return { ok: result.ok, messages: planScheduleMessages(result) };
}

export function lintPlanGate(
  gate: string | undefined,
  path?: string,
  repoRoot: string = process.cwd(),
): LintResult {
  if (!gate || gate === "schedule") return lintPlan(path, repoRoot);

  if (gate === "governance" || gate === "frontmatter") {
    const result = analyzePlanGovernance(loadPlanGovernanceDocs(repoRoot, path), repoRoot);
    return { ok: result.ok, messages: planGovernanceMessages(result) };
  }

  if (path) {
    return {
      ok: false,
      messages: [
        `plan-lint - violation: gate ${gate} is repository-level and does not accept path`,
      ],
    };
  }

  if (gate === "G3-trace") {
    try {
      const result = analyzeG3Trace(loadDocs(repoRoot));
      return { ok: g3TraceOk(result), messages: g3TraceMessages(result) };
    } catch (e) {
      return {
        ok: false,
        messages: [`g3-trace - violation: required docs could not be read (${String(e)})`],
      };
    }
  }

  if (gate === "G1-trace") {
    try {
      const result = analyzeG1Trace(loadG1TraceDocs(repoRoot));
      return { ok: g1TraceOk(result), messages: g1TraceMessages(result) };
    } catch (e) {
      return {
        ok: false,
        messages: [`g1-trace - violation: required docs could not be read (${String(e)})`],
      };
    }
  }

  return { ok: false, messages: [`plan-lint - violation: unsupported gate ${gate}`] };
}

export function lintPlanWithGate(
  path?: string,
  repoRoot: string = process.cwd(),
  gate?: string,
): LintResult {
  return lintPlanGate(gate, path, repoRoot);
}
