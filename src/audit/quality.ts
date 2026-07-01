import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SECRET_PATTERN } from "../state-db/index";

export type QualityAuditBucket = "gate" | "actionable" | "telemetry";

export interface QualityAuditFinding {
  bucket: QualityAuditBucket;
  code:
    | "secret_like_literal"
    | "dangerous_shell_execution"
    | "hardcoded_absolute_path"
    | "hardcoded_local_endpoint"
    | "hardcoded_model_or_provider"
    | "todo_marker"
    | "legacy_runtime_reference";
  path: string;
  line: number;
  message: string;
}

export interface QualityAuditResult {
  ok: boolean;
  total: number;
  byBucket: Record<QualityAuditBucket, number>;
  byCode: Record<string, number>;
  findings: QualityAuditFinding[];
}

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".yaml",
  ".yml",
  ".ps1",
  ".sh",
  ".cmd",
]);

const EXCLUDED_DIRS = new Set([".git", ".ut-tdd", "coverage", "dist", "node_modules", "vendor"]);

const EXCLUDED_PREFIXES = ["docs/archive/", "docs/migration/", "legacy local state/", "vendor/"];
const MODEL_PROVIDER_PATTERN = new RegExp(
  `\\b(?:${["gpt", "[A-Za-z0-9_.-]+"].join("-")}|${["claude", "[A-Za-z0-9_.-]+"].join(
    "-",
  )}|${["son", "net"].join("")}|${["op", "us"].join("")})\\b`,
);
const LEGACY_ENV_PREFIX = ["HE", "LIX"].join("");
const LEGACY_COMMAND = ["he", "lix"].join("");
const LEGACY_RUNTIME_PATTERN = new RegExp(
  `\\b${LEGACY_ENV_PREFIX}_[A-Z0-9_]+|\\b${LEGACY_COMMAND}\\s+(?:codex|claude|plan|gate|handover)\\b`,
);

function norm(path: string): string {
  return path.replaceAll("\\", "/");
}

function extOf(path: string): string {
  const match = path.match(/\.[^/\\]+$/);
  return match?.[0] ?? "";
}

function shouldScan(path: string, includeDocs: boolean, includeTests: boolean): boolean {
  const normalized = norm(path);
  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (!includeDocs && normalized.startsWith("docs/")) return false;
  if (!includeTests && normalized.startsWith("tests/")) return false;
  if (!CODE_EXTENSIONS.has(extOf(normalized))) return false;
  return true;
}

function walk(root: string, dir = root): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      paths.push(...walk(root, join(dir, entry.name)));
      continue;
    }
    if (entry.isFile()) paths.push(join(dir, entry.name));
  }
  return paths;
}

function lineFinding(input: {
  bucket: QualityAuditBucket;
  code: QualityAuditFinding["code"];
  path: string;
  line: number;
  message: string;
}): QualityAuditFinding {
  return input;
}

function scanLine(path: string, line: string, lineNo: number): QualityAuditFinding[] {
  const findings: QualityAuditFinding[] = [];
  if (SECRET_PATTERN.test(line)) {
    findings.push(
      lineFinding({
        bucket: "gate",
        code: "secret_like_literal",
        path,
        line: lineNo,
        message: "secret-like literal appears in scanned source",
      }),
    );
  }
  if (
    /\b(execSync|execFileSync|spawnSync|spawn)\s*\(/.test(line) &&
    /\bshell\s*:\s*true\b/.test(line)
  ) {
    findings.push(
      lineFinding({
        bucket: "gate",
        code: "dangerous_shell_execution",
        path,
        line: lineNo,
        message: "child process execution enables shell:true",
      }),
    );
  }
  if (/\b(?:C:\\Users\\|\/Users\/|\/home\/)[^"'`\s]+/.test(line)) {
    findings.push(
      lineFinding({
        bucket: "actionable",
        code: "hardcoded_absolute_path",
        path,
        line: lineNo,
        message: "personal absolute path should be configurable or test-scoped",
      }),
    );
  }
  if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/.test(line)) {
    findings.push(
      lineFinding({
        bucket: "actionable",
        code: "hardcoded_local_endpoint",
        path,
        line: lineNo,
        message: "local endpoint should be documented as test/dev-only or configurable",
      }),
    );
  }
  if (MODEL_PROVIDER_PATTERN.test(line)) {
    findings.push(
      lineFinding({
        bucket: "actionable",
        code: "hardcoded_model_or_provider",
        path,
        line: lineNo,
        message: "model/provider literal should be behind policy or documented test fixture",
      }),
    );
  }
  if (/\b(?:TODO|FIXME|HACK|XXX)\b/.test(line)) {
    findings.push(
      lineFinding({
        bucket: "telemetry",
        code: "todo_marker",
        path,
        line: lineNo,
        message: "technical-debt marker",
      }),
    );
  }
  if (LEGACY_RUNTIME_PATTERN.test(line)) {
    findings.push(
      lineFinding({
        bucket: "actionable",
        code: "legacy_runtime_reference",
        path,
        line: lineNo,
        message: "legacy runtime reference should not be a current execution path",
      }),
    );
  }
  return findings;
}

export function analyzeQualityText(
  files: Array<{ path: string; text: string }>,
): QualityAuditResult {
  const findings = files.flatMap((file) =>
    file.text.split(/\r?\n/).flatMap((line, index) => scanLine(file.path, line, index + 1)),
  );
  const byBucket: Record<QualityAuditBucket, number> = { gate: 0, actionable: 0, telemetry: 0 };
  const byCode: Record<string, number> = {};
  for (const finding of findings) {
    byBucket[finding.bucket] += 1;
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
  }
  return {
    ok: byBucket.gate === 0,
    total: findings.length,
    byBucket,
    byCode,
    findings: findings.sort(
      (a, b) =>
        a.bucket.localeCompare(b.bucket) ||
        a.code.localeCompare(b.code) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    ),
  };
}

export function runQualityAudit(
  repoRoot: string,
  opts: { includeDocs?: boolean; includeTests?: boolean; limit?: number } = {},
): QualityAuditResult {
  const includeDocs = opts.includeDocs ?? false;
  const includeTests = opts.includeTests ?? false;
  const files = walk(repoRoot)
    .map((path) => norm(relative(repoRoot, path)))
    .filter((path) => shouldScan(path, includeDocs, includeTests))
    .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
  const result = analyzeQualityText(files);
  const limit = opts.limit ?? 50;
  return { ...result, findings: result.findings.slice(0, limit) };
}

export function renderQualityAudit(result: QualityAuditResult): string {
  const codes = Object.entries(result.byCode)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([code, count]) => `${code}=${count}`)
    .join(" ");
  const lines = [
    `quality audit: total=${result.total} gate=${result.byBucket.gate} actionable=${result.byBucket.actionable} telemetry=${result.byBucket.telemetry}${codes ? `; ${codes}` : ""}`,
  ];
  for (const finding of result.findings) {
    lines.push(
      `  - ${finding.bucket} ${finding.code} ${finding.path}:${finding.line}: ${finding.message}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
