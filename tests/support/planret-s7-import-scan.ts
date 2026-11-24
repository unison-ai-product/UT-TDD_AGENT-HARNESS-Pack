import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { sources } from "./planret-s7-acceptance.ts";

/** (h): `plan lint` の互換入口 (top-level の `plan` command か、`plan lint` を command 名に持つ定義)。 */
export function scanHPlanLintEntry(root: string): string[] {
  return sources(root)
    .filter((s) => /^src\/(cli\.ts|cli\/)/.test(s.path))
    .flatMap((s) => {
      const text = s.lines.join("\n");
      return [...text.matchAll(/(\w+)\s*\.command\(\s*["'`]plan(?:\s+lint)?(?:\s[^"'`]*)?["'`]/g)]
        .filter((m) => m[1] !== "distribution")
        .map((m) => `${s.path}:${text.slice(0, m.index).split("\n").length}`);
    });
}

const PLAN_ASSET_SPECIFIER = /plan-asset/;

/** (i): 1 file の中で、`plan-asset` を指す静的 import / re-export / 副作用 import / 動的 import / require の行番号。 */
export function scanIImportsSource(path: string, text: string): number[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const mark = (node: ts.Node, specifier: ts.Node | undefined) => {
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      PLAN_ASSET_SPECIFIER.test(specifier.text)
    ) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      mark(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      mark(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      mark(node, node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      mark(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/** (i): src / scripts / tests の JS・TS の tracked file の import と、`.github` の tracked file の `src/plan-asset` 参照。 */
export function scanIPlanAssetImports(root: string): string[] {
  const paths = execFileSync("git", ["ls-files", "src", "scripts", "tests", ".github"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  return paths.flatMap((path) => {
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      return [];
    }
    if (/\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(path)) {
      return scanIImportsSource(path, text).map((line) => `${path}:${line}`);
    }
    if (path.startsWith(".github/")) {
      return text
        .split("\n")
        .flatMap((l, i) => (/src\/plan-asset\b/.test(l) ? [`${path}:${i + 1}`] : []));
    }
    return [];
  });
}
