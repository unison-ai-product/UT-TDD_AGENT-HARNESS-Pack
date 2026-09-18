import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitObjectIdSchema } from "../schema/node-slice-admission.ts";
import {
  collectNodeBanFindings,
  loadNodeBanDocuments,
  type NodeBanAuditReceipt,
  type NodeBanF0cAggregateBinding,
  type NodeBanGenerationBinding,
  verifyNodeBanAuditReceipt,
} from "./bun-permanent-ban.ts";
import {
  admitNodeGenerationAggregate,
  type NodeGenerationCiEvidence,
} from "./node-generation-ci-policy.ts";

const RAW_REVISION = /^[0-9a-f]{40}$/;
const PREFIXED_REVISION = /^git-sha1:([0-9a-f]{40})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_EXECUTABLE = /^(?:bun|bunx|tsx|bash|sh|powershell|pwsh|cmd)$/i;
const FORBIDDEN_ARGUMENT = /^(?:bun|bunx|tsx)(?:\.(?:cmd|exe|bat))?$/i;

class HistoryIncompleteError extends Error {
  readonly code = "history_incomplete";
}

export type BunRetirementReason =
  | "f0b_receipt_missing"
  | "f0c_receipt_missing"
  | "q0_receipt_missing"
  | "retirement_receipt_missing"
  | "receipt_schema_invalid"
  | "subject_revision_mismatch"
  | "generation_id_mismatch"
  | "artifact_digest_mismatch"
  | "retirement_subject_mismatch"
  | "predecessor_equals_retirement"
  | "predecessor_not_ancestor"
  | "q0_binding_invalid"
  | "reachable_bun_surface"
  | "indeterminate_bun_surface"
  | "history_incomplete";

export class BunRetirementError extends Error {
  readonly reason: BunRetirementReason;
  constructor(reason: BunRetirementReason) {
    super(reason);
    this.name = "BunRetirementError";
    this.reason = reason;
  }
}

export type BunRetirementF0bReceipt = NodeBanGenerationBinding;
export type BunRetirementF0cReceipt = NodeBanF0cAggregateBinding;
export type BunRetirementQ0Receipt = NodeBanAuditReceipt;

/**
 * The append-only admission record emitted for the final retirement commit.
 *
 * The predecessor receipts are intentionally referenced by digest instead of
 * being copied into the PLAN.  This makes replay bound to the exact retirement
 * subject and prevents an ancestor-only receipt set from being reused after a
 * later retirement commit.
 */
export interface BunRetirementAdmissionReceipt {
  readonly schema_version: "bun-final-retirement.v1";
  readonly subject_revision: string;
  readonly generation_id: string;
  readonly artifact_digest: string;
  readonly retirement_subject: string;
  readonly f0b_receipt_digest: string;
  readonly f0c_receipt_digest: string;
  readonly q0_receipt_digest: string;
  readonly surface_inventory_digest: string;
  readonly receipt_digest: string;
}

export interface BunRetirementSurface {
  readonly path: string;
  readonly symbol: string;
  readonly classification:
    | "reachable_production"
    | "ban_enforcement_guard"
    | "retained_fixture"
    | "retained_compatibility_vocabulary"
    | "non_applicable_false_positive"
    | "indeterminate";
}

export interface BunRetirementInput {
  readonly repoRoot: string;
  readonly f0b: BunRetirementF0bReceipt | null | undefined;
  readonly f0c: BunRetirementF0cReceipt | null | undefined;
  readonly q0: BunRetirementQ0Receipt | null | undefined;
  readonly f0cLanes: readonly NodeGenerationCiEvidence[];
  /** Algorithm-prefixed Git object id of the exact retirement commit. */
  readonly retirementSubject: string;
  /** Append-only record produced for this exact retirement subject. */
  readonly retirementReceipt: BunRetirementAdmissionReceipt | null | undefined;
  readonly surfaces: readonly BunRetirementSurface[];
}

export interface BunRetirementTuple {
  readonly subject_revision: string;
  readonly generation_id: string;
  readonly artifact_digest: string;
  readonly retirement_subject: string;
}

export interface BunRetirementResult {
  readonly ok: true;
  readonly tuple: BunRetirementTuple;
  readonly receipt_digest: string;
}

/** Paths whose Bun vocabulary is exclusively the permanent-ban detector/guard. */
const FINAL_GUARD_PATHS = new Set([
  "src/lint/runtime-portability.ts",
  "src/lint/bun-permanent-ban.ts",
  "src/lint/rule-drift.ts",
  "src/lint/toolchain-pin.ts",
  "src/lint/github-ci-policy.ts",
  "src/state-db/stop-refresh.ts",
  "src/runtime/runtime-image-observer.ts",
  "src/lint/bun-final-retirement.ts",
  "src/doctor/test-repository-isolation.ts",
  "src/doctor/setup-smoke.ts",
  "src/doctor/rule-quality.ts",
]);

const INSTRUCTION_PATHS = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "README.md",
  "src/lint/write-encoding-guard.ts",
]);

// These are the document roots that the clean Pack actually ships. Other
// tracked documentation remains in the raw inventory, but is not a runtime or
// AI-instruction surface in the Pack and cannot hide a reachable command. This
// mirrors the distribution boundary rather than a list of individual "clean"
// Bun entries.
const PACK_DOCUMENT_PREFIXES = [
  "docs/process/",
  "docs/reference/",
  "docs/skills/",
  "docs/templates/adapter/",
  "docs/templates/github/",
];

const COMPATIBILITY_PATHS = new Set([
  "src/schema/frontmatter.ts",
  "src/schema/cutover-transition.ts",
  "src/runtime/cutover-transition.ts",
  "src/runtime/verb-classify.ts",
  "src/runtime/agent-slots.ts",
  "src/runtime/node-slice-admission.ts",
  "src/lint/design-language.ts",
  "src/lint/erasable-syntax.ts",
  "src/lint/review-evidence.ts",
  "src/lint/verification-profile.ts",
  "src/lint/verification-profile-types.ts",
  "src/lint/verification-profile-catalog.ts",
  "src/lint/verification-profile-safety.ts",
]);

const BUN_TOKEN = /\b(?:bun|bunx)\b/iu;
const BUN_TOKEN_FALLBACK = "bun";
const BUN_PATH_TOKEN = /(?:^|[./_-])bunx?(?:$|[./_-])|(?:^|[./_-])bun\.lock(?:b)?$/iu;
const ACTIVE_INSTRUCTION =
  /\b(?:use|run|install|build|execute|exec|command|filesystem|script|setup|launch|invoke|start)\b/iu;
const RETIRED_POLICY =
  /\b(?:retired|ban|banned|forbidden|prohibited|legacy|migration|detector|guard|audit|deny|refuse|fallback)\b/iu;
const ACTIVE_BUN_EXECUTION =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`](?:bun|bunx)(?:\.(?:cmd|exe|bat))?["'`]/iu;
const ACTIVE_BUN_IMPORT = /(?:\bfrom\s*|\bimport\s*)["'`]bun:/iu;

interface GitBunLine {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  /** True when the candidate came from the Git tree path inventory, not text. */
  readonly pathOnly?: boolean;
}

function gitTrackedBunLines(repoRoot: string): GitBunLine[] {
  const lines: GitBunLine[] = [];
  try {
    const output = execFileSync(
      "git",
      ["-C", repoRoot, "grep", "-n", "-I", "-i", "-E", "\\b(bun|bunx)\\b", "HEAD", "--", "."],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    lines.push(
      ...output
        .split(/\r?\n/u)
        .filter(Boolean)
        .flatMap((entry) => {
          const first = entry.indexOf(":");
          const second = entry.indexOf(":", first + 1);
          const third = entry.indexOf(":", second + 1);
          if (first < 0 || second < 0 || third < 0) return [];
          const path = entry.slice(first + 1, second).replaceAll("\\", "/");
          const line = Number(entry.slice(second + 1, third));
          if (!path || !Number.isInteger(line) || line < 1) return [];
          return [{ path, line, text: entry.slice(third + 1) }];
        }),
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "status" in error && error.status === 1))
      throw new BunRetirementError("indeterminate_bun_surface");
  }
  let paths: string;
  try {
    paths = execFileSync(
      "git",
      ["-C", repoRoot, "ls-tree", "-r", "--name-only", "HEAD", "--", "."],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    throw new BunRetirementError("indeterminate_bun_surface");
  }
  const textPaths = new Set(lines.map((entry) => entry.path));
  for (const path of paths.split(/\r?\n/u).filter(Boolean)) {
    if (!BUN_PATH_TOKEN.test(path) || textPaths.has(path)) continue;
    lines.push({ path: path.replaceAll("\\", "/"), line: 0, text: "", pathOnly: true });
  }
  return lines;
}

const NON_EXECUTABLE_ARTIFACT = /\.(?:diff|log|md|mdx|json|ya?ml|txt)$/iu;
const TEST_ORACLE_EVIDENCE =
  /(?:\b(?:assert|describe|expect|fixture|forbidden|it|mock|mutation|negative|oracle|sample|synthetic|test)\b|["'`])/iu;

function hasRetainedFixtureEvidence(path: string, line: string): boolean {
  if (!line.trim()) return false;
  if (path.startsWith(".ut-tdd/") || path.startsWith("docs/"))
    return NON_EXECUTABLE_ARTIFACT.test(path);
  if (path.startsWith("vendor/") || path.includes("/fixtures/") || path.includes("/fixture/"))
    return NON_EXECUTABLE_ARTIFACT.test(path) || TEST_ORACLE_EVIDENCE.test(line);
  if (path.startsWith("tests/") && /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(path))
    return line.trim().length > 0 && (TEST_ORACLE_EVIDENCE.test(line) || /\bBun\b/iu.test(line));
  if (path.startsWith("tests/support/")) return line.trim().length > 0;
  return false;
}

/** Returns, for every column of `line`, whether that column is executable
 * code: outside string/backtick literals (a `${...}` interpolation inside a
 * template literal is code again) and outside a line or block comment.
 * Comments and quoted data (test oracle strings, markdown inline code) are not
 * launches the runtime can reach. */
function codeColumns(line: string): boolean[] {
  const code = new Array<boolean>(line.length).fill(false);
  // Stack of open delimiters: a quote char, or "{" for a template interpolation.
  const open: string[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const top = open[open.length - 1];
    if (top === '"' || top === "'" || top === "`") {
      if (ch === "\\") i++;
      else if (ch === top) open.pop();
      else if (top === "`" && ch === "$" && line[i + 1] === "{") {
        open.push("{");
        i++;
      }
      continue;
    }
    // Code context (top-level or inside a template interpolation).
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    code[i] = true;
    if (ch === '"' || ch === "'" || ch === "`") open.push(ch);
    else if (ch === "{" && top === "{") open.push("{");
    else if (ch === "}" && top === "{") open.pop();
  }
  return code;
}

/** True when an ACTIVE_BUN_* match starts in executable code (see codeColumns). */
function hasBunCodeOutsideStringLiteral(line: string): boolean {
  const code = codeColumns(line);
  for (const pattern of [ACTIVE_BUN_EXECUTION, ACTIVE_BUN_IMPORT]) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of line.matchAll(global)) if (code[match.index]) return true;
  }
  return false;
}

export function classifyTrackedSurface(
  path: string,
  line: string,
  pathOnly = false,
): BunRetirementSurface["classification"] {
  // A binary/path-only candidate has no semantic evidence.  The root lockfile is
  // an explicit production artifact.  Named launchers and executable setup
  // roots are also production surfaces; every other path-only candidate is
  // unknown and must not be silently retained.
  if (pathOnly) {
    if (
      path === "bun.lock" ||
      path === "bun.lockb" ||
      /(?:^|\/)(?:bun|bunx)(?:\.(?:cmd|exe|bat))?$/iu.test(path) ||
      /^(?:\.github|\.claude\/hooks|bin|scripts|src\/setup)\//iu.test(path)
    )
      return "reachable_production";
    return "indeterminate";
  }
  const fixturePath =
    path.startsWith("tests/") ||
    path.startsWith("vendor/") ||
    path.startsWith(".ut-tdd/") ||
    path.includes("/fixtures/") ||
    path.includes("/fixture/");
  // A Bun launch or `bun:` import written as code (not inside a string literal)
  // is reachable wherever it lives (PLAN-L7-530 §3: never classify by path name
  // alone), so it is judged before any fixture/test path can retain the line.
  if (hasBunCodeOutsideStringLiteral(line)) return "reachable_production";
  if (fixturePath)
    return hasRetainedFixtureEvidence(path, line) ? "retained_fixture" : "indeterminate";
  if (
    path === "bun.lock" ||
    path === "bun.lockb" ||
    path === "package.json" ||
    path === "package-lock.json"
  )
    return "reachable_production";
  if (path.startsWith("docs/")) {
    if (!PACK_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix)))
      return hasRetainedFixtureEvidence(path, line) ? "retained_fixture" : "indeterminate";
    if (FINAL_GUARD_PATHS.has(path)) return "ban_enforcement_guard";
    // Excluded governance history is retained because the clean Pack does not
    // execute it.  Other documentation is classified from its actual line so
    // a newly added Bun command cannot hide behind a broad docs allowlist.
    const excludedHistory =
      path.startsWith("docs/plans/") ||
      path.startsWith("docs/design/") ||
      path.startsWith("docs/handover/") ||
      path.startsWith("docs/archive/") ||
      path.startsWith("docs/governance/");
    const activeCommand =
      /\b(?:bun|bunx)(?:\.(?:cmd|exe|bat))?\s+(?:run|install|build|exec|x)\b/iu.test(line) ||
      /\b(?:use|run|install|build|execute|launch|invoke)\b[^\n]*(?:bun|bunx)\b/iu.test(line);
    if (activeCommand && !RETIRED_POLICY.test(line) && !excludedHistory)
      return "reachable_production";
    return "retained_fixture";
  }
  if (ACTIVE_BUN_EXECUTION.test(line) || ACTIVE_BUN_IMPORT.test(line))
    return "reachable_production";
  if (FINAL_GUARD_PATHS.has(path)) return "ban_enforcement_guard";
  if (INSTRUCTION_PATHS.has(path)) {
    // Policy statements describing the ban are retained guards.  Only an
    // active instruction which would send a user/runtime through Bun is a
    // reachable production surface.
    return (ACTIVE_INSTRUCTION.test(line) ||
      /(?:bun|bunx)\s*[/.:]\s*(?:fs|filesystem|runtime)/iu.test(line)) &&
      !RETIRED_POLICY.test(line)
      ? "reachable_production"
      : "ban_enforcement_guard";
  }
  if (path.startsWith("skills/")) {
    return ACTIVE_INSTRUCTION.test(line) && !RETIRED_POLICY.test(line)
      ? "reachable_production"
      : "retained_fixture";
  }
  if (COMPATIBILITY_PATHS.has(path)) return "retained_compatibility_vocabulary";
  if (path.startsWith("src/lint/") || path.startsWith("src/doctor/"))
    return "ban_enforcement_guard";
  if (path === "src/cli.ts") {
    if (
      /process\.versions\.bun|bun-runtime-refused|bun-(?:permanent-ban|final-retirement)|BunRetirement|audit[^\n]*bun|from ["'][^"']*bun/iu.test(
        line,
      )
    )
      return "ban_enforcement_guard";
    return "retained_compatibility_vocabulary";
  }
  if (/^\s*(?:\/\/|\/\*|\*|\*\/)/u.test(line)) return "retained_compatibility_vocabulary";
  // Source-side detectors and policy adapters are guards; an executable
  // script/workflow or generated setup template is an actual reachable
  // production surface and must be clean after the retirement.
  if (
    path.startsWith(".github/") ||
    path.startsWith(".claude/hooks/") ||
    path.startsWith("scripts/") ||
    path.startsWith("src/setup/")
  )
    return "reachable_production";
  if (path === ".gitignore" || path === ".gitattributes" || path === ".vscode/extensions.json")
    return "ban_enforcement_guard";
  return "indeterminate";
}

/**
 * Build the final surface inventory from the exact tracked HEAD, rather than
 * accepting a caller-maintained list of clean entries or reading an uncommitted
 * working tree.  The supplied list is checked against this inventory by
 * admission, so adding a new instruction cannot silently keep a hard-coded
 * clean oracle green.
 */
export function collectFinalRetirementSurfaceInventory(repoRoot: string): BunRetirementSurface[] {
  const surfaces = gitTrackedBunLines(repoRoot).map(({ path, line, text, pathOnly }) => ({
    path,
    symbol:
      pathOnly === true
        ? `path:${path}`
        : `line:${line}:${text.match(BUN_TOKEN)?.[0]?.toLowerCase() ?? BUN_TOKEN_FALLBACK}`,
    classification: classifyTrackedSurface(path, text, pathOnly),
  }));
  return surfaces.sort((left, right) =>
    `${left.path}\0${left.symbol}\0${left.classification}`.localeCompare(
      `${right.path}\0${right.symbol}\0${right.classification}`,
    ),
  );
}

function rawRevision(value: string): string | null {
  const prefixed = PREFIXED_REVISION.exec(value);
  if (prefixed) return prefixed[1];
  return RAW_REVISION.test(value) ? value : null;
}

function prefixedRevision(value: string): string {
  const raw = rawRevision(value);
  if (!raw) throw new BunRetirementError("receipt_schema_invalid");
  const candidate = `git-sha1:${raw}`;
  if (!gitObjectIdSchema.safeParse(candidate).success)
    throw new BunRetirementError("receipt_schema_invalid");
  return candidate;
}

function currentHead(repoRoot: string): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Shared admission invariant kept local to lint so the detector does not cross into runtime. */
function assertCompleteGitHistory(repoRoot: string, commits: readonly string[]): void {
  const git = (args: readonly string[]): string => {
    try {
      return execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new HistoryIncompleteError("history_incomplete");
    }
  };
  if (!existsSync(resolve(repoRoot, ".git")))
    throw new HistoryIncompleteError("history_incomplete");
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false")
    throw new HistoryIncompleteError("history_incomplete");
  try {
    const shallowPath = git(["rev-parse", "--git-path", "shallow"]);
    if (existsSync(shallowPath) && readFileSync(shallowPath, "utf8").trim())
      throw new HistoryIncompleteError("history_incomplete");
  } catch (error) {
    if (error instanceof HistoryIncompleteError) throw error;
  }
  try {
    const promisor = execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "config",
        "--get-regexp",
        "^(remote\\..*\\.promisor|extensions\\.partialclonefilter)",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (promisor) throw new HistoryIncompleteError("history_incomplete");
  } catch (error) {
    if (error instanceof HistoryIncompleteError) throw error;
    // git config exits 1 when no promisor configuration exists.
  }
  for (const commit of commits) {
    try {
      execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${commit}^{commit}`], {
        stdio: "ignore",
      });
    } catch {
      throw new HistoryIncompleteError("history_incomplete");
    }
  }
}

function classifyObservedProcess(command: string, args: readonly string[], shell: boolean): string {
  if (shell) return "shell-runtime";
  const executable = command.replace(/^.*[\\/]/, "").replace(/\.(?:cmd|exe|bat)$/i, "");
  if (FORBIDDEN_EXECUTABLE.test(executable)) return `${executable.toLowerCase()}-runtime`;
  if (!/^node$/i.test(executable)) return "non-node-runtime";
  return args.some((arg) => FORBIDDEN_ARGUMENT.test(arg) || /\.(?:ts|tsx)$/i.test(arg))
    ? "source-or-bun-fallback"
    : "node-only";
}

function isAncestor(repoRoot: string, ancestor: string, subject: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, subject], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function validF0b(receipt: BunRetirementF0bReceipt): boolean {
  return (
    receipt.runtime === "node" &&
    (receipt.lane === "linux" || receipt.lane === "windows") &&
    typeof receipt.generation_id === "string" &&
    receipt.generation_id.length > 0 &&
    rawRevision(receipt.subject_revision) !== null &&
    DIGEST.test(receipt.artifact_digest) &&
    /^[0-9a-f]{64}$/.test(receipt.receipt_digest)
  );
}

function validF0c(receipt: BunRetirementF0cReceipt): boolean {
  return (
    receipt.ok === true &&
    receipt.schema_version === "node-generation-aggregate.v1" &&
    typeof receipt.generation_id === "string" &&
    receipt.generation_id.length > 0 &&
    DIGEST.test(receipt.artifact_digest) &&
    rawRevision(receipt.subject_revision) !== null &&
    rawRevision(receipt.workflow_revision) !== null &&
    typeof receipt.run_id === "string" &&
    receipt.run_id.length > 0 &&
    Number.isSafeInteger(receipt.run_attempt) &&
    receipt.run_attempt > 0
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function sha256Value(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

function verifyAdmissionReceipt(
  receipt: BunRetirementAdmissionReceipt,
  input: {
    f0b: BunRetirementF0bReceipt;
    f0c: BunRetirementF0cReceipt;
    q0: BunRetirementQ0Receipt;
    subjectRevision: string;
    retirementSubject: string;
    surfaceInventoryDigest: string;
  },
): void {
  const unsigned = { ...receipt } as Record<string, unknown>;
  delete unsigned.receipt_digest;
  if (
    receipt.schema_version !== "bun-final-retirement.v1" ||
    !rawRevision(receipt.subject_revision) ||
    !rawRevision(receipt.retirement_subject) ||
    !receipt.generation_id ||
    !DIGEST.test(receipt.artifact_digest) ||
    !DIGEST.test(receipt.f0b_receipt_digest) ||
    !DIGEST.test(receipt.f0c_receipt_digest) ||
    !DIGEST.test(receipt.q0_receipt_digest) ||
    !DIGEST.test(receipt.surface_inventory_digest) ||
    !DIGEST.test(receipt.receipt_digest) ||
    receipt.receipt_digest !== sha256Value(unsigned)
  )
    throw new BunRetirementError("receipt_schema_invalid");
  if (
    rawRevision(receipt.subject_revision) !== input.subjectRevision ||
    rawRevision(receipt.retirement_subject) !== input.retirementSubject
  )
    throw new BunRetirementError("retirement_subject_mismatch");
  if (
    receipt.generation_id !== input.f0b.generation_id ||
    receipt.artifact_digest !== input.f0c.artifact_digest ||
    receipt.f0b_receipt_digest !== sha256Value(input.f0b) ||
    receipt.f0c_receipt_digest !== sha256Value(input.f0c) ||
    receipt.q0_receipt_digest !== input.q0.receipt_digest ||
    receipt.surface_inventory_digest !== input.surfaceInventoryDigest
  )
    throw new BunRetirementError("q0_binding_invalid");
}

function verifySurfaces(
  repoRoot: string,
  supplied: readonly BunRetirementSurface[],
): `sha256:${string}` {
  const surfaces = collectFinalRetirementSurfaceInventory(repoRoot);
  const key = (surface: BunRetirementSurface) =>
    `${surface.path}\0${surface.symbol}\0${surface.classification}`;
  const expected = surfaces.map(key).sort();
  const actual = [...supplied].map(key).sort();
  if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index]))
    throw new BunRetirementError("indeterminate_bun_surface");
  if (
    surfaces.length === 0 ||
    surfaces.some((surface) => !surface.path.trim() || !surface.symbol.trim())
  )
    throw new BunRetirementError("indeterminate_bun_surface");
  if (surfaces.some((surface) => surface.classification === "indeterminate"))
    throw new BunRetirementError("indeterminate_bun_surface");
  if (surfaces.some((surface) => surface.classification === "reachable_production"))
    throw new BunRetirementError("reachable_bun_surface");
  return sha256Value(expected);
}

/** Exposed for the independent CAND-NODEBOOT-208 mutation oracle. */
export function verifyFinalRetirementSurfaces(
  repoRoot: string,
  supplied: readonly BunRetirementSurface[],
): `sha256:${string}` {
  return verifySurfaces(repoRoot, supplied);
}

/**
 * Final deletion admission. This is deliberately pure: callers must receive
 * this result before changing package/build/runtime artifacts.
 */
export function admitFinalBunRetirement(input: BunRetirementInput): BunRetirementResult {
  if (!input.f0b) throw new BunRetirementError("f0b_receipt_missing");
  if (!input.f0c) throw new BunRetirementError("f0c_receipt_missing");
  if (!input.q0) throw new BunRetirementError("q0_receipt_missing");
  if (!input.retirementReceipt) throw new BunRetirementError("retirement_receipt_missing");
  if (!validF0b(input.f0b) || !validF0c(input.f0c))
    throw new BunRetirementError("receipt_schema_invalid");

  const f0bSubject = rawRevision(input.f0b.subject_revision);
  const f0cSubject = rawRevision(input.f0c.subject_revision);
  const workflowRevision = rawRevision(input.f0c.workflow_revision);
  const retirementSubject = rawRevision(input.retirementSubject);
  if (!f0bSubject || !f0cSubject || !workflowRevision || !retirementSubject)
    throw new BunRetirementError("receipt_schema_invalid");
  if (f0bSubject !== f0cSubject) throw new BunRetirementError("subject_revision_mismatch");
  if (f0cSubject === retirementSubject)
    throw new BunRetirementError("predecessor_equals_retirement");
  if (input.f0b.artifact_digest !== input.f0c.artifact_digest)
    throw new BunRetirementError("artifact_digest_mismatch");

  const lanes = input.f0cLanes;
  if (
    lanes.length !== 2 ||
    new Set(lanes.map((lane) => lane.lane)).size !== 2 ||
    !lanes.some((lane) => lane.lane === "linux") ||
    !lanes.some((lane) => lane.lane === "windows")
  )
    throw new BunRetirementError("q0_binding_invalid");
  const nodeLane = lanes.find((lane) => lane.lane === input.f0b?.lane);
  if (!nodeLane || nodeLane.sealed_generation_id !== input.f0b.generation_id)
    throw new BunRetirementError("generation_id_mismatch");
  if (lanes.some((lane) => lane.generation_id !== input.f0c?.generation_id))
    throw new BunRetirementError("generation_id_mismatch");
  try {
    verifyNodeBanAuditReceipt(input.q0, {
      subjectRevision: f0cSubject,
      f0c: input.f0c,
      node: input.f0b,
      f0cLanes: input.f0cLanes,
      classifyProcess: classifyObservedProcess,
    });
  } catch {
    throw new BunRetirementError("q0_binding_invalid");
  }
  if (input.q0.qualification !== "qualified") throw new BunRetirementError("q0_binding_invalid");
  const aggregate = admitNodeGenerationAggregate({
    evidence: lanes,
    expected: {
      workflow_revision: input.f0c.workflow_revision,
      subject_revision: input.f0c.subject_revision,
      run_id: input.f0c.run_id,
      run_attempt: input.f0c.run_attempt,
    },
  });
  if (!aggregate.ok) throw new BunRetirementError("q0_binding_invalid");

  const head = currentHead(input.repoRoot);
  if (!head || head !== retirementSubject)
    throw new BunRetirementError("retirement_subject_mismatch");
  try {
    assertCompleteGitHistory(input.repoRoot, [f0cSubject, retirementSubject]);
  } catch (error) {
    if (error instanceof HistoryIncompleteError && error.code === "history_incomplete")
      throw new BunRetirementError("history_incomplete");
    throw new BunRetirementError("predecessor_not_ancestor");
  }
  if (!isAncestor(input.repoRoot, f0cSubject, retirementSubject))
    throw new BunRetirementError("predecessor_not_ancestor");

  const surfaceInventoryDigest = verifySurfaces(input.repoRoot, input.surfaces);
  verifyAdmissionReceipt(input.retirementReceipt, {
    f0b: input.f0b,
    f0c: input.f0c,
    q0: input.q0,
    subjectRevision: f0cSubject,
    retirementSubject,
    surfaceInventoryDigest,
  });
  const tuple: BunRetirementTuple = {
    subject_revision: prefixedRevision(input.f0c.subject_revision),
    generation_id: input.f0b.generation_id,
    artifact_digest: input.f0c.artifact_digest,
    retirement_subject: prefixedRevision(input.retirementSubject),
  };
  return {
    ok: true,
    tuple,
    receipt_digest: `sha256:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`,
  };
}

/** Re-run the existing Q0 document detectors for the physical tree. */
export function collectFinalRetirementFindings(repoRoot: string) {
  return collectNodeBanFindings(loadNodeBanDocuments(repoRoot));
}
