import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function createsPersistedHarnessDb(path: string, source: string): boolean {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const tracked = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
      namespaces.add(statement.importClause.namedBindings.name.text);
      continue;
    }
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (
        [
          "defaultHarnessDbPath",
          "ensureHarnessSchema",
          "openHarnessDb",
          "rebuildHarnessDb",
        ].includes(imported)
      )
        tracked.set(element.name.text, imported);
    }
  }
  for (const statement of file.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      if (
        ts.isIdentifier(declaration.name) &&
        ts.isIdentifier(declaration.initializer) &&
        namespaces.has(declaration.initializer.text)
      ) {
        namespaces.add(declaration.name.text);
        continue;
      }
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const target = element.propertyName?.getText(file) ?? element.name.getText(file);
          if (ts.isIdentifier(element.name)) tracked.set(element.name.text, target);
        }
        continue;
      }
      if (!ts.isIdentifier(declaration.name)) continue;
      const target = ts.isIdentifier(declaration.initializer)
        ? tracked.get(declaration.initializer.text)
        : ts.isPropertyAccessExpression(declaration.initializer) &&
            ts.isIdentifier(declaration.initializer.expression) &&
            namespaces.has(declaration.initializer.expression.text)
          ? declaration.initializer.name.text
          : null;
      if (target) tracked.set(declaration.name.text, target);
    }
  }
  let persisted = false;
  const visit = (node: ts.Node): void => {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const called = ts.isIdentifier(node.expression)
      ? (tracked.get(node.expression.text) ?? node.expression.text)
      : (ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression)) &&
          ts.isIdentifier(node.expression.expression) &&
          namespaces.has(node.expression.expression.text)
        ? ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isStringLiteralLike(node.expression.argumentExpression)
            ? node.expression.argumentExpression.text
            : ""
        : "";
    if (["defaultHarnessDbPath", "ensureHarnessSchema"].includes(called)) persisted = true;
    if (called === "openHarnessDb") {
      const dbPath = node.arguments[0];
      if (!dbPath || !ts.isStringLiteralLike(dbPath) || dbPath.text !== ":memory:")
        persisted = true;
    }
    if (called === "rebuildHarnessDb" && ts.isObjectLiteralExpression(node.arguments[0])) {
      const suppliesDb = node.arguments[0].properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText(file) === "db",
      );
      if (!suppliesDb) persisted = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return persisted;
}

function usesRawRecursiveTreeRemoval(path: string, source: string): boolean {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const aliases = new Set(["rm", "rmSync"]);
  const namespaces = new Set<string>();
  const options = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
      namespaces.add(statement.importClause.namedBindings.name.text);
      continue;
    }
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if (["rm", "rmSync"].includes(element.propertyName?.text ?? element.name.text))
        aliases.add(element.name.text);
    }
  }
  for (const statement of file.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      if (
        ts.isIdentifier(declaration.name) &&
        ts.isIdentifier(declaration.initializer) &&
        namespaces.has(declaration.initializer.text)
      ) {
        namespaces.add(declaration.name.text);
        continue;
      }
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const target = element.propertyName?.getText(file) ?? element.name.getText(file);
          if (["rm", "rmSync"].includes(target) && ts.isIdentifier(element.name))
            aliases.add(element.name.text);
        }
        continue;
      }
      if (!ts.isIdentifier(declaration.name)) continue;
      options.set(declaration.name.text, declaration.initializer);
      const target = ts.isIdentifier(declaration.initializer)
        ? declaration.initializer.text
        : ts.isPropertyAccessExpression(declaration.initializer) &&
            ts.isIdentifier(declaration.initializer.expression) &&
            namespaces.has(declaration.initializer.expression.text)
          ? declaration.initializer.name.text
          : null;
      if (target && aliases.has(target)) aliases.add(declaration.name.text);
    }
  }
  const isRecursive = (expression: ts.Expression | undefined): boolean => {
    let resolved = expression;
    const seen = new Set<string>();
    while (resolved && ts.isIdentifier(resolved) && !seen.has(resolved.text)) {
      seen.add(resolved.text);
      resolved = options.get(resolved.text);
    }
    if (!resolved || !ts.isObjectLiteralExpression(resolved)) return false;
    if (resolved.properties.some(ts.isSpreadAssignment)) return true;
    return resolved.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(file) === "recursive" &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    );
  };
  let raw = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) ||
        ((ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
          ts.isIdentifier(node.expression.expression) &&
          namespaces.has(node.expression.expression.text) &&
          (ts.isPropertyAccessExpression(node.expression)
            ? ["rm", "rmSync"].includes(node.expression.name.text)
            : ts.isStringLiteralLike(node.expression.argumentExpression) &&
              ["rm", "rmSync"].includes(node.expression.argumentExpression.text))))
    ) {
      if (isRecursive(node.arguments[1])) raw = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return raw;
}

function hasLiveCleanupCall(path: string, source: string): boolean {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const aliases = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !/(?:^|\/)support\/temp-tree(?:\.ts)?$/.test(statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "removeTestTree")
        aliases.add(element.name.text);
    }
  }
  for (const statement of file.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isIdentifier(declaration.initializer) &&
        aliases.has(declaration.initializer.text)
      )
        aliases.add(declaration.name.text);
    }
  }
  let found = false;
  const isStaticallyDead = (node: ts.Node): boolean => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isIfStatement(current) &&
        current.thenStatement.pos <= node.pos &&
        node.end <= current.thenStatement.end &&
        current.expression.kind === ts.SyntaxKind.FalseKeyword
      )
        return true;
      if (
        ts.isIfStatement(current) &&
        current.elseStatement &&
        current.elseStatement.pos <= node.pos &&
        node.end <= current.elseStatement.end &&
        current.expression.kind === ts.SyntaxKind.TrueKeyword
      )
        return true;
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        current.right.pos <= node.pos &&
        node.end <= current.right.end &&
        current.left.kind === ts.SyntaxKind.FalseKeyword
      )
        return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      aliases.has(node.expression.text) &&
      !isStaticallyDead(node)
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function delegatedCleanupContract(source: string): { ownerPath: string; rootEnv: string } | null {
  const match = source.match(
    /^\s*\/\/\s*ut-tdd:cleanup-owner=(tests\/[a-z0-9./-]+\.test\.ts);root-env=([A-Z][A-Z0-9_]*)\s*$/m,
  );
  return match ? { ownerPath: match[1], rootEnv: match[2] } : null;
}

function hasDelegatedCleanupBinding(
  path: string,
  source: string,
  workerPath: string,
  rootEnv: string,
): boolean {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const workerVariables = new Set<string>();
  const cleanupRoots = new Set<string>();
  const constIdentifiers = new Set<string>();
  const mutatedIdentifiers = new Set<string>();
  const declarationCounts = new Map<string, number>();
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarationCounts.set(node.name.text, (declarationCounts.get(node.name.text) ?? 0) + 1);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    )
      constIdentifiers.add(node.name.text);
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      mutatedIdentifiers.add(node.left.text);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    )
      mutatedIdentifiers.add(node.operand.text);
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(file);
  const resolvesWorkerPath = (call: ts.CallExpression): boolean => {
    if (!ts.isIdentifier(call.expression) || !["join", "resolve"].includes(call.expression.text))
      return false;
    const parts: string[] = [];
    for (const argument of call.arguments) {
      if (ts.isStringLiteralLike(argument)) {
        parts.push(argument.text);
        continue;
      }
      if (
        ts.isCallExpression(argument) &&
        ts.isPropertyAccessExpression(argument.expression) &&
        ts.isIdentifier(argument.expression.expression) &&
        argument.expression.expression.text === "process" &&
        argument.expression.name.text === "cwd" &&
        argument.arguments.length === 0
      )
        continue;
      return false;
    }
    return parts.join("/").replaceAll("\\", "/") === workerPath;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      resolvesWorkerPath(node.initializer) &&
      constIdentifiers.has(node.name.text) &&
      !mutatedIdentifiers.has(node.name.text) &&
      declarationCounts.get(node.name.text) === 1
    )
      workerVariables.add(node.name.text);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "spawn" &&
      ts.isArrayLiteralExpression(node.arguments[1])
    ) {
      const launchesWorker = node.arguments[1].elements.some(
        (element) => ts.isIdentifier(element) && workerVariables.has(element.text),
      );
      const options = node.arguments[2];
      if (launchesWorker && options && ts.isObjectLiteralExpression(options)) {
        const envProperty = options.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(file) === "env" &&
            ts.isObjectLiteralExpression(property.initializer),
        );
        if (envProperty && ts.isObjectLiteralExpression(envProperty.initializer)) {
          const rootProperty = envProperty.initializer.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) && property.name.getText(file) === rootEnv,
          );
          if (
            rootProperty &&
            ts.isIdentifier(rootProperty.initializer) &&
            constIdentifiers.has(rootProperty.initializer.text) &&
            !mutatedIdentifiers.has(rootProperty.initializer.text) &&
            declarationCounts.get(rootProperty.initializer.text) === 1
          )
            cleanupRoots.add(rootProperty.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  let bound = false;
  const isStaticallyDead = (node: ts.Node): boolean => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isIfStatement(current) &&
        current.thenStatement.pos <= node.pos &&
        node.end <= current.thenStatement.end &&
        current.expression.kind === ts.SyntaxKind.FalseKeyword
      )
        return true;
      if (
        ts.isIfStatement(current) &&
        current.elseStatement &&
        current.elseStatement.pos <= node.pos &&
        node.end <= current.elseStatement.end &&
        current.expression.kind === ts.SyntaxKind.TrueKeyword
      )
        return true;
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        current.right.pos <= node.pos &&
        node.end <= current.right.end &&
        current.left.kind === ts.SyntaxKind.FalseKeyword
      )
        return true;
    }
    return false;
  };
  const findCleanup = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "removeTestTree" &&
      ts.isIdentifier(node.arguments[0]) &&
      cleanupRoots.has(node.arguments[0].text) &&
      !isStaticallyDead(node)
    )
      bound = true;
    ts.forEachChild(node, findCleanup);
  };
  findCleanup(file);
  return bound;
}

describe("persistent harness DB cleanup contract", () => {
  it("U-TESTHYGIENE-026: resolves namespace DB owners and namespace recursive removal", () => {
    expect(
      createsPersistedHarnessDb(
        "tests/nested/owner.test.ts",
        "import * as db from '../src/db'; db.ensureHarnessSchema(root);",
      ),
    ).toBe(true);
    expect(
      usesRawRecursiveTreeRemoval(
        "tests/nested/owner.test.ts",
        "import * as fs from 'node:fs'; fs.rmSync(root, { recursive: true });",
      ),
    ).toBe(true);
  });

  it("U-TESTHYGIENE-030: resolves aliases, element access, async rm, and options variables", () => {
    expect(
      createsPersistedHarnessDb(
        "tests/nested/owner.test.ts",
        "import * as db from '../src/db'; const open = db.openHarnessDb; open(path);",
      ),
    ).toBe(true);
    expect(
      usesRawRecursiveTreeRemoval(
        "tests/nested/owner.test.ts",
        "import * as fs from 'node:fs'; const opts = { recursive: true }; fs['rm'](root, opts, cb);",
      ),
    ).toBe(true);
  });

  it("U-TESTHYGIENE-033: resolves destructuring and rejects chained options or dead cleanup", () => {
    expect(
      createsPersistedHarnessDb(
        "tests/nested/owner.test.ts",
        "import * as db from '../src/db'; const { openHarnessDb: open } = db; open(path);",
      ),
    ).toBe(true);
    expect(
      usesRawRecursiveTreeRemoval(
        "tests/nested/owner.test.ts",
        "import * as fs from 'node:fs'; const { rmSync: wipe } = fs; const a = { recursive: true }; const b = a; wipe(root, b);",
      ),
    ).toBe(true);
    expect(
      hasLiveCleanupCall(
        "tests/nested/owner.test.ts",
        "import { removeTestTree } from '../support/temp-tree'; if (false) removeTestTree(root);",
      ),
    ).toBe(false);
    expect(
      hasLiveCleanupCall(
        "tests/nested/owner.test.ts",
        "import { removeTestTree } from '../support/temp-tree'; false && removeTestTree(root); if (true) {} else removeTestTree(root);",
      ),
    ).toBe(false);
    expect(
      createsPersistedHarnessDb(
        "tests/nested/owner.test.ts",
        "import * as db from '../src/db'; const d = db; d.ensureHarnessSchema(root);",
      ),
    ).toBe(true);
    expect(
      usesRawRecursiveTreeRemoval(
        "tests/nested/owner.test.ts",
        "import * as fs from 'node:fs'; const f = fs; f.rmSync(root, { recursive: true });",
      ),
    ).toBe(true);
  });

  it("U-TESTHYGIENE-034: worker DB ownership requires an explicit parent cleanup contract", () => {
    expect(
      delegatedCleanupContract(
        "// ut-tdd:cleanup-owner=tests/forward-escape-issue-contract.test.ts;root-env=UT_TDD_REPO\nopenHarnessDb(path);",
      ),
    ).toEqual({
      ownerPath: "tests/forward-escape-issue-contract.test.ts",
      rootEnv: "UT_TDD_REPO",
    });
    expect(delegatedCleanupContract("openHarnessDb(path);")).toBeNull();
    expect(
      delegatedCleanupContract(
        "// ut-tdd:cleanup-owner=../outside.test.ts;root-env=UT_TDD_REPO\nopenHarnessDb(path);",
      ),
    ).toBeNull();
    const owner =
      "const repo = 'tmp'; const worker = join('tests', 'db-worker.ts'); spawn(node, [runner, worker], { env: { UT_TDD_REPO: repo } }); removeTestTree(repo);";
    expect(
      hasDelegatedCleanupBinding("tests/owner.test.ts", owner, "tests/db-worker.ts", "UT_TDD_REPO"),
    ).toBe(true);
    expect(
      hasDelegatedCleanupBinding(
        "tests/owner.test.ts",
        owner.replace("join('tests', 'db-worker.ts')", "join('tests', 'evil', 'db-worker.ts')"),
        "tests/db-worker.ts",
        "UT_TDD_REPO",
      ),
    ).toBe(false);
    expect(
      hasDelegatedCleanupBinding(
        "tests/owner.test.ts",
        "const repo = 'tmp'; { const worker = join('tests', 'db-worker.ts'); } { const worker = join('tests', 'evil.ts'); spawn(node, [runner, worker], { env: { UT_TDD_REPO: repo } }); } removeTestTree(repo);",
        "tests/db-worker.ts",
        "UT_TDD_REPO",
      ),
    ).toBe(false);
    expect(
      hasDelegatedCleanupBinding(
        "tests/owner.test.ts",
        "const repo = 'tmp'; const worker = join('tests', 'db-worker.ts'); { const repo = 'other'; spawn(node, [runner, worker], { env: { UT_TDD_REPO: repo } }); } removeTestTree(repo);",
        "tests/db-worker.ts",
        "UT_TDD_REPO",
      ),
    ).toBe(false);
    expect(
      hasDelegatedCleanupBinding(
        "tests/owner.test.ts",
        owner.replace(
          "const worker = join('tests', 'db-worker.ts');",
          "let worker = join('tests', 'db-worker.ts'); worker = join('tests', 'evil.ts');",
        ),
        "tests/db-worker.ts",
        "UT_TDD_REPO",
      ),
    ).toBe(false);
    expect(
      hasDelegatedCleanupBinding(
        "tests/owner.test.ts",
        owner
          .replace("UT_TDD_REPO: repo", "UT_TDD_REPO: root")
          .replace("const worker =", "let root = repo; const worker =")
          .replace("removeTestTree(repo)", "root = otherRoot; removeTestTree(root)"),
        "tests/db-worker.ts",
        "UT_TDD_REPO",
      ),
    ).toBe(false);
    expect(
      hasDelegatedCleanupBinding(
        "tests/owner.test.ts",
        owner.replace("removeTestTree(repo)", "removeTestTree(otherRoot)"),
        "tests/db-worker.ts",
        "UT_TDD_REPO",
      ),
    ).toBe(false);
    expect(
      hasDelegatedCleanupBinding(
        "tests/owner.test.ts",
        owner.replace("removeTestTree(repo)", "if (false) removeTestTree(repo)"),
        "tests/db-worker.ts",
        "UT_TDD_REPO",
      ),
    ).toBe(false);
  });

  it("U-TESTHYGIENE-019: auto-discovers every persisted DB owner and requires retrying cleanup", () => {
    const root = process.cwd();
    const pending = [join(root, "tests")];
    const files: Array<{ path: string; source: string }> = [];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) break;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.endsWith(".ts"))
          files.push({
            path: relative(root, path).replaceAll("\\", "/"),
            source: readFileSync(path, "utf8"),
          });
      }
    }
    const owners = files.filter((file) => createsPersistedHarnessDb(file.path, file.source));
    const filesByPath = new Map(files.map((file) => [file.path, file]));

    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) {
      const delegated = delegatedCleanupContract(owner.source);
      const cleanupOwner = delegated ? filesByPath.get(delegated.ownerPath) : owner;
      if (!cleanupOwner) {
        throw new Error(`${owner.path}: missing cleanup owner ${delegated?.ownerPath}`);
      }
      expect(
        delegated === null ||
          hasDelegatedCleanupBinding(
            cleanupOwner.path,
            cleanupOwner.source,
            owner.path,
            delegated.rootEnv,
          ),
        `${owner.path}: cleanup owner does not bind worker spawn root to cleanup root`,
      ).toBe(true);
      expect(hasLiveCleanupCall(cleanupOwner.path, cleanupOwner.source), owner.path).toBe(true);
      expect(usesRawRecursiveTreeRemoval(cleanupOwner.path, cleanupOwner.source), owner.path).toBe(
        false,
      );
    }
  });
});
