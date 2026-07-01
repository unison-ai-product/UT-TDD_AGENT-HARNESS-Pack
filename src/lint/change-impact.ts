import { execFileSync } from "node:child_process";
import type { DependencyDriftResult } from "./dependency-drift";

export interface ChangeImpactInput {
  changedFiles: string[];
}

export function changeSetIntegrityMessages(result: ChangeSetIntegrityResult): string[] {
  const summary = result.ok ? "change-set-integrity - OK" : "change-set-integrity - violation";
  return [
    `${summary} (categories=${result.categories.join(",") || "none"}; warnings=${result.warnings.length}; blockers=${result.blockers.length})`,
    ...result.blockers.map(
      (finding) =>
        `change-set-integrity - block ${finding.code}: ${finding.message}${finding.modules ? ` (${finding.modules.join(",")})` : ""}`,
    ),
    ...result.warnings.map(
      (finding) => `change-set-integrity - warn ${finding.code}: ${finding.message}`,
    ),
  ];
}

export interface ChangeImpactResult {
  sourceFiles: string[];
  hasDesignUpdate: boolean;
  hasTestUpdate: boolean;
  missingDesign: boolean;
  missingTest: boolean;
  ok: boolean;
}

export type ChangeSetCategory = "source" | "design" | "test";

export type ChangeSetIntegrityFindingCode =
  | "incomplete-artifact-set"
  | "singleton-artifact-set"
  | "dependent-regression-untouched";

export interface ChangeSetIntegrityFinding {
  code: ChangeSetIntegrityFindingCode;
  severity: "warn" | "error";
  message: string;
  files?: string[];
  modules?: string[];
}

export interface ChangeSetIntegrityInput {
  changedFiles: string[];
  dependencyDrift?: DependencyDriftResult | null;
}

export interface ChangeSetIntegrityResult {
  changedFiles: string[];
  sourceFiles: string[];
  designFiles: string[];
  testFiles: string[];
  categories: ChangeSetCategory[];
  warnings: ChangeSetIntegrityFinding[];
  blockers: ChangeSetIntegrityFinding[];
  ok: boolean;
}

function norm(path: string): string {
  return path.replaceAll("\\", "/").trim();
}

function isTransientHarnessDbFile(path: string): boolean {
  return /^\.ut-tdd\/harness\.db-(journal|shm|wal)$/.test(norm(path));
}

function isSource(path: string): boolean {
  return /^src\/.+\.(ts|tsx)$/.test(path);
}

function isDesignUpdate(path: string): boolean {
  return /^docs\/design\/harness\/.+\.md$/.test(path) || /^docs\/plans\/PLAN-.+\.md$/.test(path);
}

function isTestUpdate(path: string): boolean {
  return /^tests\/.+\.test\.ts$/.test(path) || /^docs\/test-design\/harness\/.+\.md$/.test(path);
}

function sourceModule(path: string): string | null {
  const parts = norm(path).split("/");
  if (parts[0] !== "src" || parts.length < 2) return null;
  const first = parts[1];
  if (first.endsWith(".ts") || first.endsWith(".tsx")) return first.replace(/\.(ts|tsx)$/, "");
  return first;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function analyzeChangeImpact(input: ChangeImpactInput): ChangeImpactResult {
  const changedFiles = input.changedFiles.map(norm);
  const sourceFiles = changedFiles.filter(isSource).sort();
  const hasDesignUpdate = changedFiles.some(isDesignUpdate);
  const hasTestUpdate = changedFiles.some(isTestUpdate);
  const missingDesign = sourceFiles.length > 0 && !hasDesignUpdate;
  const missingTest = sourceFiles.length > 0 && !hasTestUpdate;
  return {
    sourceFiles,
    hasDesignUpdate,
    hasTestUpdate,
    missingDesign,
    missingTest,
    ok: !missingDesign && !missingTest,
  };
}

export function analyzeChangeSetIntegrity(
  input: ChangeSetIntegrityInput,
): ChangeSetIntegrityResult {
  const changedFiles = uniqueSorted(input.changedFiles.map(norm).filter(Boolean));
  const sourceFiles = changedFiles.filter(isSource);
  const designFiles = changedFiles.filter(isDesignUpdate);
  const testFiles = changedFiles.filter(isTestUpdate);
  const categories: ChangeSetCategory[] = [
    sourceFiles.length > 0 ? "source" : null,
    designFiles.length > 0 ? "design" : null,
    testFiles.length > 0 ? "test" : null,
  ].filter((category): category is ChangeSetCategory => category != null);
  const warnings: ChangeSetIntegrityFinding[] = [];
  const blockers: ChangeSetIntegrityFinding[] = [];

  if (categories.length === 1) {
    const category = categories[0];
    warnings.push({
      code: "singleton-artifact-set",
      severity: "warn",
      message: `${category} changed without its counterpart artifacts`,
      files: category === "source" ? sourceFiles : category === "design" ? designFiles : testFiles,
    });
  }

  if (categories.length > 0 && categories.length < 3) {
    const missing = (["source", "design", "test"] as const).filter(
      (category) => !categories.includes(category),
    );
    warnings.push({
      code: "incomplete-artifact-set",
      severity: "warn",
      message: `change set is missing ${missing.join(" + ")}`,
      files: changedFiles,
    });
  }

  if (sourceFiles.length > 0 && (designFiles.length === 0 || testFiles.length === 0)) {
    const missing = [
      designFiles.length === 0 ? "design/plan" : null,
      testFiles.length === 0 ? "test/test-design" : null,
    ]
      .filter(Boolean)
      .join(" + ");
    warnings.push({
      code: "incomplete-artifact-set",
      severity: "warn",
      message: `source changes are missing ${missing}`,
      files: sourceFiles,
    });
  }

  const drift = input.dependencyDrift;
  if (drift != null && sourceFiles.length > 0) {
    const changedModules = uniqueSorted(
      sourceFiles.map(sourceModule).filter((module): module is string => module != null),
    );
    const dependentModules = uniqueSorted(
      drift.moduleEdges
        .filter((edge) => changedModules.includes(edge.to) && !changedModules.includes(edge.from))
        .map((edge) => edge.from),
    );
    if (dependentModules.length > 0) {
      const expectedRegressionTests = new Set(
        drift.testCoverage
          .filter((edge) => changedModules.includes(edge.to) || dependentModules.includes(edge.to))
          .map((edge) => norm(edge.from)),
      );
      const touchedRegressionTests = testFiles.filter((file) => expectedRegressionTests.has(file));
      if (touchedRegressionTests.length === 0) {
        blockers.push({
          code: "dependent-regression-untouched",
          severity: "error",
          message:
            "source changes affect dependent modules but no mapped regression test was touched",
          files: sourceFiles,
          modules: dependentModules,
        });
      }
    }
  }

  return {
    changedFiles,
    sourceFiles,
    designFiles,
    testFiles,
    categories,
    warnings,
    blockers,
    ok: blockers.length === 0,
  };
}

export function parseGitPorcelain(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3);
      const renamed = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
      return norm(renamed ?? rawPath);
    })
    .filter((path) => !isTransientHarnessDbFile(path));
}

export function loadChangedFiles(repoRoot: string = process.cwd()): string[] {
  const output = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parseGitPorcelain(output);
}

/** `git diff --cached --name-only` の出力をパース (1 行 1 path、staged 集合)。 */
export function parseStagedNames(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => norm(line));
}

/** commit にステージ済みのファイル一覧 (commit 前 staged-diff 確認の機械化、IMP-137)。 */
export function loadStagedFiles(repoRoot: string = process.cwd()): string[] {
  const output = execFileSync("git", ["-C", repoRoot, "diff", "--cached", "--name-only"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parseStagedNames(output);
}

/**
 * repoRoot が git work-tree かを判定する。ZIP 展開のみ (非 git) の利用環境では change-impact
 * は「適用不能」なので fail-close でなく skip させるための前段ガード (tracked-canonical /
 * runtime-portability が既に採る非 git fail-open 慣行に揃える)。git は在るが status が壊れる等の
 * 実エラーは引き続き呼び出し側で fail-close する。
 */
export function isGitRepository(repoRoot: string = process.cwd()): boolean {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export function changeImpactMessages(result: ChangeImpactResult): string[] {
  if (result.sourceFiles.length === 0) {
    return ["change-impact — OK (src changes なし)"];
  }
  if (result.ok) {
    return [
      `change-impact — OK (src changes ${result.sourceFiles.length}件に design + test/test-design 更新あり)`,
    ];
  }
  const missing = [
    result.missingDesign ? "design" : null,
    result.missingTest ? "test/test-design" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  return [
    `change-impact — ⚠ src changes ${result.sourceFiles.length}件に対する ${missing} 更新なし (${result.sourceFiles.join(", ")})`,
  ];
}
