import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizePath } from "../lint/shared";
import {
  REFACTOR_CANDIDATE_THRESHOLDS,
  REFACTOR_POLICY_TERMS,
  REFACTOR_SCAN_ROOTS,
} from "./refactor-candidate-policy";

export type RefactorCandidateKind =
  | "split-module"
  | "extract-helper"
  | "deduplicate-function"
  | "externalize-literal"
  | "externalize-policy";

export interface RefactorCandidate {
  kind: RefactorCandidateKind;
  path: string;
  subject: string;
  score: number;
  threshold: number;
  confidence: "high" | "medium";
  reason: string;
}

export const REFACTOR_FEEDBACK_LIMIT = 20;

const {
  splitModuleLines: SPLIT_MODULE_LINE_THRESHOLD,
  splitModuleExports: SPLIT_MODULE_EXPORT_THRESHOLD,
  extractHelperLines: EXTRACT_HELPER_LINE_THRESHOLD,
  dedupeFunctionMinLines: DEDUPE_FUNCTION_MIN_LINES,
  externalizeLiteralMinRepeats: EXTERNALIZE_LITERAL_MIN_REPEATS,
  externalizeLiteralMinLength: EXTERNALIZE_LITERAL_MIN_LENGTH,
  externalizePolicy: EXTERNALIZE_POLICY_THRESHOLD,
  externalizePolicyMaxBranchPoints: EXTERNALIZE_POLICY_MAX_BRANCH_POINTS,
} = REFACTOR_CANDIDATE_THRESHOLDS;

function stableHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(path);
  }
  return out.sort();
}

export function loadRefactorCandidateInputs(repoRoot: string): Array<{
  path: string;
  content: string;
}> {
  return REFACTOR_SCAN_ROOTS.flatMap((root) =>
    sourceFiles(join(repoRoot, root)).map((path) => ({
      path: normalizePath(relative(repoRoot, path)),
      content: readFileSync(path, "utf8"),
    })),
  );
}

function stripTsComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function normalizedBody(body: string): string {
  return body
    .replace(/\s+/g, " ")
    .replace(/["'`][^"'`]*["'`]/g, '""')
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .trim();
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function collectFunctionBodies(text: string): Array<{ name: string; body: string; lines: number }> {
  const functions: Array<{ name: string; body: string; lines: number }> = [];
  const stripped = stripTsComments(text);
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      const close = findMatchingBrace(stripped, open);
      if (close < 0) continue;
      const body = stripped.slice(open + 1, close);
      functions.push({
        name: match[1] ?? "anonymous",
        body,
        lines: body.split(/\r?\n/).filter((line) => line.trim()).length,
      });
    }
  }
  return functions;
}

function collectStringLiterals(text: string): string[] {
  const stripped = stripTsComments(text);
  const literals: string[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const quote = stripped[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let value = "";
    let closed = false;
    for (let j = i + 1; j < stripped.length; j++) {
      const ch = stripped[j];
      if (ch === "\n" || ch === "\r") break;
      if (ch === "\\") {
        j++;
        if (j < stripped.length) value += stripped[j];
        continue;
      }
      if (ch === quote) {
        closed = true;
        i = j;
        break;
      }
      value += ch;
    }
    const literal = value.trim();
    if (closed && literal.length >= EXTERNALIZE_LITERAL_MIN_LENGTH) {
      const isTemplateExpression = literal.includes("${");
      const isIdentifierLike = /^[a-z][a-z0-9_:-]*$/.test(literal);
      const isCliFlag = literal.startsWith("--");
      const isPlainDocPath = /^docs\/.+\.md$/.test(literal);
      if (!isTemplateExpression && !isIdentifierLike && !isCliFlag && !isPlainDocPath) {
        literals.push(literal);
      }
    }
  }
  return literals;
}

function policyTermHits(text: string): string[] {
  const lower = text.toLowerCase();
  return REFACTOR_POLICY_TERMS.filter((term) => new RegExp(`\\b${term}\\b`).test(lower));
}

function branchCount(text: string): number {
  return (
    (text.match(/\bif\s*\(/g) ?? []).length +
    (text.match(/\belse\s+if\s*\(/g) ?? []).length +
    (text.match(/\bswitch\s*\(/g) ?? []).length * 2 +
    (text.match(/\bcase\s+["'`A-Za-z0-9_-]+/g) ?? []).length
  );
}

function collectExternalizedPolicyCandidates(file: {
  path: string;
  content: string;
  allPaths: ReadonlySet<string>;
}): RefactorCandidate[] {
  if (file.path === "src/state-db/refactor-candidates.ts") return [];
  if (/(?:catalog|data|policy|routing-contracts|model-policy)\.ts$/.test(file.path)) return [];
  const policyPath = file.path.replace(/\.ts$/, "-policy.ts");
  if (file.allPaths.has(policyPath)) return [];
  const stripped = stripTsComments(file.content);
  const hits = policyTermHits(stripped);
  if (hits.length < 3) return [];
  const branches = branchCount(stripped);
  const hasStageInjectionPolicy =
    /\b(?:stage|phase)\b/i.test(stripped) &&
    /\b(?:inject|injection|subagent|agent|skill)\b/i.test(stripped);
  const hasRoutingPolicy =
    /\b(?:route|approval|model|tier|profile)\b/i.test(stripped) && branches >= 2;
  if (!hasStageInjectionPolicy && !hasRoutingPolicy) return [];
  const score = hits.length + branches;
  if (score < EXTERNALIZE_POLICY_THRESHOLD) return [];
  if (branches > EXTERNALIZE_POLICY_MAX_BRANCH_POINTS) return [];
  return [
    {
      kind: "externalize-policy",
      path: file.path,
      subject: `${file.path}#policy:${stableHash(hits.join(":")).slice(0, 19)}`,
      score,
      threshold: EXTERNALIZE_POLICY_THRESHOLD,
      confidence: hasStageInjectionPolicy && branches >= 2 && branches <= 20 ? "high" : "medium",
      reason: `policy terms (${hits.join(", ")}) appear with ${branches} branch point(s); consider catalog/config/rule externalization`,
    },
  ];
}

function candidateConfidence(
  kind: RefactorCandidateKind,
  score: number,
  threshold: number,
): "high" | "medium" {
  if (kind === "deduplicate-function") return "high";
  if (kind === "split-module") {
    if (threshold === SPLIT_MODULE_EXPORT_THRESHOLD) return "medium";
    return score >= threshold * 1.25 ? "high" : "medium";
  }
  if (kind === "extract-helper") return score >= threshold * 1.2 ? "high" : "medium";
  return score >= threshold * 2 ? "high" : "medium";
}

function splitModuleConfidence(input: {
  score: number;
  threshold: number;
  functions: Array<{ lines: number }>;
  declarativeCatalog: boolean;
}): "high" | "medium" {
  if (input.declarativeCatalog) return "medium";
  if (input.threshold === SPLIT_MODULE_EXPORT_THRESHOLD) return "medium";
  const hasLargeFunction = input.functions.some((fn) => fn.lines >= EXTRACT_HELPER_LINE_THRESHOLD);
  const isExtremeModule = input.score >= input.threshold * 4;
  return hasLargeFunction || isExtremeModule
    ? candidateConfidence("split-module", input.score, input.threshold)
    : "medium";
}

function isDeclarativeCatalogModule(
  file: { path: string; content: string },
  functionCount: number,
): boolean {
  if (functionCount > 2) return false;
  if (!/(?:catalog|data|schema|schema\/harness-db)\.ts$/.test(file.path)) return false;
  const stripped = stripTsComments(file.content);
  const exportFunctionCount = (stripped.match(/\bexport\s+function\s+/g) ?? []).length;
  const typeExportCount = (stripped.match(/\bexport\s+(?:type|interface)\s+/g) ?? []).length;
  const valueExportCount = (stripped.match(/\bexport\s+(?:const|let|var)\s+/g) ?? []).length;
  return exportFunctionCount <= 1 && valueExportCount + typeExportCount > 0;
}

function isExportCatalogExempt(file: { path: string }): boolean {
  return file.path === "src/schema/index.ts";
}

export function candidateRank(candidate: RefactorCandidate): number {
  const confidenceBoost = candidate.confidence === "high" ? 1000 : 0;
  const kindBoost =
    candidate.kind === "deduplicate-function"
      ? 300
      : candidate.kind === "split-module"
        ? 200
        : candidate.kind === "extract-helper"
          ? 100
          : 0;
  return confidenceBoost + kindBoost + candidate.score / Math.max(candidate.threshold, 1);
}

export function analyzeRefactorCandidates(
  files: Array<{ path: string; content: string }>,
): RefactorCandidate[] {
  const candidates: RefactorCandidate[] = [];
  const bodyIndex = new Map<string, Array<{ path: string; name: string; lines: number }>>();
  const allPaths = new Set(files.map((file) => file.path));

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    const nonBlankLineCount = lines.filter((line) => line.trim()).length;
    const stripped = stripTsComments(file.content);
    const exportCount = (stripped.match(/\bexport\s+/g) ?? []).length;
    const functions = collectFunctionBodies(file.content);
    const declarativeCatalog = isDeclarativeCatalogModule(file, functions.length);
    if (
      nonBlankLineCount >= SPLIT_MODULE_LINE_THRESHOLD ||
      (exportCount >= SPLIT_MODULE_EXPORT_THRESHOLD && !isExportCatalogExempt(file))
    ) {
      const isLineTriggered = nonBlankLineCount >= SPLIT_MODULE_LINE_THRESHOLD;
      const score = isLineTriggered ? nonBlankLineCount : exportCount;
      const threshold = isLineTriggered
        ? SPLIT_MODULE_LINE_THRESHOLD
        : SPLIT_MODULE_EXPORT_THRESHOLD;
      candidates.push({
        kind: "split-module",
        path: file.path,
        subject: file.path,
        score,
        threshold,
        confidence: splitModuleConfidence({ score, threshold, functions, declarativeCatalog }),
        reason: `module has ${nonBlankLineCount} nonblank line(s) and ${exportCount} export(s)`,
      });
    }

    for (const fn of functions) {
      if (fn.lines >= EXTRACT_HELPER_LINE_THRESHOLD) {
        candidates.push({
          kind: "extract-helper",
          path: file.path,
          subject: `${file.path}#${fn.name}`,
          score: fn.lines,
          threshold: EXTRACT_HELPER_LINE_THRESHOLD,
          confidence: candidateConfidence(
            "extract-helper",
            fn.lines,
            EXTRACT_HELPER_LINE_THRESHOLD,
          ),
          reason: `function ${fn.name} has ${fn.lines} nonblank line(s)`,
        });
      }
      if (fn.lines >= DEDUPE_FUNCTION_MIN_LINES) {
        const key = normalizedBody(fn.body);
        if (key.length > 0) {
          const bucket = bodyIndex.get(key) ?? [];
          bucket.push({ path: file.path, name: fn.name, lines: fn.lines });
          bodyIndex.set(key, bucket);
        }
      }
    }

    const literalCounts = new Map<string, number>();
    for (const literal of collectStringLiterals(file.content)) {
      literalCounts.set(literal, (literalCounts.get(literal) ?? 0) + 1);
    }
    for (const [literal, count] of literalCounts) {
      if (count >= EXTERNALIZE_LITERAL_MIN_REPEATS) {
        candidates.push({
          kind: "externalize-literal",
          path: file.path,
          subject: `${file.path}#literal:${stableHash(literal).slice(0, 19)}`,
          score: count,
          threshold: EXTERNALIZE_LITERAL_MIN_REPEATS,
          confidence: candidateConfidence(
            "externalize-literal",
            count,
            EXTERNALIZE_LITERAL_MIN_REPEATS,
          ),
          reason: `literal appears ${count} time(s); consider a named constant or config boundary`,
        });
      }
    }

    candidates.push(...collectExternalizedPolicyCandidates({ ...file, allPaths }));
  }

  for (const matches of bodyIndex.values()) {
    const paths = new Set(matches.map((m) => `${m.path}#${m.name}`));
    if (paths.size < 2) continue;
    const sorted = [...matches].sort((a, b) =>
      `${a.path}#${a.name}`.localeCompare(`${b.path}#${b.name}`),
    );
    const subject = sorted.map((m) => `${m.path}#${m.name}`).join(",");
    candidates.push({
      kind: "deduplicate-function",
      path: sorted[0]?.path ?? "",
      subject,
      score: sorted.length,
      threshold: 2,
      confidence: candidateConfidence("deduplicate-function", sorted.length, 2),
      reason: `duplicate function body appears in ${sorted.length} function(s): ${subject}`,
    });
  }

  return candidates.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject),
  );
}
