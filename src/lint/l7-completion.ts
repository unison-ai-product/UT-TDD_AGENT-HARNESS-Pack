import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fmValue, normalizePath } from "./shared";

export interface L7CompletionDoc {
  path: string;
  status: string;
  text: string;
}

export interface L7CompletionViolation {
  path: string;
  line: number;
  detail: string;
  sample: string;
}

export interface L7CompletionResult {
  checked: number;
  violations: L7CompletionViolation[];
  ok: boolean;
}

const ACTIVE_STATUSES = new Set(["", "confirmed", "completed"]);
const ACTIVE_DESIGN_DIRS = [
  join("docs", "design", "harness", "L4-basic-design"),
  join("docs", "design", "harness", "L5-detailed-design"),
  join("docs", "design", "harness", "L6-function-design"),
];

function walkMarkdown(root: string, repoRoot: string): L7CompletionDoc[] {
  if (!existsSync(root)) return [];
  const docs: L7CompletionDoc[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      docs.push(...walkMarkdown(full, repoRoot));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const text = readFileSync(full, "utf8");
    docs.push({
      path: normalizePath(relative(repoRoot, full)),
      status: fmValue(text, "status") ?? "",
      text,
    });
  }
  return docs;
}

export function loadL7CompletionDocs(root = process.cwd()): L7CompletionDoc[] {
  return ACTIVE_DESIGN_DIRS.flatMap((dir) => walkMarkdown(join(root, dir), root)).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

function classifyStaleL7Line(line: string): string | null {
  if (/\b(?:remaining|residual|open)\b.*\bL7\s+carry\b/i.test(line)) {
    return "L7 completion summary still says residual work remains";
  }
  if (/\bworkflow orchestration module\b.*\bnot implemented\b/i.test(line)) {
    return "workflow orchestration is still described as not implemented";
  }
  if (/\bCI wiring\b.*\bL7\s+carry\b/i.test(line)) {
    return "CI wiring is still described as L7 carry";
  }
  if (/\bunimplemented module\b|\bmodule\b.*\bnot implemented\b/i.test(line)) {
    return "module boundary is still labeled as unimplemented";
  }
  if (/^\|\s+\*\*L7\.\d+\*\*\s+\|.*\|\s*(?:pending|not implemented)/i.test(line)) {
    return "L7 WBS row still has an unimplemented status";
  }
  if (
    /^\|\s+\*\*(workflow|session|telemetry|hook|review|skill|roster|cutover|adapter)\*\*\s+\|.*not implemented/i.test(
      line,
    )
  ) {
    return "module inventory row still has an unimplemented status";
  }
  if (
    /^\|\s+`ut-tdd (review --uncommitted|skill suggest|cutover --to|asset` \/ `ut-tdd builder)/.test(
      line,
    ) &&
    /\|\s*(?:pending|not implemented)(?:\s|\|)/i.test(line)
  ) {
    return "implemented CLI surface is still marked unimplemented";
  }
  if (/future (workflow|roster|skills?) module/i.test(line)) {
    return "implemented L7 module slice is still described as future module work";
  }
  return null;
}

export function analyzeL7Completion(docs: L7CompletionDoc[]): L7CompletionResult {
  const violations: L7CompletionViolation[] = [];
  let checked = 0;

  for (const doc of docs) {
    if (!ACTIVE_STATUSES.has(doc.status.toLowerCase())) continue;
    checked += 1;
    const lines = doc.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const detail = classifyStaleL7Line(line);
      if (!detail) continue;
      violations.push({
        path: doc.path,
        line: index + 1,
        detail,
        sample: line.trim(),
      });
    }
  }

  return { checked, violations, ok: violations.length === 0 };
}

export function l7CompletionMessages(result: L7CompletionResult): string[] {
  if (result.ok) {
    return [`l7-completion - OK (checked=${result.checked}, stale L7 blockers=0)`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}`)
    .join(", ");
  return [
    `l7-completion - violation: active design still contains stale L7 completion blockers ${result.violations.length} item(s) (${sample})`,
  ];
}
