import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { importedSourceModule, lineOf, normalizePath, sourceModule } from "./shared";

export type DddTddDocScope = "source" | "test";

export interface DddTddDoc {
  path: string;
  text: string;
  scope: DddTddDocScope;
}

export interface DddTddPolicy {
  path: string;
  text: string;
  ruleIds: string[];
}

export interface DddTddWorkflowDoc {
  path: string;
  text: string;
  exists: boolean;
}

export interface DddTddPlanDoc {
  path: string;
  text: string;
}

export interface DddTddInputs {
  policy: DddTddPolicy | null;
  workflowDocs: DddTddWorkflowDoc[];
  docs: DddTddDoc[];
  l7Text: string;
  l8Text: string;
  plans: DddTddPlanDoc[];
}

export interface DddTddViolation {
  path: string;
  line: number;
  rule: string;
  message: string;
}

export interface DddTddResult {
  checked: number;
  baselineDebt: number;
  violations: DddTddViolation[];
  ok: boolean;
}

interface WorkflowRequirement {
  path: string;
  patterns: { pattern: RegExp; message: string }[];
}

interface EvidenceDates {
  redAt: string | null;
  greenAt: string | null;
}

const REQUIRED_RULE_IDS = [
  "domain-boundary",
  "invariant-test-trace",
  "red-first-evidence",
  "test-oracle-strength",
  "integration-gwt",
  "unit-oracle-substance",
];

const REQUIRED_WORKFLOW_DOCS: WorkflowRequirement[] = [
  {
    path: normalizePath(join("docs", "governance", "ddd-tdd-rules.md")),
    patterns: [
      { pattern: /Workflow Placement/, message: "DDD/TDD SSoT must define workflow placement." },
      { pattern: /Forward L6/, message: "DDD/TDD SSoT must anchor Forward L6 timing." },
      { pattern: /Add-feature/, message: "DDD/TDD SSoT must anchor Add-feature timing." },
      { pattern: /L7 Red/, message: "DDD/TDD SSoT must anchor L7 Red evidence." },
    ],
  },
  {
    path: normalizePath(join("docs", "process", "forward", "L00-L06-design-phase.md")),
    patterns: [
      { pattern: /DDD-TDD-WORKFLOW/, message: "Forward workflow must carry DDD/TDD anchor." },
      {
        pattern: /docs\/governance\/ddd-tdd-rules\.md/,
        message: "Forward workflow must reference the DDD/TDD SSoT.",
      },
    ],
  },
  {
    path: normalizePath(join("docs", "process", "modes", "add-feature.md")),
    patterns: [
      {
        pattern: /DDD-TDD-WORKFLOW/,
        message: "Add-feature workflow must carry DDD/TDD anchor.",
      },
      {
        pattern: /docs\/governance\/ddd-tdd-rules\.md/,
        message: "Add-feature workflow must reference the DDD/TDD SSoT.",
      },
      { pattern: /add-design/, message: "Add-feature must place DDD in add-design." },
      { pattern: /add-impl/, message: "Add-feature must place TDD evidence in add-impl." },
    ],
  },
  {
    path: normalizePath(join("docs", "process", "modes", "README.md")),
    patterns: [
      { pattern: /DDD-TDD-WORKFLOW/, message: "Mode index must carry DDD/TDD anchor." },
      {
        pattern: /docs\/governance\/ddd-tdd-rules\.md/,
        message: "Mode index must reference the DDD/TDD SSoT.",
      },
    ],
  },
];

const DISALLOWED_DOMAIN_IMPORTS: Record<string, Set<string>> = {
  lint: new Set(["cli", "doctor", "handover", "runtime", "setup", "team"]),
  runtime: new Set(["cli", "doctor", "lint", "plan", "team", "vmodel"]),
  schema: new Set(["cli", "doctor", "gate", "handover", "lint", "plan", "runtime", "team"]),
};

function collectDocs(repoRoot: string, relDir: string, scope: DddTddDocScope): DddTddDoc[] {
  const root = join(repoRoot, relDir);
  if (!existsSync(root)) return [];
  const docs: DddTddDoc[] = [];
  const visit = (absDir: string, relPrefix: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = normalizePath(join(relPrefix, entry.name));
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath, relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      docs.push({ path: relPath, text: readFileSync(absPath, "utf8"), scope });
    }
  };
  visit(root, relDir);
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function collectPlanDocs(repoRoot: string): DddTddPlanDoc[] {
  const root = join(repoRoot, "docs", "plans");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^PLAN-.*\.md$/.test(name))
    .sort()
    .map((name) => {
      const path = normalizePath(join("docs", "plans", name));
      return { path, text: readFileSync(join(root, name), "utf8") };
    });
}

function maybeRead(repoRoot: string, relPath: string): string {
  const absPath = join(repoRoot, relPath);
  return existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
}

export function loadDddTddPolicy(repoRoot: string = process.cwd()): DddTddPolicy | null {
  const path = normalizePath(join("docs", "governance", "ddd-tdd-rules.md"));
  const absPath = join(repoRoot, path);
  if (!existsSync(absPath)) return null;
  const text = readFileSync(absPath, "utf8");
  const ruleIds = [...text.matchAll(/^\s*-\s+id:\s*([a-z0-9-]+)\s*$/gm)].map((m) => m[1]);
  return { path, text, ruleIds };
}

export function loadDddTddWorkflowDocs(repoRoot: string = process.cwd()): DddTddWorkflowDoc[] {
  return REQUIRED_WORKFLOW_DOCS.map((requirement) => {
    const absPath = join(repoRoot, requirement.path);
    const exists = existsSync(absPath);
    return {
      path: requirement.path,
      text: exists ? readFileSync(absPath, "utf8") : "",
      exists,
    };
  });
}

export function loadDddTddInputs(repoRoot: string = process.cwd()): DddTddInputs {
  return {
    policy: loadDddTddPolicy(repoRoot),
    workflowDocs: loadDddTddWorkflowDocs(repoRoot),
    docs: [...collectDocs(repoRoot, "src", "source"), ...collectDocs(repoRoot, "tests", "test")],
    l7Text: maybeRead(
      repoRoot,
      normalizePath(join("docs", "test-design", "harness", "L7-unit-test-design.md")),
    ),
    l8Text: maybeRead(
      repoRoot,
      normalizePath(join("docs", "test-design", "harness", "L8-integration-test-design.md")),
    ),
    plans: collectPlanDocs(repoRoot),
  };
}

function policyViolations(policy: DddTddPolicy | null): DddTddViolation[] {
  if (!policy) {
    return [
      {
        path: normalizePath(join("docs", "governance", "ddd-tdd-rules.md")),
        line: 1,
        rule: "ddd-tdd-policy-missing",
        message: "DDD/TDD SSoT document is missing.",
      },
    ];
  }
  const declared = new Set(policy.ruleIds);
  const required = new Set(REQUIRED_RULE_IDS);
  const violations: DddTddViolation[] = [];
  for (const id of REQUIRED_RULE_IDS) {
    if (declared.has(id)) continue;
    violations.push({
      path: policy.path,
      line: 1,
      rule: "ddd-tdd-policy-missing-rule",
      message: `DDD/TDD SSoT is missing required rule id ${id}.`,
    });
  }
  for (const id of policy.ruleIds) {
    if (required.has(id)) continue;
    violations.push({
      path: policy.path,
      line: 1,
      rule: "ddd-tdd-policy-unknown-rule",
      message: `DDD/TDD SSoT declares unknown rule id ${id}.`,
    });
  }
  return violations;
}

function workflowViolations(docs: DddTddWorkflowDoc[]): DddTddViolation[] {
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const violations: DddTddViolation[] = [];
  for (const requirement of REQUIRED_WORKFLOW_DOCS) {
    const doc = byPath.get(requirement.path);
    if (!doc?.exists) {
      violations.push({
        path: requirement.path,
        line: 1,
        rule: "ddd-tdd-workflow-missing-doc",
        message: "DDD/TDD workflow placement document is missing.",
      });
      continue;
    }
    for (const patternRequirement of requirement.patterns) {
      if (patternRequirement.pattern.test(doc.text)) continue;
      violations.push({
        path: requirement.path,
        line: 1,
        rule: "ddd-tdd-workflow-missing-reference",
        message: patternRequirement.message,
      });
    }
  }
  return violations;
}

function domainBoundaryViolations(docs: DddTddDoc[]): DddTddViolation[] {
  const violations: DddTddViolation[] = [];
  for (const doc of docs.filter((d) => d.scope === "source")) {
    const sourceFile = ts.createSourceFile(doc.path, doc.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }
      const fromModule = sourceModule(doc.path);
      const toModule = importedSourceModule(doc.path, node.moduleSpecifier.text);
      if (fromModule && toModule && DISALLOWED_DOMAIN_IMPORTS[fromModule]?.has(toModule)) {
        violations.push({
          path: doc.path,
          line: lineOf(sourceFile, node.moduleSpecifier.getStart(sourceFile)),
          rule: "domain-boundary",
          message: `Module ${fromModule} must not import ${toModule}; keep domain/governance boundaries acyclic.`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

function invariantTraceViolations(policy: DddTddPolicy | null, l7Text: string): DddTddViolation[] {
  if (!policy) return [];
  const violations: DddTddViolation[] = [];
  for (const match of policy.text.matchAll(/id:\s*(DDD-INV-\d+)[^\n]*oracle:\s*(U-[A-Z0-9-]+)/g)) {
    const [, invariantId = "", oracle = ""] = match;
    if (l7Text.includes(oracle)) continue;
    violations.push({
      path: policy.path,
      line: policy.text.slice(0, match.index).split(/\r?\n/).length,
      rule: "invariant-test-trace",
      message: `Invariant ${invariantId} references ${oracle}, but the L7 test design does not define it.`,
    });
  }
  return violations;
}

function frontmatterValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}:\\s*([^\\n]+)`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
}

function evidenceDates(text: string): EvidenceDates {
  return {
    redAt: frontmatterValue(text, "red_at"),
    greenAt: frontmatterValue(text, "green_at"),
  };
}

function redFirstViolations(plans: DddTddPlanDoc[]): DddTddViolation[] {
  const violations: DddTddViolation[] = [];
  for (const plan of plans) {
    const status = frontmatterValue(plan.text, "status");
    const required = /^tdd_red_required:\s*true\s*$/m.test(plan.text);
    if (status !== "confirmed" || !required) continue;
    const dates = evidenceDates(plan.text);
    if (!dates.redAt || !dates.greenAt) {
      violations.push({
        path: plan.path,
        line: 1,
        rule: "red-first-evidence",
        message: "Confirmed TDD plan requires red_at and green_at evidence.",
      });
      continue;
    }
    if (Date.parse(dates.redAt) > Date.parse(dates.greenAt)) {
      violations.push({
        path: plan.path,
        line: 1,
        rule: "red-first-evidence",
        message: "red_at must be earlier than or equal to green_at.",
      });
    }
  }
  return violations;
}

function assertionSummary(text: string): { hasAssertion: boolean; weakOnly: boolean } {
  const expectCount = (text.match(/\bexpect\s*\(/g) ?? []).length;
  const assertCount = (text.match(/\bassert(?:\.|\s*\()/g) ?? []).length;
  if (expectCount === 0 && assertCount === 0) return { hasAssertion: false, weakOnly: false };
  const weakMatcherCount = (text.match(/\.toBe(?:Truthy|Falsy)\s*\(\s*\)/g) ?? []).length;
  return {
    hasAssertion: true,
    weakOnly: assertCount === 0 && expectCount > 0 && expectCount === weakMatcherCount,
  };
}

function testOracleViolations(docs: DddTddDoc[]): DddTddViolation[] {
  const violations: DddTddViolation[] = [];
  for (const doc of docs.filter((d) => d.scope === "test")) {
    const sourceFile = ts.createSourceFile(doc.path, doc.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const name = node.expression.getText(sourceFile);
      if (name !== "it" && name !== "test") {
        ts.forEachChild(node, visit);
        return;
      }
      const bodyNode = node.arguments[1];
      if (!bodyNode || (!ts.isArrowFunction(bodyNode) && !ts.isFunctionExpression(bodyNode))) {
        ts.forEachChild(node, visit);
        return;
      }
      const body = bodyNode.body.getText(sourceFile);
      const summary = assertionSummary(body);
      if (!summary.hasAssertion) {
        violations.push({
          path: doc.path,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          rule: "test-oracle-strength",
          message: "Test cases must contain an explicit expect/assert oracle.",
        });
      } else if (summary.weakOnly) {
        violations.push({
          path: doc.path,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          rule: "test-oracle-strength",
          message: "Test cases must not rely only on toBeTruthy/toBeFalsy weak assertions.",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

function baselineDebtKeys(policy: DddTddPolicy | null): Set<string> {
  const keys = new Set<string>();
  if (!policy) return keys;
  for (const match of policy.text.matchAll(
    /^\s*-\s+([^:\s]+\.test\.ts):(\d+)\s+([a-z0-9-]+)\s*$/gm,
  )) {
    const [, path = "", line = "", rule = ""] = match;
    keys.add(`${normalizePath(path)}:${line}:${rule}`);
  }
  return keys;
}

function violationKey(violation: DddTddViolation): string {
  return `${normalizePath(violation.path)}:${violation.line}:${violation.rule}`;
}

function integrationGwtViolations(l8Text: string): DddTddViolation[] {
  const headerMatch = l8Text.match(/\|\s*IT-ID\s*\|\s*Given\s*\|\s*When\s*\|\s*Then\s*\|/i);
  if (!headerMatch) {
    return [
      {
        path: normalizePath(
          join("docs", "test-design", "harness", "L8-integration-test-design.md"),
        ),
        line: 1,
        rule: "integration-gwt",
        message: "L8 integration test design must define an IT-ID/Given/When/Then table.",
      },
    ];
  }
  const section = l8Text.slice(headerMatch.index);
  const rows = section.split(/\r?\n/).filter((line) => /^\|\s*IT-[A-Z0-9-]+\s*\|/.test(line));
  const violations: DddTddViolation[] = [];
  if (rows.length === 0) {
    violations.push({
      path: normalizePath(join("docs", "test-design", "harness", "L8-integration-test-design.md")),
      line: l8Text.slice(0, headerMatch.index).split(/\r?\n/).length,
      rule: "integration-gwt",
      message: "L8 GWT table has no IT-* rows.",
    });
  }
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[1] && cells[2] && cells[3]) continue;
    violations.push({
      path: normalizePath(join("docs", "test-design", "harness", "L8-integration-test-design.md")),
      line: l8Text.slice(0, l8Text.indexOf(row)).split(/\r?\n/).length,
      rule: "integration-gwt",
      message: `${cells[0] ?? "IT row"} must have non-empty Given, When, and Then cells.`,
    });
  }
  return violations;
}

/** L7 unit test-design table の expected-behavior 列で skeleton (骨格) とみなすマーカー / 最小実質長。 */
const UNIT_ORACLE_MIN_SUBSTANCE = 6;
const UNIT_ORACLE_SKELETON = /^(-|—|todo|tbd|placeholder|骨格|n\/a|wip)$/i;

/**
 * IMP-083 残差 (test-design substance): L6/L7 unit test-design の U-* oracle 行が**実ケースの
 * expected behavior** を持つ (空骨格でない) ことを検査する。pair-freeze は link 存在、oracle-test-trace
 * は citation、test-oracle-strength は test コードの assert を見るが、**unit test-design の U-* 行の
 * 期待結果セル中身**は従来どの gate も見なかった (freeze 時の骨格凍結を素通り)。FR-L1-50 (oracle strength)
 * 配下の追加 rule。末尾数字の oracle id (`U-…-NNN`、多セグメント `U-FR-L1-21-01` 等も含む) のみ対象 =
 * `U-ID` ヘッダ行を除外 (false-positive 回避、QA review Critical 反映)。expected-behavior は ID+target 列を
 * 除く残り全セルを連結して評価する (inline `|` で expected が分割されても拾う、QA review Minor 反映)。
 */
function unitOracleSubstanceViolations(l7Text: string): DddTddViolation[] {
  const path = normalizePath(join("docs", "test-design", "harness", "L7-unit-test-design.md"));
  const violations: DddTddViolation[] = [];
  for (const [index, line] of l7Text.split(/\r?\n/).entries()) {
    // 多セグメント oracle id を許容しつつ末尾 `-NNN` 必須 (`U-ID` ヘッダは末尾数字なしで除外)。
    if (!/^\|\s*U-[A-Z0-9-]+-[0-9]+\s*\|/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0] ?? "U row";
    // expected behavior = ID(0) + target(1) を除く残りセル連結 (inline pipe 分割を再結合)。
    const substance = cells.slice(2).join(" ").trim();
    if (substance.length < UNIT_ORACLE_MIN_SUBSTANCE || UNIT_ORACLE_SKELETON.test(substance)) {
      violations.push({
        path,
        line: index + 1,
        rule: "unit-oracle-substance",
        message: `${id} unit test-design row must describe a real expected behavior (non-skeleton).`,
      });
    }
  }
  return violations;
}

export function analyzeDddTddRules(inputs: DddTddInputs): DddTddResult {
  const violations: DddTddViolation[] = [];
  violations.push(...policyViolations(inputs.policy));
  violations.push(...workflowViolations(inputs.workflowDocs));
  violations.push(...domainBoundaryViolations(inputs.docs));
  violations.push(...invariantTraceViolations(inputs.policy, inputs.l7Text));
  violations.push(...redFirstViolations(inputs.plans));
  violations.push(...testOracleViolations(inputs.docs));
  violations.push(...integrationGwtViolations(inputs.l8Text));
  violations.push(...unitOracleSubstanceViolations(inputs.l7Text));
  const baseline = baselineDebtKeys(inputs.policy);
  const activeViolations = violations.filter((violation) => !baseline.has(violationKey(violation)));
  return {
    checked: inputs.docs.length,
    baselineDebt: violations.length - activeViolations.length,
    violations: activeViolations,
    ok: activeViolations.length === 0,
  };
}

export function dddTddRulesMessages(result: DddTddResult): string[] {
  if (result.ok) {
    return [
      `ddd-tdd-rules - OK (TS docs ${result.checked}, violations 0, baseline debt ${result.baselineDebt})`,
    ];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.rule}`)
    .join(", ");
  return [`ddd-tdd-rules - violation ${result.violations.length} (${sample}).`];
}
