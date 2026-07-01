import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadChangedFiles } from "./change-impact";
import { normalizePath } from "./shared";

export type BranchKind =
  | "feature"
  | "design"
  | "research"
  | "poc"
  | "reverse"
  | "add"
  | "hotfix"
  | "refactor"
  | "docs"
  | "chore"
  | "none";

export interface BranchPlanDoc {
  file: string;
  plan_id?: string;
  kind?: string;
  github_issue_id?: unknown;
}

export interface BranchKindInput {
  branch: string | null;
  changedPaths: string[];
  plans: BranchPlanDoc[];
}

export interface BranchKindFinding {
  code: "missing_plan" | "kind_mismatch" | "skill_doc_plan_missing" | "missing_github_issue_id";
  severity: "error" | "warn";
  message: string;
  file?: string;
}

export interface BranchKindResult {
  branch: string | null;
  kind: BranchKind;
  findings: BranchKindFinding[];
  ok: boolean;
}

const REQUIRED_KIND_BY_BRANCH: Record<
  Exclude<BranchKind, "docs" | "chore" | "none">,
  readonly string[]
> = {
  feature: ["impl"],
  design: ["design", "charter"],
  research: ["research"],
  poc: ["poc"],
  reverse: ["reverse"],
  add: ["add-design", "add-impl"],
  hotfix: ["recovery", "troubleshoot"],
  refactor: ["refactor", "retrofit"],
};

export function classifyBranchKind(branch: string | null): BranchKind {
  if (!branch) return "none";
  const prefix = branch.split("/", 1)[0];
  if (
    prefix === "feature" ||
    prefix === "design" ||
    prefix === "research" ||
    prefix === "poc" ||
    prefix === "reverse" ||
    prefix === "add" ||
    prefix === "hotfix" ||
    prefix === "refactor" ||
    prefix === "docs" ||
    prefix === "chore"
  ) {
    return prefix;
  }
  return "none";
}

function isRequiredKind(kind: BranchKind): kind is keyof typeof REQUIRED_KIND_BY_BRANCH {
  return Object.hasOwn(REQUIRED_KIND_BY_BRANCH, kind);
}

function hasGithubIssueId(plan: BranchPlanDoc): boolean {
  return typeof plan.github_issue_id === "number" && Number.isInteger(plan.github_issue_id);
}

export function analyzeBranchKind(input: BranchKindInput): BranchKindResult {
  const kind = classifyBranchKind(input.branch);
  const changedPaths = input.changedPaths.map(normalizePath);
  const plans = input.plans;
  const findings: BranchKindFinding[] = [];

  if (kind === "docs" || kind === "chore") {
    const touchesSkillDocs = changedPaths.some((p) => /^docs\/skills\/.+\.md$/.test(p));
    if (touchesSkillDocs && plans.length === 0) {
      findings.push({
        code: "skill_doc_plan_missing",
        severity: "error",
        message: `${kind} branch changes docs/skills but no PLAN was touched`,
      });
    }
    return {
      branch: input.branch,
      kind,
      findings,
      ok: !findings.some((f) => f.severity === "error"),
    };
  }

  if (!isRequiredKind(kind)) {
    return { branch: input.branch, kind, findings, ok: true };
  }

  const allowedKinds = REQUIRED_KIND_BY_BRANCH[kind];
  if (plans.length === 0) {
    findings.push({
      code: "missing_plan",
      severity: "error",
      message: `${kind} branch requires at least one touched PLAN`,
    });
  }

  for (const plan of plans) {
    if (!plan.kind || !allowedKinds.includes(plan.kind)) {
      findings.push({
        code: "kind_mismatch",
        severity: "error",
        file: plan.file,
        message: `${input.branch ?? "(unknown)"} expects PLAN kind ${allowedKinds.join("|")} but ${plan.file} has ${plan.kind ?? "(missing)"}`,
      });
    }
    if ((kind === "feature" || kind === "hotfix") && !hasGithubIssueId(plan)) {
      findings.push({
        code: "missing_github_issue_id",
        severity: "warn",
        file: plan.file,
        message: `${plan.file} should set github_issue_id for PR Closes # linkage`,
      });
    }
  }

  return {
    branch: input.branch,
    kind,
    findings,
    ok: !findings.some((f) => f.severity === "error"),
  };
}

function markdownFrontmatter(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

function loadPlanDoc(repoRoot: string, file: string): BranchPlanDoc | null {
  const raw = markdownFrontmatter(readFileSync(join(repoRoot, file), "utf8"));
  if (!raw) return { file };
  const fm = parseYaml(raw) as Record<string, unknown>;
  return {
    file,
    plan_id: typeof fm.plan_id === "string" ? fm.plan_id : undefined,
    kind: typeof fm.kind === "string" ? fm.kind : undefined,
    github_issue_id: fm.github_issue_id,
  };
}

export function loadBranchKindInput(repoRoot: string = process.cwd()): BranchKindInput {
  let branch: string | null = null;
  try {
    branch = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    branch = null;
  }

  let changedPaths: string[] = [];
  try {
    changedPaths = loadChangedFiles(repoRoot);
  } catch {
    changedPaths = [];
  }

  const planPaths = changedPaths
    .map(normalizePath)
    .filter((p) => /^docs\/plans\/PLAN-.+\.md$/.test(p));
  const plans = planPaths
    .map((p) => {
      try {
        return loadPlanDoc(repoRoot, p);
      } catch {
        return { file: p };
      }
    })
    .filter((p): p is BranchPlanDoc => p != null);

  return { branch, changedPaths, plans };
}

export function branchKindMessages(result: BranchKindResult): string[] {
  const hard = result.findings.filter((f) => f.severity === "error");
  const warn = result.findings.filter((f) => f.severity === "warn");
  if (hard.length === 0) {
    return [
      `branch-kind-check - OK (branch=${result.branch ?? "-"}, kind=${result.kind}, warnings=${warn.length})`,
      ...warn.map((f) => `branch-kind-check - warn ${f.code}: ${f.message}`),
    ];
  }
  return [
    `branch-kind-check - violation: errors=${hard.length}, warnings=${warn.length}`,
    ...hard.map((f) => `branch-kind-check - block ${f.code}: ${f.message}`),
    ...warn.map((f) => `branch-kind-check - warn ${f.code}: ${f.message}`),
  ];
}
