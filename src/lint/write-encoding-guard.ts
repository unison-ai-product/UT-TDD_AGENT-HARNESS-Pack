import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { extractEditTargets, normalizeRepoRelative } from "../shared/edit-targets.ts";
import { ensureDir } from "../shared/fs.ts";
import {
  analyzeArtifacts,
  type ReadabilityArtifact,
  type ReadabilityResult,
} from "./readability.ts";

export interface WriteEncodingGuardInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export interface WriteEncodingGuardDeps {
  repoRoot: string;
  changedFiles?: () => string[];
  now?: () => string;
}

export interface WriteEncodingGuardResult {
  checked: number;
  targets: string[];
  result: ReadabilityResult;
  messages: string[];
}

const TEXT_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsonl",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".ps1",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const TEXT_BASENAMES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
]);

const SHELL_TOOL_NAMES = new Set(["Bash", "exec_command", "local_shell"]);

function normalizePathForGuard(path: string, repoRoot: string): string {
  return normalizeRepoRelative(path, repoRoot).replaceAll("\\", "/");
}

function basenameOf(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

export function isWriteEncodingGuardTextPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith(".git/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith("vendor/") ||
    normalized.endsWith(".lockb")
  ) {
    return false;
  }
  const base = basenameOf(normalized);
  return TEXT_BASENAMES.has(base) || TEXT_EXTENSIONS.has(extname(base).toLowerCase());
}

export function collectWriteEncodingGuardTargets(
  input: WriteEncodingGuardInput,
  repoRoot: string,
  changedFiles: readonly string[] = [],
): string[] {
  const explicitTargets = extractEditTargets(input.tool_input);
  const candidates =
    explicitTargets.length > 0
      ? explicitTargets
      : SHELL_TOOL_NAMES.has(input.tool_name ?? "")
        ? changedFiles
        : [];
  return [...new Set(candidates.map((path) => normalizePathForGuard(path, repoRoot)))]
    .filter((path) => path.length > 0)
    .filter(isWriteEncodingGuardTextPath)
    .sort();
}

function loadGuardArtifacts(repoRoot: string, targets: readonly string[]): ReadabilityArtifact[] {
  const artifacts: ReadabilityArtifact[] = [];
  for (const target of targets) {
    const full = join(repoRoot, target);
    if (!existsSync(full)) continue;
    try {
      if (!statSync(full).isFile()) continue;
      const bytes = readFileSync(full);
      artifacts.push({ path: target, bytes, text: bytes.toString("utf8") });
    } catch {
      // PostToolUse guard is advisory. Doctor/CI remains the fail-close backstop.
    }
  }
  return artifacts;
}

export function analyzeWriteEncodingGuardTargets(
  repoRoot: string,
  targets: readonly string[],
): WriteEncodingGuardResult {
  const artifacts = loadGuardArtifacts(repoRoot, targets);
  const result = analyzeArtifacts(artifacts);
  return {
    checked: artifacts.length,
    targets: [...targets],
    result,
    messages: writeEncodingGuardMessages(result),
  };
}

export function writeEncodingGuardMessages(result: ReadabilityResult): string[] {
  if (result.ok) return [];
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.marker}`)
    .join(", ");
  return [
    `write-encoding-guard — ⚠ UTF-8/readability violation ${result.violations.length}件 (${sample})。PowerShell 書き込みは -Encoding utf8 か Node fs に寄せて復元してください`,
  ];
}

export function appendWriteEncodingViolationLog(opts: {
  repoRoot: string;
  input: WriteEncodingGuardInput;
  result: ReadabilityResult;
  now?: () => string;
}): void {
  const { repoRoot, input, result, now = () => new Date().toISOString() } = opts;
  if (result.ok) return;
  const path = join(repoRoot, ".ut-tdd", "logs", "encoding-violations.jsonl");
  ensureDir(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      ts: now(),
      session_id: input.session_id ?? "unknown",
      tool_name: input.tool_name ?? "unknown",
      checked: result.checked,
      violations: result.violations,
    })}\n`,
    "utf8",
  );
}

export function runWriteEncodingGuard(
  input: WriteEncodingGuardInput,
  deps: WriteEncodingGuardDeps,
): WriteEncodingGuardResult {
  try {
    const explicitTargets = extractEditTargets(input.tool_input);
    const changedFiles =
      explicitTargets.length === 0 && SHELL_TOOL_NAMES.has(input.tool_name ?? "")
        ? (deps.changedFiles?.() ?? [])
        : [];
    const targets = collectWriteEncodingGuardTargets(input, deps.repoRoot, changedFiles);
    const result = analyzeWriteEncodingGuardTargets(deps.repoRoot, targets);
    appendWriteEncodingViolationLog({
      repoRoot: deps.repoRoot,
      input,
      result: result.result,
      now: deps.now,
    });
    return result;
  } catch {
    return {
      checked: 0,
      targets: [],
      result: { checked: 0, violations: [], ok: true },
      messages: [],
    };
  }
}
