import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { importedSourceModule, normalizePath, sourceModule } from "./shared";

export type DependencyDriftFindingCode =
  | "disallowed-module-dependency"
  | "runtime-roster-boundary"
  | "module-cycle"
  | "missing-regression-test";

export interface DependencyDoc {
  path: string;
  text: string;
}

export interface ModuleEdge {
  from: string;
  to: string;
}

export interface DependencyDriftFinding {
  code: DependencyDriftFindingCode;
  severity: "error" | "warn";
  message: string;
  path?: string;
  fromModule?: string;
  toModule?: string;
  fromPath?: string;
  toPath?: string;
  cycle?: string[];
  module?: string;
}

export interface DependencyDriftInput {
  sourceDocs: DependencyDoc[];
  testDocs: DependencyDoc[];
  allowed?: Record<string, string[]>;
}

export interface DependencyDriftResult {
  ok: boolean;
  sourceDocs: DependencyDoc[];
  testDocs: DependencyDoc[];
  moduleEdges: ModuleEdge[];
  fileEdges: ModuleEdge[];
  sourceFileEdges: ModuleEdge[];
  testCoverage: ModuleEdge[];
  findings: DependencyDriftFinding[];
}

export interface RegressionExpansionResult {
  ok: boolean;
  changedModules: string[];
  affectedModules: string[];
  testPaths: string[];
  findings: DependencyDriftFinding[];
}

const DEFAULT_DISALLOWED: Record<string, Set<string>> = {
  lint: new Set([
    "cli",
    "doctor",
    "gate",
    "handover",
    "plan",
    "runtime",
    "setup",
    "team",
    "vmodel",
  ]),
  runtime: new Set(["cli", "doctor", "handover", "lint", "plan", "setup", "team", "vmodel"]),
  schema: new Set([
    "cli",
    "doctor",
    "export",
    "gate",
    "handover",
    "lint",
    "plan",
    "runtime",
    "setup",
    "team",
    "vmodel",
  ]),
};

function collectTsDocs(repoRoot: string, relDir: "src" | "tests"): DependencyDoc[] {
  const root = join(repoRoot, relDir);
  if (!existsSync(root)) return [];
  const docs: DependencyDoc[] = [];
  const visit = (absDir: string, relPrefix: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name);
      const relPath = normalizePath(join(relPrefix, entry.name));
      if (entry.isDirectory()) {
        visit(absPath, relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      docs.push({ path: relPath, text: readFileSync(absPath, "utf8") });
    }
  };
  visit(root, relDir);
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadDependencyDriftInput(repoRoot: string = process.cwd()): DependencyDriftInput {
  return {
    sourceDocs: collectTsDocs(repoRoot, "src"),
    testDocs: collectTsDocs(repoRoot, "tests"),
  };
}

function importSpecifiers(doc: DependencyDoc): string[] {
  const source = ts.createSourceFile(doc.path, doc.text, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier != null &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

function smokeCoveredModules(doc: DependencyDoc): string[] {
  const modules: string[] = [];
  if (/["']src["']\s*,\s*["']cli\.ts["']/.test(doc.text) || /src[/\\]cli\.ts/.test(doc.text)) {
    modules.push("cli");
  }
  return modules;
}

function resolveImportedModule(fromPath: string, specifier: string): string | null {
  const direct = importedSourceModule(fromPath, specifier);
  if (direct != null) return direct;
  if (!specifier.startsWith(".")) return null;
  const fromParts = normalizePath(fromPath).split("/");
  const resolvedParts: string[] = [];
  for (const part of [...fromParts.slice(0, -1), ...specifier.split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolvedParts.pop();
      continue;
    }
    resolvedParts.push(part);
  }
  return sourceModule(resolvedParts.join("/"));
}

function resolveImportedSourcePath(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = normalizePath(join(dirname(fromPath), specifier));
  if (resolved.endsWith(".ts")) return resolved;
  return `${resolved}.ts`;
}

function isRosterBoundary(path: string): boolean {
  return normalizePath(path) === "src/runtime/agent-slots-roster.ts";
}

function isAgentSlotsBoundary(path: string): boolean {
  return normalizePath(path) === "src/runtime/agent-slots.ts";
}

function isGuardBoundary(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized === "src/runtime/agent-guard.ts" ||
    normalized === "src/runtime/agent-guard-policy.ts"
  );
}

function isRuntimeSource(path: string): boolean {
  return normalizePath(path).startsWith("src/runtime/");
}

function runtimeRosterBoundaryViolation(fromPath: string, toPath: string): string | null {
  const from = normalizePath(fromPath);
  const to = normalizePath(toPath);
  if (isRosterBoundary(from) && isRuntimeSource(to) && !isRosterBoundary(to)) {
    return "roster must not import runtime or guard modules";
  }
  if (isGuardBoundary(from) && isRosterBoundary(to)) {
    return "agent guard must not import roster directly";
  }
  if (isRuntimeSource(from) && isRosterBoundary(to) && !isAgentSlotsBoundary(from)) {
    return "only agent-slots may import the roster boundary";
  }
  return null;
}

function uniqueSortedEdges(edges: ModuleEdge[]): ModuleEdge[] {
  const seen = new Map<string, ModuleEdge>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    seen.set(`${edge.from}->${edge.to}`, edge);
  }
  return [...seen.values()].sort((a, b) =>
    `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`),
  );
}

function detectCycles(edges: ModuleEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const { from, to } of edges) {
    adj.set(from, [...(adj.get(from) ?? []), to].sort());
  }
  const cycles = new Map<string, string[]>();
  const visit = (node: string, stack: string[]): void => {
    const at = stack.indexOf(node);
    if (at >= 0) {
      const cycle = [...stack.slice(at), node];
      const body = cycle.slice(0, -1);
      const min = [...body].sort()[0];
      const minIndex = body.indexOf(min);
      const rotated = [...body.slice(minIndex), ...body.slice(0, minIndex), min];
      cycles.set([...body].sort().join("|"), rotated);
      return;
    }
    for (const next of adj.get(node) ?? []) visit(next, [...stack, node]);
  };
  for (const node of [...adj.keys()].sort()) visit(node, []);
  return [...cycles.values()].sort((a, b) => a.join(">").localeCompare(b.join(">")));
}

function disallowed(from: string, to: string, allowed?: Record<string, string[]>): boolean {
  if (allowed != null) {
    return !(allowed[from] ?? []).includes(to);
  }
  return DEFAULT_DISALLOWED[from]?.has(to) ?? false;
}

export function analyzeDependencyDrift(input: DependencyDriftInput): DependencyDriftResult {
  const fileEdges: ModuleEdge[] = [];
  const sourceFileEdges: ModuleEdge[] = [];
  const moduleEdges: ModuleEdge[] = [];
  const testCoverage: ModuleEdge[] = [];
  const findings: DependencyDriftFinding[] = [];

  for (const doc of input.sourceDocs) {
    const from = sourceModule(doc.path);
    if (from == null) continue;
    for (const spec of importSpecifiers(doc)) {
      const to = resolveImportedModule(doc.path, spec);
      if (to == null) continue;
      fileEdges.push({ from: doc.path, to: `${to}:${spec}` });
      moduleEdges.push({ from, to });
      const toPath = resolveImportedSourcePath(doc.path, spec);
      if (toPath != null) {
        sourceFileEdges.push({ from: doc.path, to: toPath });
        const boundaryViolation = runtimeRosterBoundaryViolation(doc.path, toPath);
        if (boundaryViolation != null) {
          findings.push({
            code: "runtime-roster-boundary",
            severity: "error",
            path: doc.path,
            fromPath: doc.path,
            toPath,
            message: boundaryViolation,
          });
        }
      }
      if (from !== to && disallowed(from, to, input.allowed)) {
        findings.push({
          code: "disallowed-module-dependency",
          severity: "error",
          path: doc.path,
          fromModule: from,
          toModule: to,
          message: `${from} must not depend on ${to}`,
        });
      }
    }
  }

  const stableModuleEdges = uniqueSortedEdges(moduleEdges);
  for (const cycle of detectCycles(stableModuleEdges)) {
    findings.push({
      code: "module-cycle",
      severity: "error",
      cycle,
      message: `module cycle: ${cycle.join(" -> ")}`,
    });
  }

  for (const doc of input.testDocs) {
    for (const spec of importSpecifiers(doc)) {
      const target = resolveImportedModule(doc.path, spec);
      if (target != null) testCoverage.push({ from: doc.path, to: target });
    }
    for (const target of smokeCoveredModules(doc)) {
      testCoverage.push({ from: doc.path, to: target });
    }
  }

  return {
    ok: !findings.some((f) => f.severity === "error"),
    sourceDocs: input.sourceDocs,
    testDocs: input.testDocs,
    moduleEdges: stableModuleEdges,
    fileEdges: uniqueSortedEdges(fileEdges),
    sourceFileEdges: uniqueSortedEdges(sourceFileEdges),
    testCoverage: uniqueSortedEdges(testCoverage),
    findings: findings.sort((a, b) =>
      (a.message + (a.path ?? "")).localeCompare(b.message + (b.path ?? "")),
    ),
  };
}

export function dependencyDriftMessages(result: DependencyDriftResult): string[] {
  if (result.ok) {
    return [
      `dependency-drift — OK (modules ${result.moduleEdges.length} edges, tests ${result.testCoverage.length} coverage edges, cycles 0)`,
    ];
  }
  return [
    `dependency-drift — ⚠ ${result.findings.length} 件`,
    ...result.findings.slice(0, 5).map((f) => `dependency-drift — ${f.code}: ${f.message}`),
  ];
}

export function expandRegressionScope(
  drift: DependencyDriftResult,
  changedPaths: string[],
): RegressionExpansionResult {
  const changedModules = [
    ...new Set(changedPaths.map(sourceModule).filter((m): m is string => m != null)),
  ].sort();
  const affected = new Set(changedModules);
  const blockedEdges = new Set(
    drift.findings
      .filter(
        (finding) =>
          finding.code === "disallowed-module-dependency" &&
          finding.fromModule != null &&
          finding.toModule != null,
      )
      .map((finding) => `${finding.fromModule}->${finding.toModule}`),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of drift.moduleEdges) {
      if (blockedEdges.has(`${edge.from}->${edge.to}`)) continue;
      if (affected.has(edge.to) && !affected.has(edge.from)) {
        affected.add(edge.from);
        grew = true;
      }
    }
  }
  const affectedModules = [...affected].sort();
  const testPaths = drift.testCoverage
    .filter((edge) => affected.has(edge.to))
    .map((edge) => edge.from)
    .sort();
  const findings: DependencyDriftFinding[] = [];
  for (const module of changedModules) {
    if (!drift.testCoverage.some((edge) => edge.to === module)) {
      findings.push({
        code: "missing-regression-test",
        severity: "warn",
        module,
        message: `${module} has no direct regression test import`,
      });
    }
  }
  return {
    ok: findings.length === 0,
    changedModules,
    affectedModules,
    testPaths,
    findings,
  };
}

export function regressionExpansionMessages(result: RegressionExpansionResult): string[] {
  if (result.changedModules.length === 0) {
    return ["regression-expansion — OK (src change 0、追加 scope なし)"];
  }
  if (result.ok) {
    return [
      `regression-expansion — OK (changed=${result.changedModules.join(",")}; affected=${result.affectedModules.join(",")}; tests=${result.testPaths.length})`,
    ];
  }
  return [
    `regression-expansion — ⚠ ${result.findings.length} 件 (changed=${result.changedModules.join(",")}; affected=${result.affectedModules.join(",")}; tests=${result.testPaths.length})`,
    ...result.findings.map((f) => `regression-expansion — ${f.code}: ${f.message}`),
  ];
}
