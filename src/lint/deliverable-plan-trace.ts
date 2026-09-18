import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  analyzeArtifactOwnership,
  type DuplicateArtifactOwnershipFinding,
} from "./artifact-ownership.ts";
import { normalizePath } from "./shared.ts";

export interface DeliverablePlanTraceFinding {
  kind: "orphan-deliverable" | "stale-deliverable-trace-debt";
  artifactPath: string;
}

export type DeliverableTraceFinding =
  | DeliverablePlanTraceFinding
  | DuplicateArtifactOwnershipFinding;

export interface DeliverablePlanTraceResult {
  findings: DeliverableTraceFinding[];
  ok: boolean;
}

export function analyzeDeliverablePlanTrace(input: {
  artifactFiles: readonly string[];
  tracedPaths: ReadonlySet<string>;
  baseline: ReadonlyMap<string, string>;
}): DeliverablePlanTraceResult {
  const untraced = input.artifactFiles.filter((path) => !input.tracedPaths.has(path)).sort();
  const findings: DeliverablePlanTraceFinding[] = [
    ...untraced
      .filter((path) => !input.baseline.has(path))
      .map((artifactPath) => ({ kind: "orphan-deliverable" as const, artifactPath })),
    ...[...input.baseline.keys()]
      .filter((path) => !untraced.includes(path))
      .sort()
      .map((artifactPath) => ({ kind: "stale-deliverable-trace-debt" as const, artifactPath })),
  ];
  return { findings, ok: findings.length === 0 };
}

export interface DeliverablePlanTraceInput {
  artifactFiles: string[];
  tracedPaths: Set<string>;
  ownersByPath: Map<string, string[]>;
  baseline: Map<string, string>;
  ownershipBaseline: Set<string>;
}

/**
 * Runtime-local Claude state is intentionally gitignored and cannot be a PLAN
 * deliverable. Keep it outside this repository-deliverable gate so a clean CI
 * snapshot and a developer worktree observe the same artifact set.
 */
export function isDeliverableArtifactPath(path: string): boolean {
  if (
    path === ".claude/settings.local.json" ||
    path === ".claude/scheduled_tasks.lock" ||
    path.startsWith(".claude/agent-memory/")
  ) {
    return false;
  }
  return (
    path.startsWith("scripts/") ||
    path.startsWith(".claude/") ||
    /\/tests\/.*\.test\.ts$/.test(`/${path}`)
  );
}

function listFiles(dir: string, repoRoot: string, output: string[]): void {
  if (!statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, repoRoot, output);
    else output.push(normalizePath(path.slice(repoRoot.length + 1)));
  }
}

function frontmatter(content: string): Record<string, unknown> {
  const end = content.indexOf("\n---", 3);
  if (!content.startsWith("---") || end < 0) return {};
  const parsed = parseYaml(content.slice(3, end));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function loadLedger(content: string): {
  baseline: Map<string, string>;
  ownershipBaseline: Set<string>;
} {
  const rows = content.split(/\r?\n/).filter((line) => line.startsWith("| `"));
  const baseline = new Map<string, string>();
  const ownershipBaseline = new Set<string>();
  for (const row of rows) {
    const columns = row.split("|").map((column) => column.trim());
    const artifactPath = columns[1]?.replaceAll("`", "");
    const legacyRow = columns.length === 6;
    const debtKind = legacyRow ? "orphan-deliverable" : columns[2];
    const ownerPlan = (legacyRow ? columns[2] : columns[3])?.replaceAll("`", "");
    const justification = legacyRow ? columns[3] : columns[4];
    const promoteBy = legacyRow ? columns[4] : columns[5];
    if (!artifactPath || !ownerPlan || !justification || !promoteBy) {
      throw new Error("invalid deliverable trace debt ledger row");
    }
    const normalized = normalizePath(artifactPath);
    if (debtKind === "orphan-deliverable") baseline.set(normalized, ownerPlan);
    else if (debtKind === "duplicate-artifact-ownership") ownershipBaseline.add(normalized);
    else throw new Error("invalid deliverable trace debt ledger kind");
  }
  return { baseline, ownershipBaseline };
}

export function loadDeliverablePlanTraceInput(repoRoot: string): DeliverablePlanTraceInput {
  const artifactFiles: string[] = [];
  for (const root of ["scripts", ".claude", "tests"]) {
    const path = join(repoRoot, root);
    try {
      if (statSync(path).isDirectory()) listFiles(path, repoRoot, artifactFiles);
    } catch {
      // Optional roots are an empty set in consumer repositories.
    }
  }
  const scopedArtifacts = artifactFiles.filter(isDeliverableArtifactPath);
  const tracedPaths = new Set<string>();
  const ownersByPath = new Map<string, string[]>();
  for (const file of readdirSync(join(repoRoot, "docs", "plans")).filter((name) =>
    name.endsWith(".md"),
  )) {
    const meta = frontmatter(readFileSync(join(repoRoot, "docs", "plans", file), "utf8"));
    const planId = typeof meta.plan_id === "string" ? meta.plan_id : "";
    const generates = Array.isArray(meta.generates) ? meta.generates : [];
    for (const item of generates) {
      if (!item || typeof item !== "object") continue;
      const artifactPath = (item as Record<string, unknown>).artifact_path;
      if (typeof artifactPath !== "string" || !artifactPath) continue;
      const normalized = normalizePath(artifactPath);
      tracedPaths.add(normalized);
      if (planId) ownersByPath.set(normalized, [...(ownersByPath.get(normalized) ?? []), planId]);
    }
  }
  const ledger = loadLedger(
    readFileSync(join(repoRoot, "docs", "governance", "deliverable-trace-debt-audit.md"), "utf8"),
  );
  return {
    artifactFiles: scopedArtifacts.sort(),
    tracedPaths,
    ownersByPath,
    baseline: new Map([...ledger.baseline].filter(([path]) => isDeliverableArtifactPath(path))),
    ownershipBaseline: ledger.ownershipBaseline,
  };
}

export function analyzeDeliverableTraceGate(
  input: DeliverablePlanTraceInput,
): DeliverablePlanTraceResult {
  const trace = analyzeDeliverablePlanTrace(input);
  const ownership = analyzeArtifactOwnership({
    ownersByPath: input.ownersByPath,
    baseline: input.ownershipBaseline,
  });
  const duplicatePaths = new Set(
    [...input.ownersByPath]
      .filter(([, planIds]) => planIds.length > 1)
      .map(([artifactPath]) => artifactPath),
  );
  const staleOwnership = [...input.ownershipBaseline]
    .filter((artifactPath) => !duplicatePaths.has(artifactPath))
    .map((artifactPath) => ({ kind: "stale-deliverable-trace-debt" as const, artifactPath }));
  const findings = [...ownership.findings, ...trace.findings, ...staleOwnership].sort((a, b) =>
    a.artifactPath.localeCompare(b.artifactPath),
  );
  return { findings, ok: findings.length === 0 };
}

export function deliverablePlanTraceMessages(result: DeliverablePlanTraceResult): string[] {
  if (result.ok) return ["deliverable-plan-trace — OK (W2/W3/W4 finding 0; ledger 双方向一致)"];
  return result.findings.map(
    (finding) => `deliverable-plan-trace - violation: ${finding.kind} ${finding.artifactPath}`,
  );
}
