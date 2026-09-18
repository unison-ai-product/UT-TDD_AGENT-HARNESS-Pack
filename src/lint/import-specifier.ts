/**
 * import-specifier lint — 相対 import 指定子の拡張子必須 gate (PLAN-L7-462 PR-A、AC-5)。
 *
 * 契約 (PLAN-L7-462 設計判断節): 対象 4 ディレクトリ (src/ tests/ scripts/ .claude/hooks/) の
 * `.ts` ファイルにおいて、相対 import 指定子は**実在する `.ts` ファイルを指す拡張子付き**で
 * あること。拡張子なし (Node ESM で ERR_MODULE_NOT_FOUND) だけでなく `.js` 指定子
 * (bun は解決するが node は fail する不可視 blocker) も fail-close する。
 *
 * 検出は TypeScript compiler API の AST で行う: 文字列リテラル・template literal・コメント・
 * 正規表現リテラルの中身を code として読まない (tests/ の fixture 文字列に埋まった import 記述を
 * 誤検出しない。初版の手書き mini-scanner は regex literal で desync し 26/634 ファイルの
 * 盲点を作った — blind review BL-1。dependency-drift / ddd-tdd-rules と同じ AST 経路へ統一)。
 *
 * 純関数 (analyzeImportSpecifiers) + I/O loader (loadImportSpecifierInput) を分離 (lint 共通様式)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

export const IMPORT_SPECIFIER_SCOPES = ["src", "tests", "scripts", ".claude/hooks"] as const;

export interface ImportSpecifierDoc {
  /** repo-relative posix path。 */
  path: string;
  text: string;
}

export interface ImportSpecifierViolation {
  path: string;
  line: number;
  specifier: string;
  rule: "missing-extension" | "js-specifier" | "unresolved-ts-target";
  message: string;
}

export interface ImportSpecifierResult {
  checked: number;
  specifiers: number;
  violations: ImportSpecifierViolation[];
  ok: boolean;
}

interface FoundSpecifier {
  specifier: string;
  line: number;
}

/**
 * import 系構文の文字列リテラル指定子を TypeScript AST で抽出する。
 * 対象: `import ... from "x"` / `export ... from "x"` / `import "x"` / `import("x")` /
 * `require("x")` / `vi.mock("x")`。文字列・template・コメント・regex literal 内は
 * AST 上 code でないため構造的に誤検出しない。複数行 import も構文単位で拾う。
 */
export function extractImportSpecifiers(text: string): FoundSpecifier[] {
  const file = ts.createSourceFile(
    "input.ts",
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const found: FoundSpecifier[] = [];
  const push = (literal: ts.StringLiteralLike): void => {
    found.push({
      specifier: literal.text,
      line: file.getLineAndCharacterOfPosition(literal.getStart(file)).line + 1,
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier != null &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const arg = node.arguments[0];
      const callee = node.expression;
      const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isViMock =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "vi" &&
        callee.name.text === "mock";
      if ((isImportCall || isRequire || isViMock) && ts.isStringLiteralLike(arg)) push(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export interface ImportSpecifierInput {
  docs: ImportSpecifierDoc[];
  /** repo-relative posix path の実在ファイル集合 (解決検証用)。 */
  files: Set<string>;
}

function resolveRelative(fromPath: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(fromPath), specifier));
}

export function analyzeImportSpecifiers(input: ImportSpecifierInput): ImportSpecifierResult {
  const violations: ImportSpecifierViolation[] = [];
  let specifiers = 0;
  for (const doc of input.docs) {
    for (const { specifier, line } of extractImportSpecifiers(doc.text)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      specifiers += 1;
      if (specifier.endsWith(".js")) {
        violations.push({
          path: doc.path,
          line,
          specifier,
          rule: "js-specifier",
          message: `相対 .js 指定子は禁止 (node は解決できない): ${specifier} → .ts へ書き換える`,
        });
        continue;
      }
      // 相対 .json は現状 0 件の意図的例外 (node では import attributes も要るため、
      // 実際に導入する PR がこの分岐を契約ごと更新する — blind review mn-4 記録)。
      if (specifier.endsWith(".json")) continue;
      if (!specifier.endsWith(".ts")) {
        violations.push({
          path: doc.path,
          line,
          specifier,
          rule: "missing-extension",
          message: `相対 import は実在 .ts を指す拡張子必須 (Node ESM): ${specifier} → ${specifier}.ts 等へ書き換える`,
        });
        continue;
      }
      const target = resolveRelative(doc.path, specifier);
      if (!input.files.has(target)) {
        violations.push({
          path: doc.path,
          line,
          specifier,
          rule: "unresolved-ts-target",
          message: `相対 .ts 指定子が実在ファイルを指していない: ${specifier} (解決先 ${target})`,
        });
      }
    }
  }
  return { checked: input.docs.length, specifiers, violations, ok: violations.length === 0 };
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

export function loadImportSpecifierInput(repoRoot: string): ImportSpecifierInput {
  const all: string[] = [];
  for (const scope of IMPORT_SPECIFIER_SCOPES) {
    try {
      walk(repoRoot, scope, all);
    } catch {
      // scope が無い checkout (Pack 等) は skip (fail-open ではなく対象不在)。
    }
  }
  const files = new Set(all);
  const docs = all
    .filter((p) => p.endsWith(".ts"))
    .map((p) => ({ path: p, text: readFileSync(join(repoRoot, p), "utf8") }));
  // scope 外 (repo root 等) の実在 target も解決対象に補完する (例: tests/ → ../vitest.config.ts)。
  for (const doc of docs) {
    for (const { specifier } of extractImportSpecifiers(doc.text)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      if (!specifier.endsWith(".ts")) continue;
      const target = resolveRelative(doc.path, specifier);
      if (files.has(target)) continue;
      try {
        if (statSync(join(repoRoot, target)).isFile()) files.add(target);
      } catch {
        // 実在しない target は analyze 側で violation にする。
      }
    }
  }
  return { docs, files };
}

export function renderImportSpecifierMessages(r: ImportSpecifierResult): string[] {
  if (r.ok) {
    return [
      `import-specifier — OK (checked=${r.checked}, relative specifiers=${r.specifiers}, 拡張子違反 0)`,
    ];
  }
  const head = r.violations.slice(0, 10).map((v) => `${v.path}:${v.line} ${v.rule} ${v.specifier}`);
  return [
    `import-specifier — violation ${r.violations.length} 件 (相対 import は実在 .ts 拡張子必須、PLAN-L7-462 PR-A): ${head.join("; ")}`,
  ];
}

/** doctor 配線用 (check-definition-groups から呼ぶ)。 */
export function checkImportSpecifiers(repoRoot: string): { messages: string[]; ok: boolean } {
  const result = analyzeImportSpecifiers(loadImportSpecifierInput(repoRoot));
  return { messages: renderImportSpecifierMessages(result), ok: result.ok };
}
