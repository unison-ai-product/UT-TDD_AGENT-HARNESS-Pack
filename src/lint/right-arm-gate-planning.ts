/**
 * Right-arm gate planning lint.
 *
 * G8-G14 were intentionally left concept-only while the right-arm gate model was
 * being stabilized. Once that carry was observed as IMP-052, the unsafe state is
 * not "future implementation remains"; it is "future implementation remains
 * without a concrete PLAN route". This lint keeps that route machine-checked.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBacklogEntries } from "./improvement-backlog";

export interface RightArmGatePlanningInput {
  gatesMd: string;
  backlogMd: string;
  concretePlanRefs?: string[];
}

export interface RightArmGatePlanningResult {
  ok: boolean;
  imp052Present: boolean;
  imp052Status: string | null;
  planRefs: string[];
  gatesStillUnplanned: boolean;
  violations: string[];
}

const PLAN_REF = /PLAN-(?:L\d+|REVERSE)-[A-Za-z0-9._-]+/g;
const REQUIRED_PLAN_REFS = [
  "PLAN-L7-130-right-arm-gate-planning",
  "PLAN-REVERSE-130-right-arm-gate-planning",
] as const;

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function loadRightArmGatePlanningInput(repoRoot = process.cwd()): RightArmGatePlanningInput {
  const concretePlanRefs = REQUIRED_PLAN_REFS.filter((planId) =>
    existsSync(resolve(repoRoot, "docs/plans", `${planId}.md`)),
  );
  return {
    gatesMd: readFileSync(resolve(repoRoot, "docs/process/gates.md"), "utf8"),
    backlogMd: readFileSync(resolve(repoRoot, "docs/improvement-backlog.md"), "utf8"),
    concretePlanRefs,
  };
}

export function analyzeRightArmGatePlanning(
  input: RightArmGatePlanningInput,
): RightArmGatePlanningResult {
  const entries = parseBacklogEntries(input.backlogMd);
  const imp052 = entries.find((entry) => entry.id === "IMP-052");
  const imp052Text = imp052 ? `${imp052.issue}\n${imp052.link}` : "";
  const g8g14Text = input.gatesMd.match(/G8-G14[\s\S]{0,700}/)?.[0] ?? "";
  const planRefs = unique([
    ...(g8g14Text.match(PLAN_REF) ?? []),
    ...(imp052Text.match(PLAN_REF) ?? []),
    ...(input.concretePlanRefs ?? []),
  ]);
  const gatesStillUnplanned = /G8-G14[\s\S]{0,300}未起票/.test(input.gatesMd);
  const violations: string[] = [];

  if (!imp052) {
    violations.push("IMP-052 is missing from docs/improvement-backlog.md");
  }
  if (imp052?.status === "observed" && planRefs.length === 0) {
    violations.push("IMP-052 is still observed instead of routed to a concrete PLAN");
  }
  if (planRefs.length === 0) {
    violations.push("G8-G14 mechanization carry has no PLAN reference");
  }
  if (gatesStillUnplanned && planRefs.length === 0) {
    violations.push("docs/process/gates.md still marks G8-G14 mechanization as unplanned");
  }

  return {
    ok: violations.length === 0,
    imp052Present: Boolean(imp052),
    imp052Status: imp052?.status ?? null,
    planRefs,
    gatesStillUnplanned,
    violations,
  };
}

export function rightArmGatePlanningMessages(result: RightArmGatePlanningResult): string[] {
  if (result.ok) {
    return [
      `right-arm-gate-planning - OK (IMP-052=${result.imp052Status}, plans=${result.planRefs.join(", ")})`,
    ];
  }
  return [`right-arm-gate-planning - violation: ${result.violations.join("; ")}`];
}
