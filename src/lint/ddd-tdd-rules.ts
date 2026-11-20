import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { importedSourceModule, lineOf, normalizePath, sourceModule } from "./shared.ts";

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

export interface DddTddInputs {
  policy: DddTddPolicy | null;
  workflowDocs: DddTddWorkflowDoc[];
  docs: DddTddDoc[];
  l7Text: string;
  l8Text: string;
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

const REQUIRED_RULE_IDS = [
  "domain-boundary",
  "invariant-test-trace",
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

function maybeRead(repoRoot: string, relPath: string): string {
  const absPath = join(repoRoot, relPath);
  return existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
}

function collectL7Text(repoRoot: string): string {
  const dir = join(repoRoot, "docs", "test-design", "harness");
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^L7-.*\.md$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
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
    l7Text: collectL7Text(repoRoot),
    l8Text: maybeRead(
      repoRoot,
      normalizePath(join("docs", "test-design", "harness", "L8-integration-test-design.md")),
    ),
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

type OracleStrength = 0 | 1 | 2;

interface OracleHelperBinding {
  name: string;
  helper: ts.FunctionDeclaration | ts.VariableDeclaration | null;
  overloadSignature: boolean;
}

interface OracleScope {
  parent: OracleScope | null;
  bindings: Map<string, OracleHelperBinding[]>;
}

interface OracleCallSite {
  node: ts.CallExpression;
  scope: OracleScope;
}

interface OracleHelperIndex {
  scopeAtNode: WeakMap<ts.Node, OracleScope>;
  writes: Set<string>;
}

function oracleStrength(summary: { hasAssertion: boolean; weakOnly: boolean }): OracleStrength {
  if (!summary.hasAssertion) return 0;
  if (summary.weakOnly) return 1;
  return 2;
}

function isFunctionLikeNode(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

function walkOracleBody(body: ts.Node, visitNode: (node: ts.Node) => void): void {
  const visit = (node: ts.Node, root: boolean): void => {
    if (!root && isFunctionLikeNode(node)) return;
    visitNode(node);
    ts.forEachChild(node, (child) => visit(child, false));
  };
  visit(body, true);
}

function boundIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const identifiers: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    identifiers.push(...boundIdentifiers(element.name));
  }
  return identifiers;
}

function collectWrittenNames(target: ts.Node, names: Set<string>): void {
  if (ts.isParenthesizedExpression(target)) {
    collectWrittenNames(target.expression, names);
    return;
  }
  if (ts.isIdentifier(target)) {
    names.add(target.text);
    return;
  }
  if (ts.isArrayLiteralExpression(target)) {
    for (const element of target.elements) {
      if (ts.isSpreadElement(element)) collectWrittenNames(element.expression, names);
      else if (!ts.isOmittedExpression(element)) collectWrittenNames(element, names);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text);
      else if (ts.isPropertyAssignment(property)) collectWrittenNames(property.initializer, names);
      else if (ts.isSpreadAssignment(property)) collectWrittenNames(property.expression, names);
    }
    return;
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    collectWrittenNames(target.left, names);
    return;
  }
}

function oracleHelperIndex(sourceFile: ts.SourceFile): OracleHelperIndex {
  const scopeAtNode = new WeakMap<ts.Node, OracleScope>();
  const writes = new Set<string>();
  const rootScope: OracleScope = { parent: null, bindings: new Map() };

  const addBinding = (
    scope: OracleScope,
    name: string,
    options: {
      helper?: OracleHelperBinding["helper"];
      overloadSignature?: boolean;
    } = {},
  ): void => {
    const bindings = scope.bindings.get(name) ?? [];
    bindings.push({
      name,
      helper: options.helper ?? null,
      overloadSignature: options.overloadSignature ?? false,
    });
    scope.bindings.set(name, bindings);
  };

  const addBindingName = (scope: OracleScope, name: ts.BindingName): void => {
    for (const identifier of boundIdentifiers(name)) addBinding(scope, identifier.text);
  };

  const addVariableDeclaration = (
    scope: OracleScope,
    declaration: ts.VariableDeclaration,
  ): void => {
    if (ts.isIdentifier(declaration.name)) {
      const list = declaration.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      const initializer = declaration.initializer;
      const helper =
        isConst &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          ? declaration
          : null;
      addBinding(scope, declaration.name.text, { helper });
      return;
    }
    addBindingName(scope, declaration.name);
  };

  const addStatementBindings = (scope: OracleScope, statement: ts.Statement): void => {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      addBinding(scope, statement.name.text, {
        helper: statement.body ? statement : null,
        overloadSignature: !statement.body,
      });
      return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addVariableDeclaration(scope, declaration);
      }
      return;
    }
    if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      addBinding(scope, statement.name.text);
    }
  };

  const addDirectDeclarations = (scope: OracleScope, statements: readonly ts.Statement[]): void => {
    for (const statement of statements) addStatementBindings(scope, statement);
  };

  const addImportBindings = (scope: OracleScope): void => {
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) continue;
        if (clause.name) addBinding(scope, clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) addBinding(scope, bindings.name.text);
        else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) addBinding(scope, element.name.text);
        }
      } else if (ts.isImportEqualsDeclaration(statement)) {
        addBinding(scope, statement.name.text);
      }
    }
  };

  const addFunctionVarBindings = (scope: OracleScope, functionNode: ts.Node): void => {
    const body = (functionNode as ts.FunctionLikeDeclaration).body;
    if (!body) return;
    const visitVar = (node: ts.Node): void => {
      if (node !== body && isFunctionLikeNode(node)) return;
      if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
        for (const declaration of node.declarations) addBindingName(scope, declaration.name);
      }
      ts.forEachChild(node, visitVar);
    };
    visitVar(body);
  };

  const makeScope = (node: ts.Node, parent: OracleScope): OracleScope => {
    const scope: OracleScope = { parent, bindings: new Map() };
    if (ts.isSourceFile(node)) {
      addDirectDeclarations(scope, node.statements);
      addImportBindings(scope);
    } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      addDirectDeclarations(scope, node.statements);
    } else if (ts.isCaseBlock(node)) {
      for (const clause of node.clauses) addDirectDeclarations(scope, clause.statements);
    } else if (ts.isCatchClause(node)) {
      if (node.variableDeclaration) addBindingName(scope, node.variableDeclaration.name);
    } else if (ts.isForStatement(node)) {
      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          addVariableDeclaration(scope, declaration);
        }
      }
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          addVariableDeclaration(scope, declaration);
        }
      }
    } else if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) addBindingName(scope, parameter.name);
      if (ts.isFunctionExpression(node) && node.name) addBinding(scope, node.name.text);
      addFunctionVarBindings(scope, node);
    } else if (ts.isClassExpression(node) && node.name) {
      addBinding(scope, node.name.text);
    }
    return scope;
  };

  const visit = (node: ts.Node, parentScope: OracleScope): void => {
    let scope = parentScope;
    if (node !== sourceFile && isScopeNode(node)) scope = makeScope(node, parentScope);
    scopeAtNode.set(node, scope);

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      collectWrittenNames(node.left, writes);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        collectWrittenNames(node.operand, writes);
      }
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer))
        collectWrittenNames(node.initializer, writes);
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };

  const isScopeNode = (node: ts.Node): boolean =>
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node);

  visit(sourceFile, makeScope(sourceFile, rootScope));
  return { scopeAtNode, writes };
}

function shallowCalls(node: ts.Node, scopeAtNode: WeakMap<ts.Node, OracleScope>): OracleCallSite[] {
  const calls: OracleCallSite[] = [];
  walkOracleBody(node, (current) => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      const scope = scopeAtNode.get(current);
      if (scope) calls.push({ node: current, scope });
    }
  });
  return calls;
}

function resolveOracleHelper(
  name: string,
  scope: OracleScope,
  writes: Set<string>,
): ts.FunctionDeclaration | ts.VariableDeclaration | null {
  for (let current: OracleScope | null = scope; current; current = current.parent) {
    const bindings = current.bindings.get(name);
    if (!bindings) continue;
    const concreteBindings = bindings.filter((binding) => !binding.overloadSignature);
    if (concreteBindings.length !== 1 || writes.has(name)) return null;
    return concreteBindings[0]?.helper ?? null;
  }
  return null;
}

function helperBody(helper: ts.FunctionDeclaration | ts.VariableDeclaration): ts.Node | null {
  if (ts.isFunctionDeclaration(helper)) return helper.body ?? null;
  const initializer = helper.initializer;
  if (!initializer || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) {
    return null;
  }
  return initializer.body;
}

function helperAstStrength(body: ts.Node): OracleStrength {
  let expectCount = 0;
  let assertCount = 0;
  let weakMatcherCount = 0;
  walkOracleBody(body, (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "expect") expectCount += 1;
      if (
        (ts.isIdentifier(callee) && callee.text === "assert") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "assert")
      ) {
        assertCount += 1;
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === "toBeTruthy" || callee.name.text === "toBeFalsy") &&
        node.arguments.length === 0
      ) {
        weakMatcherCount += 1;
      }
    }
  });
  if (expectCount === 0 && assertCount === 0) return 0;
  if (assertCount === 0 && expectCount > 0 && expectCount === weakMatcherCount) return 1;
  return 2;
}

function callbackOracleStrength(
  callbackBody: ts.Node,
  index: OracleHelperIndex,
  sourceFile: ts.SourceFile,
): OracleStrength {
  let strongest = oracleStrength(assertionSummary(callbackBody.getText(sourceFile)));
  const queue = shallowCalls(callbackBody, index.scopeAtNode).map((call) => ({
    ...call,
    depth: 1,
  }));
  const visited = new Set<ts.Node>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const entry = queue[cursor];
    if (!entry || entry.depth > 3) continue;
    const name = (entry.node.expression as ts.Identifier).text;
    const helper = resolveOracleHelper(name, entry.scope, index.writes);
    if (!helper || visited.has(helper)) continue;
    visited.add(helper);
    const body = helperBody(helper);
    if (!body) continue;
    strongest = Math.max(strongest, helperAstStrength(body)) as OracleStrength;
    if (entry.depth < 3) {
      queue.push(
        ...shallowCalls(body, index.scopeAtNode).map((call) => ({
          ...call,
          depth: entry.depth + 1,
        })),
      );
    }
  }
  return strongest;
}

function testOracleViolations(docs: DddTddDoc[]): DddTddViolation[] {
  const violations: DddTddViolation[] = [];
  for (const doc of docs.filter((d) => d.scope === "test")) {
    const sourceFile = ts.createSourceFile(doc.path, doc.text, ts.ScriptTarget.Latest, true);
    const helperIndex = oracleHelperIndex(sourceFile);
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
      const strength = callbackOracleStrength(bodyNode.body, helperIndex, sourceFile);
      if (strength === 0) {
        violations.push({
          path: doc.path,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          rule: "test-oracle-strength",
          message: "Test cases must contain an explicit expect/assert oracle.",
        });
      } else if (strength === 1) {
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
