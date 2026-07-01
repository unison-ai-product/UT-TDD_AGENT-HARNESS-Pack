import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface DesignLanguageDoc {
  path: string;
  text: string;
}

export interface DesignLanguageViolation {
  path: string;
  line: number;
  excerpt: string;
  reason: "english-heading" | "english-prose";
}

export interface DesignLanguageResult {
  checked: number;
  violations: DesignLanguageViolation[];
  ok: boolean;
}

const DESIGN_LANGUAGE_ROOTS = [
  join("docs", "adr"),
  join("docs", "design"),
  join("docs", "governance"),
] as const;

const JAPANESE_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]/;
const ENGLISH_WORD_PATTERN = /\b[A-Za-z][A-Za-z'-]{2,}\b/g;
const INLINE_CODE_PATTERN = /`[^`]*`/g;
const URL_PATTERN = /https?:\/\/\S+/g;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

const TECHNICAL_WORD_ALLOWLIST = new Set([
  "ADR",
  "API",
  "ASCII",
  "Bun",
  "CI",
  "CLI",
  "Codex",
  "Claude",
  "DB",
  "DDD",
  "DoD",
  "FR",
  "GWT",
  "ID",
  "JSON",
  "LTS",
  "MCP",
  "PLAN",
  "PO",
  "PR",
  "README",
  "SSoT",
  "SQL",
  "TDD",
  "TS",
  "UI",
  "URL",
  "UT",
  "VRT",
  "YAML",
]);

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/");
}

function walkMarkdown(absDir: string, repoRoot: string, acc: DesignLanguageDoc[]): void {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(abs, repoRoot, acc);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!statSync(abs).isFile()) continue;
    acc.push({ path: normalizeRel(relative(repoRoot, abs)), text: readFileSync(abs, "utf8") });
  }
}

export function loadDesignLanguageDocs(repoRoot: string = process.cwd()): DesignLanguageDoc[] {
  const docs: DesignLanguageDoc[] = [];
  for (const rel of DESIGN_LANGUAGE_ROOTS) {
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) walkMarkdown(abs, repoRoot, docs);
  }
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function stripNonProse(line: string): string {
  return line
    .replace(HTML_COMMENT_PATTERN, " ")
    .replace(INLINE_CODE_PATTERN, " ")
    .replace(URL_PATTERN, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/[`*_~>|#:[\](),.;/\\{}=+-]/g, " ");
}

function countEnglishWords(line: string): number {
  const words = stripNonProse(line).match(ENGLISH_WORD_PATTERN) ?? [];
  return words.filter((word) => !TECHNICAL_WORD_ALLOWLIST.has(word)).length;
}

function isFrontmatterLine(line: string, inFrontmatter: boolean): boolean {
  if (line.trim() === "---") return true;
  if (!inFrontmatter) return false;
  return /^[A-Za-z0-9_-]+:/.test(line.trim()) || /^\s+-\s+/.test(line);
}

function shouldIgnoreLine(line: string, inFrontmatter: boolean): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (isFrontmatterLine(line, inFrontmatter)) return true;
  if (/^[-|: ]+$/.test(trimmed)) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^<!--/.test(trimmed)) return true;
  if (!/[A-Za-z]/.test(trimmed)) return true;
  return JAPANESE_PATTERN.test(trimmed);
}

export function analyzeDesignLanguage(docs: DesignLanguageDoc[]): DesignLanguageResult {
  const violations: DesignLanguageViolation[] = [];
  for (const doc of docs) {
    let inCode = false;
    let inFrontmatter = false;
    const lines = doc.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (index === 0 && trimmed === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter && index > 0 && trimmed === "---") {
        inFrontmatter = false;
        continue;
      }
      if (/^```/.test(trimmed)) {
        inCode = !inCode;
        continue;
      }
      if (inCode || shouldIgnoreLine(line, inFrontmatter)) continue;
      const words = countEnglishWords(line);
      const isHeading = /^#{1,6}\s+/.test(trimmed);
      const threshold = isHeading ? 2 : 4;
      if (words < threshold) continue;
      violations.push({
        path: doc.path,
        line: index + 1,
        excerpt: trimmed.slice(0, 120),
        reason: isHeading ? "english-heading" : "english-prose",
      });
    }
  }
  return { checked: docs.length, violations, ok: violations.length === 0 };
}

export function designLanguageMessages(result: DesignLanguageResult): string[] {
  if (result.ok) {
    return [`design-language - OK (design/governance/ADR docs ${result.checked}, english prose 0)`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.reason}`)
    .join(", ");
  return [
    `design-language - violation: english prose ${result.violations.length}件 (${sample})。設計系 doc は日本語 prose を正本とし、英語は識別子/開発用語に限る`,
  ];
}
