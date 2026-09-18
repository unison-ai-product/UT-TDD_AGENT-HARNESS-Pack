import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import type { LintResult } from "../plan/lint.ts";

export type RepositoryReadMode = "head_snapshot" | "isolated_fixture";
export interface RepositoryReadContract {
  mode?: RepositoryReadMode;
  calls?: number;
  mode_calls?: Partial<Record<RepositoryReadMode, number>>;
  reason: string;
}

const CONTRACT_ROWS = `
asset-catalog:3 asset-drift:1 backfill-pairing:2 cited-command-existence:1 cli-surface:2 cli:1
advisory-strict-gate-aging:4
codex-hook-adapter:1 coding-rules:1 context-doc-router:2 cycle-p4-verification:5 db-currency:1 db-projection-coverage:1 db-projection-ingestion:3
dependency-drift:4 descent-obligation:3 distribution-acceptance:1 distribution-scratch-ignore:1 doctor-runtime-surface:2 doctor:25
drive-model-passage:2 fr-roadmap-coverage:4 frontend-design-coverage:1 g10-ux-workflow:5 g8-integration-workflow:6 g9-system-workflow:7
erasable-syntax:1 gate-static:9 impl-plan-trace:1 import-specifier:2 l14-close-audit:8 l6-completion:2 l6-fr-coverage:2 mode-catalog:1 model-id-ssot:1 model-id-ssot-drift:1 module-drift:2 oracle-test-trace:5
plan-id-naming:1 plan-lint:10 projection-writer:13 proposal-document-coverage:2 readability:5 relation-graph-loader:1 review-green-command-projection:1
release-artifact-resolver:1
right-arm-gate-planning:1 right-lung-doc-governance:1 roadmap:1 rule-automation-closure:1 rule-drift:4 runtime-hook-entrypoints:1
review-live-cli:2
review-delegation-root:1
runtime-portability:2 screen-impl-pair-freeze:1 setup-bun-removal:2 ban-lint-detection-power:3 bun-permanent-ban:14 self-pair-normative-guard:1 setup-agent-floor:2 setup:8 skill-assignment:1 state-db:1
sub-doc-catalog-drift:5 sub-doc-section-structure:1 telemetry-closure:1 test-design-naming:1 toolchain-pin:1 tracked-canonical:1
vmodel-contract-compiler:1 vmodel-source-assets:1 work-guard:1 workspace-roots:3 write-encoding-guard:1
doctor-test-repository-isolation:1 persistent-db-cleanup-contract:1 memory-clean-cut-removal:1 memory-legacy-archive:1 memory-clean-cut-non-read:1 memory-curation-ledger:1
secret-scan-diff:1
feedback-log:2
github-repository-policy:3
github-ci-policy:1
github-forward-store:2
node-self-host-bootstrap:1 node-slice-admission:3 node-plan-revision-runner:3
global-setup.ts:1 support/workspace-roots.ts:3
global-setup-fence:1 vitest-snapshot-runner:3
hook-native-launcher:1 claude-memory-terminal-gc:1 release-version-identity:2 windows-ci-single-snapshot:2 pack-authoring-template-scope:2
profile/tracked-loader:2
plan-asset/ledger-schema:4 plan-asset/legacy-inventory:5 plan-asset/legacy-migration-dry-run:13 plan-asset/project-identity-loader:1
disposition/git-authoring-provenance:3 disposition/projection:6 disposition/tracked-target-registry:2
forward-escape-issue-contract:2
`;

const repositoryReadContracts: Record<string, RepositoryReadContract> = Object.fromEntries(
  CONTRACT_ROWS.trim()
    .split(/\s+/)
    .map((row) => {
      const [name, calls] = row.split(":");
      return [
        `tests/${name.endsWith(".ts") ? name : `${name}.test.ts`}`,
        {
          mode: "isolated_fixture",
          calls: Number(calls),
          reason: "repository contract read is isolated in the writable execution snapshot",
        },
      ];
    }),
);

for (const [path, calls] of Object.entries({
  "tests/github-pr-trace.test.ts": 1,
  "tests/model-id-ssot-drift.test.ts": 1,
  "tests/model-id-ssot.test.ts": 1,
  "tests/plan-id-naming.test.ts": 1,
  "tests/setup-project-identity-bootstrap.test.ts": 2,
  "tests/sub-doc-schema-integrity.test.ts": 3,
}))
  repositoryReadContracts[path] = {
    mode: "head_snapshot",
    calls,
    reason: "repository contract read is fixed to detached HEAD",
  };

// PLAN-L7-461: doctor envelope の consumer は「検証対象 = detached HEAD snapshot」を
// 前提に観測面を突き合わせるため、HEAD snapshot 読みを契約として明示する。
repositoryReadContracts["tests/support/doctor-envelope.ts"] = {
  mode: "head_snapshot",
  calls: 1,
  reason: "doctor envelope consumer compares the CI measurement against the detached HEAD surface",
};
repositoryReadContracts["tests/doctor-result-file.test.ts"] = {
  mode: "head_snapshot",
  calls: 4,
  reason:
    "doctor envelope oracles build fixtures and measured writer inputs from the detached HEAD observation surface",
};
repositoryReadContracts["tests/windows-ci-single-snapshot.test.ts"] = {
  mode_calls: { isolated_fixture: 2 },
  reason:
    "workflow oracle reads package.json scripts and .github/workflows/harness-check.yml from the writable execution fixture",
};

repositoryReadContracts["tests/doctor.test.ts"] = {
  mode_calls: { head_snapshot: 20, isolated_fixture: 7 },
  reason: "doctor aggregate test exercises both detached HEAD and execution fixture",
};

repositoryReadContracts["tests/workspace-roots.test.ts"] = {
  mode_calls: { isolated_fixture: 1 },
  reason: "root capability test exercises the writable execution fixture",
};
repositoryReadContracts["tests/claude-wake-generation-upgrade.test.ts"] = {
  mode_calls: { isolated_fixture: 2 },
  reason: "rolling-upgrade oracles read immutable captures from the detached execution fixture",
};
repositoryReadContracts["tests/setup-bun-readiness.test.ts"] = {
  mode_calls: { isolated_fixture: 1 },
  reason:
    "Pack readiness runs against a copied clean-consumer fixture rather than the source worktree",
};
repositoryReadContracts["tests/bun-final-retirement.test.ts"] = {
  mode_calls: { isolated_fixture: 4 },
  reason:
    "final-retirement admission tests read the exact execution HEAD and construct isolated receipt fixtures",
};
repositoryReadContracts["tests/support/workspace-roots.ts"] = {
  mode_calls: { head_snapshot: 1, isolated_fixture: 1 },
  reason: "root capability implementation validates both provenance modes",
};
repositoryReadContracts["tests/support/pack-consumer-runtime.ts"] = {
  mode_calls: { head_snapshot: 1, isolated_fixture: 1 },
  reason:
    "clean Pack/provider parity fixture materializes and seals inputs only from the detached execution snapshot before deleting the Pack checkout",
};

export const REPOSITORY_READ_CONTRACTS: Readonly<Record<string, RepositoryReadContract>> =
  repositoryReadContracts;

function isProcessReference(node: ts.Expression): boolean {
  if (ts.isIdentifier(node) && node.text === "process") return true;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "globalThis" &&
    node.name.text === "process"
  )
    return true;
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    ["process", "node:process"].includes(node.arguments[0].text)
  );
}

const REPOSITORY_READ_APIS = new Set([
  "access",
  "accessSync",
  "existsSync",
  "file",
  "lstat",
  "lstatSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "stat",
  "statSync",
]);
const REPOSITORY_WRITE_APIS = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "createWriteStream",
  "cp",
  "cpSync",
  "copyFile",
  "copyFileSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "link",
  "linkSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "writeFile",
  "writeFileSync",
]);
const MUTATION_TARGET_ARGS: Readonly<Record<string, readonly number[]>> = {
  "Bun.write": [0],
  appendFile: [0],
  appendFileSync: [0],
  chmod: [0],
  chmodSync: [0],
  chown: [0],
  chownSync: [0],
  createWriteStream: [0],
  cp: [1],
  cpSync: [1],
  copyFile: [1],
  copyFileSync: [1],
  lchmod: [0],
  lchmodSync: [0],
  lchown: [0],
  lchownSync: [0],
  link: [1],
  linkSync: [1],
  lutimes: [0],
  lutimesSync: [0],
  mkdir: [0],
  mkdirSync: [0],
  mkdtemp: [0],
  mkdtempSync: [0],
  rename: [0, 1],
  renameSync: [0, 1],
  rm: [0],
  rmSync: [0],
  truncate: [0],
  truncateSync: [0],
  symlink: [1],
  symlinkSync: [1],
  unlink: [0],
  unlinkSync: [0],
  utimes: [0],
  utimesSync: [0],
  writeFile: [0],
  writeFileSync: [0],
};
const REPOSITORY_PATH =
  /^(?:\.?(?:\/|\\))?(?:\.claude|\.codex|\.github|\.ut-tdd|docs|scripts|skills|src|tests)(?:\/|\\)|^(?:AGENTS\.md|CLAUDE\.md|package\.json|tsconfig\.json|vitest\.config\.ts)$/;

function staticPath(
  node: ts.Expression,
  paths: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return paths.get(node.text) ?? null;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticPath(node.left, paths);
    const right = staticPath(node.right, paths);
    return left !== null && right !== null ? left + right : null;
  }
  if (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && ["join", "resolve"].includes(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ["join", "resolve"].includes(node.expression.name.text)))
  ) {
    const parts = node.arguments.map((argument) => staticPath(argument, paths));
    return parts.every((part): part is string => part !== null) ? parts.join("/") : null;
  }
  return null;
}

function memberName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return null;
}

function writeApiName(
  node: ts.CallExpression,
  aliases: ReadonlyMap<string, string>,
): string | null {
  const rawName = memberName(node.expression);
  const alias = rawName ? (aliases.get(rawName) ?? rawName) : null;
  if (alias && REPOSITORY_WRITE_APIS.has(alias)) return alias;
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Bun" &&
    node.expression.name.text === "write"
  )
    return "Bun.write";
  return null;
}

function isWriteCapableOpen(node: ts.CallExpression, name: string): boolean {
  if (name === "createWriteStream") return true;
  if (name !== "open" && name !== "openSync") return false;
  const flag = node.arguments[1];
  if (!flag || !ts.isStringLiteralLike(flag)) return true;
  return /[wa+]/.test(flag.text);
}

function isDirectRepositoryRead(
  node: ts.CallExpression,
  aliases: ReadonlyMap<string, string>,
  paths: ReadonlyMap<string, string>,
): boolean {
  const rawName = memberName(node.expression);
  const name = rawName ? (aliases.get(rawName) ?? rawName) : null;
  const target = node.arguments[0] ? staticPath(node.arguments[0], paths) : null;
  return Boolean(name && REPOSITORY_READ_APIS.has(name) && target && REPOSITORY_PATH.test(target));
}

function inspectSource(
  path: string,
  source: string,
): { modeCalls: Record<RepositoryReadMode, number>; forbidden: boolean } {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const readAliases = new Map<string, string>();
  const writeAliases = new Map<string, string>();
  const pathAliases = new Map<string, string>();
  const processAliases = new Set<string>(["process"]);
  const headFunctionAliases = new Set<string>(["headSnapshotRoot"]);
  const headRootAliases = new Set<string>();
  const containsKnownHead = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && headRootAliases.has(node.text)) return true;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      headFunctionAliases.has(node.expression.text)
    )
      return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (containsKnownHead(child)) found = true;
    });
    return found;
  };
  const collect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    )
      for (const element of node.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (REPOSITORY_READ_APIS.has(imported)) readAliases.set(element.name.text, imported);
        if (REPOSITORY_WRITE_APIS.has(imported)) writeAliases.set(element.name.text, imported);
        if (imported === "headSnapshotRoot") headFunctionAliases.add(element.name.text);
      }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName?.getText(file) ?? element.name.getText(file);
          if (REPOSITORY_READ_APIS.has(imported) && ts.isIdentifier(element.name))
            readAliases.set(element.name.text, imported);
          if (REPOSITORY_WRITE_APIS.has(imported) && ts.isIdentifier(element.name))
            writeAliases.set(element.name.text, imported);
        }
      } else if (ts.isIdentifier(node.name)) {
        const target = memberName(node.initializer);
        const canonical = target ? (readAliases.get(target) ?? target) : null;
        if (canonical && REPOSITORY_READ_APIS.has(canonical))
          readAliases.set(node.name.text, canonical);
        const writeCanonical = target ? (writeAliases.get(target) ?? target) : null;
        if (writeCanonical && REPOSITORY_WRITE_APIS.has(writeCanonical))
          writeAliases.set(node.name.text, writeCanonical);
        if (ts.isIdentifier(node.initializer) && headFunctionAliases.has(node.initializer.text))
          headFunctionAliases.add(node.name.text);
        const value = staticPath(node.initializer, pathAliases);
        if (value !== null) pathAliases.set(node.name.text, value);
        if (
          isProcessReference(node.initializer) ||
          (ts.isIdentifier(node.initializer) && processAliases.has(node.initializer.text))
        )
          processAliases.add(node.name.text);
        if (containsKnownHead(node.initializer)) headRootAliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  for (let pass = 0; pass < 8; pass += 1) collect(file);
  const isProcessRef = (node: ts.Expression): boolean =>
    isProcessReference(node) || (ts.isIdentifier(node) && processAliases.has(node.text));
  const containsHeadRoot = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && headRootAliases.has(node.text)) return true;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      headFunctionAliases.has(node.expression.text)
    )
      return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (containsHeadRoot(child)) found = true;
    });
    return found;
  };
  const isRepositoryConsumer = (call: ts.CallExpression): boolean => {
    const name = memberName(call.expression) ?? "";
    return !/^(?:expect|to(?:Be|Equal|Contain|Match|Have|Throw))/.test(name);
  };
  const isStaticallyDead = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (
        ts.isIfStatement(current) &&
        current.expression.kind === ts.SyntaxKind.FalseKeyword &&
        current.thenStatement.pos <= node.pos &&
        node.end <= current.thenStatement.end
      )
        return true;
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        current.left.kind === ts.SyntaxKind.FalseKeyword &&
        current.right.pos <= node.pos &&
        node.end <= current.right.end
      )
        return true;
    }
    return false;
  };
  const isConsumedRootCall = (node: ts.CallExpression): boolean => {
    if (ts.isExpressionStatement(node.parent) || ts.isVoidExpression(node.parent)) return false;
    if (ts.isCallExpression(node.parent)) return isRepositoryConsumer(node.parent);
    if (!ts.isVariableDeclaration(node.parent) || !ts.isIdentifier(node.parent.name))
      return ts.isReturnStatement(node.parent);
    const declarationName = node.parent.name;
    const name = declarationName.text;
    let consumed = false;
    const findUse = (candidate: ts.Node): void => {
      if (
        ts.isIdentifier(candidate) &&
        candidate.text === name &&
        candidate !== declarationName &&
        ts.isCallExpression(candidate.parent) &&
        candidate.parent.arguments.includes(candidate) &&
        isRepositoryConsumer(candidate.parent)
      )
        consumed = true;
      ts.forEachChild(candidate, findUse);
    };
    findUse(file);
    return consumed;
  };
  const modeCalls: Record<RepositoryReadMode, number> = {
    head_snapshot: 0,
    isolated_fixture: 0,
  };
  let forbidden = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "__dirname") forbidden = true;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      ["dirname", "url"].includes(node.name.text)
    )
      forbidden = true;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ["process", "node:process"].includes(node.moduleSpecifier.text)
    )
      forbidden = true;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (element) =>
          element.propertyName?.getText(file) === "cwd" || element.name.getText(file) === "cwd",
      ) &&
      node.initializer &&
      isProcessReference(node.initializer)
    )
      forbidden = true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "cwd" &&
      isProcessRef(node.expression.expression)
    )
      modeCalls.isolated_fixture += 1;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      headFunctionAliases.has(node.expression.text) &&
      !isStaticallyDead(node) &&
      isConsumedRootCall(node)
    )
      modeCalls.head_snapshot += 1;
    if (ts.isCallExpression(node) && isDirectRepositoryRead(node, readAliases, pathAliases))
      modeCalls.isolated_fixture += 1;
    if (ts.isCallExpression(node)) {
      const writeName = writeApiName(node, writeAliases);
      const targetArgs = writeName
        ? writeName === "open" || writeName === "openSync" || writeName === "createWriteStream"
          ? isWriteCapableOpen(node, writeName)
            ? [0]
            : []
          : (MUTATION_TARGET_ARGS[writeName] ?? [])
        : [];
      if (
        targetArgs.some((index) => node.arguments[index] && containsHeadRoot(node.arguments[index]))
      )
        forbidden = true;
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "cwd" &&
      isProcessRef(node.expression) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    )
      forbidden = true;
    if (ts.isElementAccessExpression(node) && isProcessReference(node.expression)) forbidden = true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "process"
    )
      forbidden = true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isProcessRef(node.expression.expression) &&
      node.expression.name.text === "env" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      ["INIT_CWD", "PWD"].includes(node.argumentExpression.text)
    )
      forbidden = true;
    if (
      ts.isPropertyAccessExpression(node) &&
      isProcessRef(node.expression) &&
      node.name.text === "chdir"
    )
      forbidden = true;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isProcessRef(node.expression.expression) &&
      node.expression.name.text === "env"
    ) {
      if (["INIT_CWD", "PWD"].includes(node.name.text)) forbidden = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { modeCalls, forbidden };
}

export function analyzeTestRepositoryIsolation(input: {
  files: Array<{ path: string; source: string }>;
  contracts?: Readonly<Record<string, RepositoryReadContract>>;
}): LintResult {
  const contracts = input.contracts ?? REPOSITORY_READ_CONTRACTS;
  const actual = new Map<string, Record<RepositoryReadMode, number>>();
  const forbidden: string[] = [];
  for (const file of input.files) {
    const path = file.path.replaceAll("\\", "/");
    const inspected = inspectSource(path, file.source);
    if (inspected.forbidden) {
      forbidden.push(`forbidden-live-root-source:${path}`);
    }
    const calls = inspected.modeCalls.head_snapshot + inspected.modeCalls.isolated_fixture;
    if (calls > 0) actual.set(path, inspected.modeCalls);
  }
  const violations: string[] = [...forbidden];
  for (const [path, modeCalls] of actual) {
    const contract = contracts[path];
    const calls = modeCalls.head_snapshot + modeCalls.isolated_fixture;
    if (!contract) violations.push(`unclassified:${path}:repository-read=${calls}`);
    else {
      const expected =
        contract.mode_calls ??
        (contract.mode && contract.calls !== undefined ? { [contract.mode]: contract.calls } : {});
      for (const mode of ["head_snapshot", "isolated_fixture"] as const) {
        const expectedCalls = expected[mode] ?? 0;
        if (expectedCalls !== modeCalls[mode])
          violations.push(
            `callsite-drift:${path}:${mode}:expected=${expectedCalls}:actual=${modeCalls[mode]}`,
          );
      }
    }
  }
  for (const path of Object.keys(contracts)) {
    if (!actual.has(path)) violations.push(`stale-contract:${path}`);
  }
  return violations.length === 0
    ? {
        ok: true,
        messages: [`test-repository-isolation - OK (contracts=${actual.size}, live_runtime=0)`],
      }
    : {
        ok: false,
        messages: violations.map(
          (violation) => `test-repository-isolation - violation: ${violation}`,
        ),
      };
}

function testFiles(root: string): Array<{ path: string; source: string }> {
  const testsRoot = join(root, "tests");
  const pending = [testsRoot];
  const files: Array<{ path: string; source: string }> = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          source: readFileSync(path, "utf8"),
        });
      }
    }
  }
  return files;
}

export function checkTestRepositoryIsolation(repoRoot: string): LintResult {
  try {
    return analyzeTestRepositoryIsolation({ files: testFiles(repoRoot) });
  } catch {
    return {
      ok: false,
      messages: ["test-repository-isolation - violation: scan-error"],
    };
  }
}
