import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./shared.ts";

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

const ALLOWED_SCRIPT_WRAPPERS = new Set([
  "scripts/ut-tdd",
  "scripts/ut-tdd.ps1",
  "scripts/run-vitest-snapshot.ts",
]);
// F0b の sealed Node generation は thin wrapper ではなく、レビュー済みの
// Node-only build entrypoint として scripts/ に置く。その他の script は
// 引き続き明示的に登録されない限り fail-close する。
const ALLOWED_BUILD_SCRIPTS = new Set(["scripts/build-node.mjs"]);
const ALLOWED_CI_SCRIPTS = new Set([
  "scripts/node-generation-ci.mjs",
  "scripts/node-generation-ci-aggregate.mjs",
]);
const VITEST_ENTRYPOINT = /\b(?:vitest\s+run|scripts[\\/]run-vitest-snapshot\.ts)\b/;

function usesVitestEntrypoint(
  script: string | undefined,
  scripts: Record<string, string> | undefined,
): boolean {
  return (
    VITEST_ENTRYPOINT.test(script ?? "") ||
    // PLAN-L7-462 step 2: source の `test` は npm run 経由の間接参照
    // (test:vitest-snapshot が runner を指すことが条件)。Pack artifact の `test` は
    // `bun run test:pack` で、test:pack が runner を直接指すため上の直接一致で足りる。
    (script === "npm run test:vitest-snapshot" &&
      VITEST_ENTRYPOINT.test(scripts?.["test:vitest-snapshot"] ?? ""))
  );
}
// git client-side hook entrypoints (PLAN-L7-260 §4, PLAN-L7-424 Step 2 が想定する置き場)。
// `scripts/` へ core logic を持ち込ませない gate の本旨は、検出ロジックを src/lint/secret-scan.ts
// に置き続けさせる下記の narrow 制約 (git-hook-entrypoint-not-thin / git-hook-scanner-not-reusing-core)
// で維持する。
const ALLOWED_GIT_HOOK_ENTRYPOINTS = new Set([
  "scripts/git-hooks/pre-push",
  "scripts/git-hooks/secret-scan-diff.ts",
]);
const GIT_HOOK_SCANNER_PATH = "scripts/git-hooks/secret-scan-diff.ts";
const GIT_HOOK_DISPATCHER_PATH = "scripts/git-hooks/pre-push";
const CORE_FILE_PATTERN = /\.(?:ts|gitkeep)$/;
const HOOK_FILE_PATTERN = /\.ts$/;
const DISALLOWED_RUNTIME_FILE_PATTERN = /\.(?:py|sh|bash|js|mjs|cjs)$/;
const LOCAL_ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/|~\/ai-dev-kit-vscode)/;
const SHELL_RUNTIME_PATTERN =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`](?:bash|sh|python|python3|powershell|pwsh|cmd(?:\.exe)?)(?:["'`]|\s)/;
// PLAN-L7-462 step 3 (AC-3): bun 実発火 spawn 引数 / bun: import / Bun-global 参照の
// 新規追加を fail-close する。既存残存は Issue #134 の migration debt として下記
// 例外リスト (path 完全一致・サイト単位注記付き) に帰属し、Pack 解禁時の後続 PLAN で
// 撤去する (恒久 bypass ではない期限付き例外)。検出は行単位で全件数える (exit criteria
// のカウンタ用途)。
// - spawn クラス: リテラル第 1 引数に加え、実在する間接形 (findBun() launcher /
//   `?? "bun"` fallback / cmd.exe 経由の `"/c", "bun"` / `["bun", [...]]` runner tuple /
//   shell wrapper の `exec bun`) を検出する。任意の変数間接は静的には閉じないため、
//   検出器は「repo に実在するイディオムの再流入」を止める網であり、完全な意味解析
//   ではない (限界の明示)。
const BUN_SPAWN_PATTERN = new RegExp(
  [
    /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]bun(?:\.cmd|\.exe)?["'`]/
      .source,
    /\bfindBun\s*\(/.source,
    /\?\?\s*["'`]bun(?:\.cmd|\.exe)?["'`]/.source,
    /["'`]\/c["'`]\s*,\s*["'`]bun(?:\.cmd|\.exe)?["'`]/.source,
    /\[\s*["'`]bun(?:\.cmd|\.exe)?["'`]\s*,\s*\[/.source,
    /\bexec\s+bun\b/.source,
  ].join("|"),
);
// テンプレート補間 (`bun:${...}`) と素の "bun" モジュール import は検出対象外 (限界の明示。
// 前者は動的識別子、後者は現 repo に 0 件で AC-3 の対象クラス外)。
const BUN_IMPORT_PATTERN = /["'`]bun:[a-z]/;
// quote を lookbehind に含め、検出語彙 ("Bun.write" 等の文字列 key) を構造的に除外する。
// `globalThis.Bun.x` / `Bun?.x` / `Bun["x"]` を含めるため `.` は除外しない。
// blind review A-4' 追随: member access 形だけでなく、Bun 分岐再流入の最頻イディオムである
// `typeof Bun` / `(globalThis as {...}).Bun` の末尾参照 / `process.versions.bun` 判定も検出する。
const BUN_GLOBAL_PATTERN = new RegExp(
  [
    /(?<![\w$"'`])Bun\s*\??\s*[.[]/.source,
    /\btypeof\s+(?:\([^)]*\)\s*\.\s*)?Bun\b/.source,
    /\)\s*\.\s*Bun\b/.source,
    /\bglobalThis\s*\.\s*Bun\b/.source,
    /\bprocess\.versions\.bun\b/.source,
  ].join("|"),
);
// 例外は「path 完全一致 + 現在の debt 行数 pin」で持つ (blind review A-2' 追随)。
// pin を超える行が現れた時点でその超過行を fail-close するため、収載ファイル内への
// 新規サイト追加は素通りしない (恒久 bypass 面を作らない)。debt が減る方向は自由。
// pin 値の更新は debt サイトの増減を伴う PR でのみ行い、増加は Issue #134 の帰属注記を要する。
// 限界の明示 (blind review G): count-pin は純増のみを検出し、同数 swap (既存 debt 行の除去と
// 新規サイト追加が同一 PR に同居) は静的には見えない。burn-down PR では pin を実測で追随減算
// することをレビュー規律とする (サイト同一性の機械追跡は AST 化とセットで Issue #134 後続)。
// また quote lookbehind の副作用で `globalThis["Bun"]` / `process.versions["bun"]` の
// 文字列 key 形は検出対象外 (検出語彙除外との trade-off、限界の明示)。
const BUN_SPAWN_DEBT_ALLOWLIST = new Map<string, number>([
  // step 2 freeze の fixture 例外: Pack/consumer toolchain 検出の posix probe。
  ["src/cli/distribution.ts", 2],
  // PLAN-L7-522 S1-b (Issue #470): generated consumer templates no longer
  // launch the removed findBun/run-bun wrapper, so this source has no spawn pin.
  // Issue #506: the local bun-launcher helper that this file previously used is retired;
  // all 10 call sites now run through Node/npm launchers, so this source has no spawn pin
  // (PLAN-L7-462 exit-criteria progress, does not itself close the criterion — the
  // separate consumer-template PATH-resolution contract in scripts/run-vitest-snapshot.ts
  // is out of this issue's scope).
  // tests/setup.test.ts の bun fallback (U-SETUP-009b) は global 側で計上され、spawn クラスの
  // 実サイトは 0 (blind review F: 空 pin 枠は置かない)。
  // 検出語彙 (lint fixture 文字列 / consumer template fixture) であり実発火ではない。
  ["tests/dependency-drift.test.ts", 1],
  ["tests/runtime-portability.test.ts", 11],
  ["tests/doctor-setup-smoke.test.ts", 1],
  ["tests/doctor.test.ts", 1],
  // 本 lint 自身 (pattern 定義とその注記 = 検出語彙)。
  ["src/lint/runtime-portability.ts", 4],
]);
const BUN_IMPORT_DEBT_ALLOWLIST = new Map<string, number>([
  // bun:sqlite / node:sqlite 二重ドライバ (PLAN-L7-45)。node:sqlite 主は
  // sqliteFallbackViolations が別途強制する。
  // 検出語彙 (lint fixture 文字列)。本 lint 自身の pattern 定義行は char class 表記のため
  // 自己一致しない (pin 0 = 収載不要)。
  ["tests/runtime-portability.test.ts", 5],
]);
const BUN_GLOBAL_DEBT_ALLOWLIST = new Map<string, number>([
  // Issue #506: the U-SETUP-009b wrapper-launch helper's runtime-version probe is retired
  // in favor of a Node-only launcher, so this source has no global pin.
  // 検出語彙 (lint fixture 文字列 / isolation 契約テストの Bun.write fixture / 本 lint 自身)。
  ["tests/runtime-portability.test.ts", 7],
  ["tests/doctor-test-repository-isolation.test.ts", 2],
  ["src/lint/runtime-portability.ts", 3],
]);
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
  // PLAN-L7-462 step 3: runtime 正本は Node (ADR-002 予定)。engines.node を必須とし、
  // engines.bun は Pack/consumer fixture の残存宣言として任意 (Issue #134 debt)。
  if (!pkg.engines?.node) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-node-engine",
      message: "Node runtime contract must declare the Node engine (PLAN-L7-462 step 3).",
    });
  }
  if (!/\bnode\s+scripts[\\/]build-node\.mjs\b/.test(pkg.scripts?.build ?? "")) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-compiled-build",
      message: "Build script must invoke the sealed Node builder.",
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
  if (!usesVitestEntrypoint(pkg.scripts?.test, pkg.scripts)) {
    violations.push({
      path,
      line: 1,
      rule: "package-missing-vitest-full-suite",
      message: "Full test suite must use the Vitest runner through a named package script.",
    });
  }
  if (
    !usesVitestEntrypoint(pkg.scripts?.["test:fast"], pkg.scripts) ||
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
    !usesVitestEntrypoint(pkg.scripts?.["test:db"], pkg.scripts) ||
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
    !usesVitestEntrypoint(pkg.scripts?.["test:cli"], pkg.scripts) ||
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
    !usesVitestEntrypoint(pkg.scripts?.["test:node-fallback"], pkg.scripts) ||
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
  if (
    path.startsWith("scripts/") &&
    !ALLOWED_SCRIPT_WRAPPERS.has(path) &&
    !ALLOWED_BUILD_SCRIPTS.has(path) &&
    !ALLOWED_CI_SCRIPTS.has(path) &&
    !ALLOWED_GIT_HOOK_ENTRYPOINTS.has(path)
  ) {
    violations.push({
      path,
      line: 1,
      rule: "script-wrapper-unapproved",
      message:
        "Only approved Node build entrypoints, thin ut-tdd POSIX/PowerShell wrappers, and tracked git-hooks entrypoints are allowed under scripts/.",
    });
  }
  if (path === GIT_HOOK_DISPATCHER_PATH) {
    if (/\bpython(?:3)?\b/.test(doc.text)) {
      violations.push({
        path,
        line: lineOf(doc.text, /\bpython(?:3)?\b/),
        rule: "git-hook-entrypoint-python",
        message: "git-hooks entrypoints must not reintroduce Python runtime dispatch.",
      });
    }
    // PLAN-L7-462 step 3: dispatcher は node 起動へ swap (bun 残置は fail-close 対象)。
    if (!/\bnode\b/.test(doc.text) || !doc.text.includes("secret-scan-diff.ts")) {
      violations.push({
        path,
        line: 1,
        rule: "git-hook-entrypoint-not-thin",
        message: `${GIT_HOOK_DISPATCHER_PATH} must stay a thin node dispatcher to ${GIT_HOOK_SCANNER_PATH}, not reimplement scan logic.`,
      });
    }
  }
  if (path === GIT_HOOK_SCANNER_PATH && !/src[\\/]lint[\\/]secret-scan/.test(doc.text)) {
    violations.push({
      path,
      line: 1,
      rule: "git-hook-scanner-not-reusing-core",
      message: `${GIT_HOOK_SCANNER_PATH} must reuse src/lint/secret-scan.ts detection logic, not reimplement it.`,
    });
  }
  if (ALLOWED_SCRIPT_WRAPPERS.has(path) && path !== "scripts/run-vitest-snapshot.ts") {
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
  if (
    path.startsWith("src/") ||
    path.startsWith(".claude/hooks/") ||
    path.startsWith("scripts/") ||
    path.startsWith("tests/")
  ) {
    // 行単位で全件数える (exit criteria のカウンタ用途、B-4)。scope は shell wrapper
    // (scripts/ut-tdd 等の非 .ts) と tests/ を含む — tests 側 launcher の bun 再流入も
    // fail-close する (freeze の fixture 例外は上の allowlist に path 完全一致で帰属)。
    const bunRules: readonly [RegExp, Map<string, number>, string, string][] = [
      [
        BUN_SPAWN_PATTERN,
        BUN_SPAWN_DEBT_ALLOWLIST,
        "bun-runtime-spawn",
        "New bun child-process launches are fail-closed; Node is the runtime authority (PLAN-L7-462 step 3, Issue #134).",
      ],
      [
        BUN_IMPORT_PATTERN,
        BUN_IMPORT_DEBT_ALLOWLIST,
        "bun-module-import",
        "New bun: module imports are fail-closed; Node is the runtime authority (PLAN-L7-462 step 3, Issue #134).",
      ],
      [
        BUN_GLOBAL_PATTERN,
        BUN_GLOBAL_DEBT_ALLOWLIST,
        "bun-global-reference",
        "New Bun global API references are fail-closed; Node is the runtime authority (PLAN-L7-462 step 3, Issue #134).",
      ],
    ];
    const lines = doc.text.split(/\r?\n/);
    for (const [pattern, allowlist, rule, message] of bunRules) {
      // pin (許容 debt 行数) を超えた行だけを違反にする。非収載 path は pin=0 で全行 fail-close。
      const pinned = allowlist.get(path) ?? 0;
      let seen = 0;
      for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i])) {
          seen += 1;
          if (seen > pinned) {
            violations.push({ path, line: i + 1, rule, message });
          }
        }
      }
    }
  }
  if (!path.startsWith("tests/") && LOCAL_ABSOLUTE_PATH_PATTERN.test(doc.text)) {
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
  // PLAN-L7-462 step 3 (反転): node:sqlite が主ドライバとして必須。bun:sqlite は
  // 残存 debt として任意 (撤去は Issue #134 の段階撤去に従う)。
  if (stateDb.text.includes("node:sqlite")) return [];
  return [
    {
      path: stateDb.path,
      line: 1,
      rule: "sqlite-driver-fallback-missing",
      message: "SQLite adapter must keep the node:sqlite primary driver visible.",
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
  const acc: string[] = ["package.json", "tsconfig.json", "package-lock.json"];
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
        path === "package-lock.json" ||
        path.startsWith("src/") ||
        path.startsWith(".claude/hooks/") ||
        path.startsWith("scripts/") ||
        path.startsWith("tests/"),
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
