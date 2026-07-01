import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmValue, normalizePath } from "./shared";

const DONE_STATUSES = new Set(["confirmed", "completed"]);

export interface PlanDodDoc {
  path: string;
  planId: string;
  status: string;
  text: string;
}

export interface PlanDodViolation {
  planId: string;
  path: string;
  line: number;
  item: string;
}

export interface PlanDodResult {
  checked: number;
  violations: PlanDodViolation[];
  ok: boolean;
}

function planFiles(root: string): string[] {
  const dir = join(root, "docs", "plans");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^PLAN-L7-.*\.md$/.test(name))
    .map((name) => join(dir, name))
    .sort();
}

export function loadPlanDodDocs(root = process.cwd()): PlanDodDoc[] {
  return planFiles(root).map((path) => {
    const text = readFileSync(path, "utf8");
    return {
      path: normalizePath(path),
      planId: fmValue(text, "plan_id") ?? path.replace(/\.md$/, ""),
      status: fmValue(text, "status") ?? "unknown",
      text,
    };
  });
}

function dodLineRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) =>
    /^##\s+.*(?:DoD|Definition of Done|完了条件)/i.test(line),
  );
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return { start, end: next < 0 ? lines.length : next };
}

export function analyzePlanDod(docs: PlanDodDoc[]): PlanDodResult {
  const violations: PlanDodViolation[] = [];
  let checked = 0;

  for (const doc of docs) {
    if (!DONE_STATUSES.has(doc.status)) continue;
    checked += 1;
    const lines = doc.text.split(/\r?\n/);
    const range = dodLineRange(lines);
    if (!range) continue;
    for (let index = range.start + 1; index < range.end; index += 1) {
      const item = lines[index].match(/^\s*-\s*\[ \]\s+(.+?)\s*$/)?.[1];
      if (!item) continue;
      violations.push({
        planId: doc.planId,
        path: doc.path,
        line: index + 1,
        item,
      });
    }
  }

  return { checked, violations, ok: violations.length === 0 };
}

export function planDodMessages(result: PlanDodResult): string[] {
  if (result.checked === 0) {
    return ["plan-dod - violation: confirmed/completed L7 PLAN not found"];
  }
  if (result.ok) {
    return [`plan-dod - OK (confirmed/completed L7 PLAN DoD checked: ${result.checked})`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.planId}:${v.line}`)
    .join(", ");
  return [
    `plan-dod - violation: confirmed/completed L7 PLAN has unchecked DoD ${result.violations.length}件 (${sample})`,
  ];
}
