import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SECRET_PATTERN } from "../secret.ts";

export interface SecretScanArtifact {
  path: string;
  text: string;
}

export interface SecretScanViolation {
  path: string;
  line: number;
  marker: string;
}

export interface SecretScanResult {
  checked: number;
  violations: SecretScanViolation[];
  ok: boolean;
}

const SECRET_SCAN_PATTERNS: { marker: string; pattern: RegExp }[] = [
  { marker: "narrow-secret-token", pattern: SECRET_PATTERN },
  { marker: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { marker: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/ },
  { marker: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    marker: "authorization-bearer",
    pattern: /\bAuthorization\s*:\s*Bearer\s+["']?[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    marker: "secret-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|secret|credential|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  },
];

const ALLOW_LINE_MARKERS =
  /\b(dummy|placeholder|redacted|example|fake|fixture|test-only|not-a-secret|dummy-secret|<redacted>|\*\*\*)\b/i;

function firstMatchLine(text: string, pattern: RegExp): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(line) && !ALLOW_LINE_MARKERS.test(line)) return i + 1;
  }
  return null;
}

export function analyzeSecretScan(artifacts: SecretScanArtifact[]): SecretScanResult {
  const violations: SecretScanViolation[] = [];
  for (const artifact of artifacts) {
    for (const { marker, pattern } of SECRET_SCAN_PATTERNS) {
      const line = firstMatchLine(artifact.text, pattern);
      if (line !== null) violations.push({ path: artifact.path, line, marker });
    }
  }
  return { checked: artifacts.length, violations, ok: violations.length === 0 };
}

function readArtifact(fullPath: string, relPath: string): SecretScanArtifact {
  return { path: relPath.replaceAll("\\", "/"), text: readFileSync(fullPath, "utf8") };
}

interface WalkContext {
  repoRoot: string;
  extensions: readonly string[];
  acc: SecretScanArtifact[];
}

function walkFiles(dir: string, ctx: WalkContext): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, ctx);
      continue;
    }
    if (!ctx.extensions.some((ext) => name.endsWith(ext))) continue;
    ctx.acc.push(readArtifact(full, relative(ctx.repoRoot, full)));
  }
}

const ROOT_SECRET_SCAN_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", join(".claude", "CLAUDE.md")];

const SECRET_SCAN_DIRS: { rel: string; extensions: readonly string[] }[] = [
  { rel: "docs", extensions: [".md", ".json", ".yaml", ".yml"] },
  { rel: join(".ut-tdd", "audit"), extensions: [".md"] },
  { rel: join(".ut-tdd", "handover"), extensions: [".json", ".md"] },
  { rel: join(".ut-tdd", "logs"), extensions: [".json", ".md"] },
  { rel: join(".ut-tdd", "memory"), extensions: [".md"] },
];

export function loadSystemSecretScanArtifacts(
  repoRoot: string = process.cwd(),
): SecretScanArtifact[] {
  const acc: SecretScanArtifact[] = [];
  for (const { rel, extensions } of SECRET_SCAN_DIRS) {
    const dir = join(repoRoot, rel);
    if (existsSync(dir)) walkFiles(dir, { repoRoot, extensions, acc });
  }
  for (const rel of ROOT_SECRET_SCAN_DOCS) {
    const full = join(repoRoot, rel);
    if (existsSync(full)) acc.push(readArtifact(full, rel));
  }
  return acc.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadSecretScanArtifactsForPaths(
  repoRoot: string,
  paths: readonly string[],
): SecretScanArtifact[] {
  return paths
    .filter((path) => /\.(md|json|ya?ml|ts|tsx|js|mjs|cjs|sh|ps1|toml|txt)$/.test(path))
    .filter((path) => existsSync(join(repoRoot, ...path.split("/"))))
    .map((path) => readArtifact(join(repoRoot, ...path.split("/")), path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function secretScanMessages(result: SecretScanResult): string[] {
  if (result.ok) return [`secret-scan — OK (artifacts ${result.checked}件 credential marker 0)`];
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.marker}`)
    .join(", ");
  return [
    `secret-scan — violation credential markers ${result.violations.length}件 (${sample})。dummy/placeholder 以外の秘密情報は docs/audit/memory/Pack へ入れない`,
  ];
}
