import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./shared";

export interface RuntimePortabilityDoc {
  path: string;
  text: string;
}

export interface RuntimePortabilityViolation {
  path: string;
  line: number;
  rule: string;
  message: string;
}

export interface RuntimePortabilityResult {
  checked: number;
  violations: RuntimePortabilityViolation[];
  ok: boolean;
}

const ALLOWED_SCRIPT_WRAPPERS = new Set(["scripts/ut-tdd", "scripts/ut-tdd.ps1"]);
const CORE_FILE_PATTERN = /\.(?:ts|gitkeep)$/;
const HOOK_FILE_PATTERN = /\.ts$/;
const DISALLOWED_RUNTIME_FILE_PATTERN = /\.(?:py|sh|bash|js|mjs|cjs)$/;
const LOCAL_ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/|~\/ai-dev-kit-vscode)/;
const SHELL_RUNTIME_PATTERN =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`](?:bash|sh|python|python3|powershell|pwsh|cmd(?:\.exe)?)(?:["'`]|\s)/;
const LEGACY_RUNTIME_NAME = ["he", "lix"].join("");
const LEGACY_ENV_PREFIX = ["HE", "LIX_"].join("");
const LEGACY_RUNTIME_MARKER_PATTERN = new RegExp(
  [
    `${LEGACY_ENV_PREFIX}[A-Z0-9_]*`,
    String.raw`\b${LEGACY_RUNTIME_NAME}\s+(?:codex|claude|plan|gate|handover)\b`,
    String.raw`\.${LEGACY_RUNTIME_NAME}(?:[\\/]|$)`,
    `pmo-${LEGACY_RUNTIME_NAME}-`,
  ].join("|"),
  "i",
);

function lineOf(text: string, pattern: RegExp): number {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return 1;
}

function jsonDoc<T>(doc: RuntimePortabilityDoc | undefined): T | null {
  if (!doc) return null;
  try {
    return JSON.parse(doc.text) as T;
  } catch {
    return null;
  }
}

function packageViolations(doc: RuntimePortabilityDoc | undefined): RuntimePortabilityViolation[] {
  const pkg = jsonDoc<{
    bin?: string | Record<string, string>;
    type?: string;
    engines?: { bun?: string; node?: string };
    scripts?: Record<string, string>;
  }>(doc);
  const path = doc?.path ?? "package.json";
  if (!pkg) {
    return [
      {
        path,
        line: 1,
        rule: "package-json-invalid",
        message: "package.json must be readable JSON for runtime portability checks.",
      },
    ];
  }
  const violations: RuntimePortabilityViolation[] = [];
  if (pkg.type !== "module") {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-esm",
      message: "TypeScript runtime package must use ESM module semantics.",
    });
  }
  if (!pkg.engines?.bun) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-bun-engine",
      message: "ADR-001 runtime contract must declare the Bun engine.",
    });
  }
  if (!/\bbun\s+build\b.*--compile\b/.test(pkg.scripts?.build ?? "")) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-compiled-build",
      message: "Build script must produce the compiled cross-platform core binary.",
    });
  }
  const binPath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["ut-tdd"];
  if (binPath !== "./src/cli.ts") {
    violations.push({
      path,
      line: 1,
      rule: "package-bin-not-source-cli",
      message:
        "Package bin.ut-tdd must point at ./src/cli.ts so bun link exposes the CLI before a local dist build.",
    });
  }
  if (!/\btsc\s+--noEmit\b/.test(pkg.scripts?.typecheck ?? "")) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-typecheck",
      message: "TypeScript strictness must be enforced by tsc --noEmit.",
    });
  }
  if (!/\bvitest\s+run\b/.test(pkg.scripts?.test ?? "")) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-vitest-full-suite",
      message: "Full test suite must use the Vitest runner through a named package script.",
    });
  }
  if (
    !/\bvitest\s+run\b/.test(pkg.scripts?.["test:fast"] ?? "") ||
    !pkg.scripts?.["test:fast"]?.includes("--exclude tests/projection-writer.test.ts") ||
    !pkg.scripts?.["test:fast"]?.includes("--exclude tests/cli-surface.test.ts")
  ) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-fast-test-lane",
      message:
        "Fast local verification must have a named Vitest script excluding heavy DB/CLI lanes.",
    });
  }
  if (
    !/\bdb\s+rebuild\b/.test(pkg.scripts?.["test:db"] ?? "") ||
    !/\bvitest\s+run\b/.test(pkg.scripts?.["test:db"] ?? "") ||
    !pkg.scripts?.["test:db"]?.includes("tests/db-projection-ingestion.test.ts") ||
    !pkg.scripts?.["test:db"]?.includes("tests/drive-db-registration.test.ts") ||
    !pkg.scripts?.["test:db"]?.includes("tests/projection-writer.test.ts")
  ) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-db-test-lane",
      message: "DB projection verification must have a named Vitest lane.",
    });
  }
  if (
    !/\bvitest\s+run\b/.test(pkg.scripts?.["test:cli"] ?? "") ||
    !pkg.scripts?.["test:cli"]?.includes("tests/cli-surface.test.ts") ||
    !pkg.scripts?.["test:cli"]?.includes("tests/runtime-hook-entrypoints.test.ts")
  ) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-cli-test-lane",
      message: "CLI/runtime verification must have a named Vitest lane.",
    });
  }
  if (
    !/\bvitest\s+run\b/.test(pkg.scripts?.["test:node-fallback"] ?? "") ||
    !pkg.scripts?.["test:node-fallback"]?.includes("tests/state-db.test.ts") ||
    !pkg.scripts?.["test:node-fallback"]?.includes("tests/runtime-portability.test.ts")
  ) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-node-fallback-smoke",
      message: "Node fallback behavior must have a named smoke test script.",
    });
  }
  return violations;
}

function tsconfigViolations(doc: RuntimePortabilityDoc | undefined): RuntimePortabilityViolation[] {
  const tsconfig = jsonDoc<{ compilerOptions?: { strict?: boolean; types?: string[] } }>(doc);
  const path = doc?.path ?? "tsconfig.json";
  if (!tsconfig) {
    return [
      {
        path,
        line: 1,
        rule: "tsconfig-invalid",
        message: "tsconfig.json must be readable JSON for runtime portability checks.",
      },
    ];
  }
  const violations: RuntimePortabilityViolation[] = [];
  if (tsconfig.compilerOptions?.strict !== true) {
    violations.push({
      path,
      line: 1,
      rule: "tsconfig-not-strict",
      message: "TypeScript must remain strict.",
    });
  }
  if (!tsconfig.compilerOptions?.types?.includes("node")) {
    violations.push({
      path,
      line: 1,
      rule: "tsconfig-missing-node-types",
      message: "Node standard-library types must remain explicit for cross-platform TS code.",
    });
  }
  return violations;
}

function scriptNonCommentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function analyzeRuntimeDoc(doc: RuntimePortabilityDoc): RuntimePortabilityViolation[] {
  const path = normalizePath(doc.path);
  const violations: RuntimePortabilityViolation[] = [];
  if (path.startsWith("src/") && !CORE_FILE_PATTERN.test(path)) {
    violations.push({
      path,
      line: 1,
      rule: "core-non-typescript-file",
      message: "Runtime core must stay TypeScript; non-TS files belong outside src/.",
    });
  }
  if (path.startsWith(".claude/hooks/") && !HOOK_FILE_PATTERN.test(path)) {
    violations.push({
      path,
      line: 1,
      rule: "hook-non-typescript-file",
      message: "Claude hook runtime code must stay TypeScript.",
    });
  }
  if (
    (path.startsWith("src/") || path.startsWith(".claude/hooks/")) &&
    DISALLOWED_RUNTIME_FILE_PATTERN.test(path)
  ) {
    violations.push({
      path,
      line: 1,
      rule: "disallowed-runtime-language",
      message: "Python/Bash/JS runtime files are not allowed in current core surfaces.",
    });
  }
  if (path.startsWith("scripts/") && !ALLOWED_SCRIPT_WRAPPERS.has(path)) {
    violations.push({
      path,
      line: 1,
      rule: "script-wrapper-unapproved",
      message: "Only the thin ut-tdd POSIX/PowerShell wrappers are allowed under scripts/.",
    });
  }
  if (ALLOWED_SCRIPT_WRAPPERS.has(path)) {
    const lines = scriptNonCommentLines(doc.text);
    if (
      lines.length > 12 ||
      !/src[\\/]cli\.ts/.test(doc.text) ||
      !/dist[\\/]+ut-tdd/.test(doc.text)
    ) {
      violations.push({
        path,
        line: 1,
        rule: "script-wrapper-not-thin",
        message: "Script wrappers must only dispatch to dist/ut-tdd or src/cli.ts.",
      });
    }
    if (/\bpython(?:3)?\b/.test(doc.text)) {
      violations.push({
        path,
        line: lineOf(doc.text, /\bpython(?:3)?\b/),
        rule: "script-wrapper-python",
        message: "Script wrappers must not reintroduce Python runtime dispatch.",
      });
    }
  }
  if (
    path.startsWith("src/") &&
    SHELL_RUNTIME_PATTERN.test(doc.text) &&
    !path.startsWith("src/runtime/")
  ) {
    violations.push({
      path,
      line: lineOf(doc.text, SHELL_RUNTIME_PATTERN),
      rule: "source-shell-runtime",
      message: "Source modules must not dispatch through shell-specific runtimes.",
    });
  }
  if (LOCAL_ABSOLUTE_PATH_PATTERN.test(doc.text)) {
    violations.push({
      path,
      line: lineOf(doc.text, LOCAL_ABSOLUTE_PATH_PATTERN),
      rule: "local-absolute-path",
      message: "Current runtime surfaces must not embed user-local absolute paths.",
    });
  }
  if (
    (path.startsWith("src/") || path.startsWith(".claude/hooks/") || path.startsWith("scripts/")) &&
    LEGACY_RUNTIME_MARKER_PATTERN.test(doc.text)
  ) {
    violations.push({
      path,
      line: lineOf(doc.text, LEGACY_RUNTIME_MARKER_PATTERN),
      rule: "legacy-runtime-marker",
      message:
        "Current runtime surfaces must not reintroduce legacy runtime env, state, command, or agent markers.",
    });
  }
  return violations;
}

function sqliteFallbackViolations(docs: RuntimePortabilityDoc[]): RuntimePortabilityViolation[] {
  const stateDb = docs.find((doc) => normalizePath(doc.path) === "src/state-db/index.ts");
  if (!stateDb) return [];
  if (stateDb.text.includes("bun:sqlite") && stateDb.text.includes("node:sqlite")) return [];
  return [
    {
      path: stateDb.path,
      line: 1,
      rule: "sqlite-driver-fallback-missing",
      message: "SQLite adapter must keep both bun:sqlite and node:sqlite drivers visible.",
    },
  ];
}

export function analyzeRuntimePortability(docs: RuntimePortabilityDoc[]): RuntimePortabilityResult {
  const byPath = new Map(docs.map((doc) => [normalizePath(doc.path), doc]));
  const violations = [
    ...packageViolations(byPath.get("package.json")),
    ...tsconfigViolations(byPath.get("tsconfig.json")),
    ...docs.flatMap(analyzeRuntimeDoc),
    ...sqliteFallbackViolations(docs),
  ];
  return { checked: docs.length, violations, ok: violations.length === 0 };
}

/**
 * git が無い環境 (zip / tarball 配布、`.git` 不在) 用の filesystem fallback。
 * git ls-files と同じ走査面 (root の3ファイル + src/.claude/hooks/scripts 配下) を列挙する。
 * 既知 prefix のみ降下するので node_modules / dist / .git を走査しない。
 */
function walkRuntimeFiles(repoRoot: string): string[] {
  const acc: string[] = ["package.json", "tsconfig.json", "bun.lock"];
  const descend = (rel: string): void => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) descend(childRel);
      else acc.push(childRel);
    }
  };
  for (const prefix of ["src", ".claude/hooks", "scripts"]) descend(prefix);
  return acc;
}

export function loadRuntimePortabilityDocs(
  repoRoot: string = process.cwd(),
): RuntimePortabilityDoc[] {
  let files: string[] = [];
  try {
    files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // git 不在/失敗時は filesystem を直接走査する (検査面を package.json/tsconfig.json だけに
    // 縮退させない = 配布物でも src/scripts/hooks を被覆する)。
    files = walkRuntimeFiles(repoRoot);
  }
  return files
    .map(normalizePath)
    .filter(
      (path) =>
        path === "package.json" ||
        path === "tsconfig.json" ||
        path === "bun.lock" ||
        path.startsWith("src/") ||
        path.startsWith(".claude/hooks/") ||
        path.startsWith("scripts/"),
    )
    .filter((path) => !path.startsWith("src/web/") || path.endsWith(".gitkeep"))
    .filter((path) => existsSync(join(repoRoot, path)))
    .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function runtimePortabilityMessages(result: RuntimePortabilityResult): string[] {
  if (result.ok) {
    return [`runtime-portability - OK (checked=${result.checked}, TS/Bun/Node surfaces clean)`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.rule}`)
    .join(", ");
  return [`runtime-portability - violation ${result.violations.length} (${sample})`];
}
