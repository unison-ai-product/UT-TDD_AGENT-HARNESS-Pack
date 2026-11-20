import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import ts from "typescript";
import type { LintResult } from "../lint/lint-result.ts";

export type WindowsHideSource = { path: string; content: string };
export type WindowsHideInput = { sources: WindowsHideSource[]; entries: string[] };
export type WindowsHideResult = { ok: boolean; messages: string[] };

const WRAPPER_PATH = "src/runtime/windows-hide.ts";
const STATIC_ENTRIES = ["src/cli.ts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".cjs", ".js"]);
const SCAN_ROOTS = ["src", "scripts", ".claude/hooks", "tests"];

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function isSourcePath(path: string): boolean {
  const normalized = slash(path);
  return (
    SCAN_ROOTS.some((root) => normalized.startsWith(`${root}/`)) &&
    SOURCE_EXTENSIONS.has(normalized.slice(normalized.lastIndexOf(".")))
  );
}

function sourceFile(source: WindowsHideSource): ts.SourceFile {
  return ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true);
}

function importPath(importDeclaration: ts.ImportDeclaration): string | undefined {
  return ts.isStringLiteral(importDeclaration.moduleSpecifier)
    ? importDeclaration.moduleSpecifier.text
    : undefined;
}

function resolvesToWrapper(entryPath: string, specifier: string): boolean {
  const resolved = slash(normalize(join(dirname(entryPath), specifier)));
  return resolved === WRAPPER_PATH || resolved === WRAPPER_PATH.replace(/\.ts$/, "");
}

function hasLeadingWrapperImport(source: WindowsHideSource): boolean {
  const file = sourceFile(source);
  const imports = file.statements.filter(ts.isImportDeclaration);
  const firstImport = imports[0];
  return Boolean(
    firstImport &&
      firstImport === file.statements.find(ts.isImportDeclaration) &&
      firstImport.importClause === undefined &&
      importPath(firstImport) !== undefined &&
      resolvesToWrapper(source.path, importPath(firstImport) as string),
  );
}

function setupEntries(source: WindowsHideSource | undefined): string[] {
  if (!source) return [];
  const file = sourceFile(source);
  const entries: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "setupFiles" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteralLike(element)) entries.push(slash(element.text.replace(/^\.\//, "")));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return entries;
}

function importsChildProcess(source: WindowsHideSource): boolean {
  const file = sourceFile(source);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(?:node:)?child_process$/.test(node.moduleSpecifier.text)
    ) {
      found = true;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      /^(?:node:)?child_process$/.test(node.arguments[0].text)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function windowsHideFalseLines(source: WindowsHideSource): { line: number; explained: boolean }[] {
  const file = sourceFile(source);
  const findings: { line: number; explained: boolean }[] = [];
  const commentsByLine = new Map<number, string[]>();
  const commentRanges = new Map<number, ts.CommentRange>();
  const collectCommentRanges = (node: ts.Node): void => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(source.content, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(source.content, node.end) ?? []),
    ]) {
      if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
        commentRanges.set(range.pos, range);
      }
    }
    ts.forEachChild(node, collectCommentRanges);
  };
  collectCommentRanges(file);
  for (const range of commentRanges.values()) {
    const line = file.getLineAndCharacterOfPosition(range.pos).line;
    const comments = commentsByLine.get(line) ?? [];
    comments.push(source.content.slice(range.pos, range.end));
    commentsByLine.set(line, comments);
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "windowsHide") ||
        (ts.isStringLiteral(node.name) && node.name.text === "windowsHide")) &&
      node.initializer.kind === ts.SyntaxKind.FalseKeyword
    ) {
      const line = file.getLineAndCharacterOfPosition(node.name.getStart(file)).line;
      const hasReason = [line, line - 1].some((commentLine) =>
        (commentsByLine.get(commentLine) ?? []).some((comment) =>
          /^\/\/\s*windows-hide:\s*\S/.test(comment),
        ),
      );
      findings.push({ line: line + 1, explained: hasReason });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

export function analyzeWindowsHide(input: WindowsHideInput): WindowsHideResult {
  const sources = input.sources.filter((source) => isSourcePath(source.path));
  const byPath = new Map(sources.map((source) => [slash(source.path), source]));
  const config = input.sources.find((source) => slash(source.path) === "vitest.config.ts");
  const messages: string[] = [];
  const configuredSetupEntries = setupEntries(config);
  const entries = [...new Set([...STATIC_ENTRIES, ...input.entries, ...configuredSetupEntries])]
    .map(slash)
    .sort();

  if (config && configuredSetupEntries.length === 0) {
    messages.push(
      "vitest.config.ts:1: windows-hide-entry-missing: test setupFiles must include a wrapper entry",
    );
  }

  if (!byPath.has(WRAPPER_PATH)) {
    messages.push(`${WRAPPER_PATH}:1: windows-hide-entry-missing: wrapper source is absent`);
  }
  for (const entry of entries) {
    const source = byPath.get(entry);
    if (!source || !hasLeadingWrapperImport(source)) {
      messages.push(
        `${entry}:1: windows-hide-entry-missing: first import must load ${WRAPPER_PATH}`,
      );
    }
  }

  let falseCount = 0;
  for (const source of sources) {
    for (const finding of windowsHideFalseLines(source)) {
      falseCount += 1;
      if (!finding.explained) {
        messages.push(
          `${slash(source.path)}:${finding.line}: windows-hide-false-unexplained: add a non-empty // windows-hide: reason`,
        );
      }
    }
  }
  messages.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const violations = messages.length;
  messages.push(
    `checked=${sources.length} entries=${entries.length} falses=${falseCount} violations=${violations}`,
  );
  return { ok: violations === 0, messages };
}

function walk(root: string, directory: string): string[] {
  const absolute = join(root, directory);
  try {
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) return walk(root, child);
      const extension = child.slice(child.lastIndexOf("."));
      return SOURCE_EXTENSIONS.has(extension) ? [slash(child)] : [];
    });
  } catch {
    return [];
  }
}

export function loadWindowsHideInput(repoRoot: string): WindowsHideInput {
  const paths = [
    ...STATIC_ENTRIES,
    ...SCAN_ROOTS.flatMap((directory) => walk(repoRoot, directory)),
    "vitest.config.ts",
  ];
  const uniquePaths = [...new Set(paths)].sort();
  const sources = uniquePaths.flatMap((path) => {
    try {
      return [{ path, content: readFileSync(resolve(repoRoot, path), "utf8") }];
    } catch {
      return [];
    }
  });
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const hookEntries = sources
    .filter((source) => source.path.startsWith(".claude/hooks/"))
    .map((source) => source.path);
  const scriptEntries = sources
    .filter(
      (source) =>
        source.path.startsWith("scripts/") &&
        source.path !== "scripts/pack-canary-acceptance.mjs" &&
        importsChildProcess(source),
    )
    .map((source) => source.path);
  return {
    sources,
    entries: [
      ...STATIC_ENTRIES,
      ...hookEntries,
      ...scriptEntries,
      ...setupEntries(byPath.get("vitest.config.ts")),
    ],
  };
}

export function checkWindowsHide(repoRoot: string): LintResult {
  try {
    const result = analyzeWindowsHide(loadWindowsHideInput(repoRoot));
    return { ok: result.ok, messages: result.messages };
  } catch (error) {
    return {
      ok: false,
      messages: [`windows-hide - violation: required source could not be read (${String(error)})`],
    };
  }
}
