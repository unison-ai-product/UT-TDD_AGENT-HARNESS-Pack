// A-120 共通化: lint / vmodel が各自コピペしていた frontmatter / DbC / TS module 判定を単一正本化する。
// 配置 = src/lint (domain-boundary: lint 内 import と vmodel→lint import は許可)。
import { basename } from "node:path";
import type ts from "typescript";

/**
 * frontmatter 1 行 `key: value` の value を取り出す。
 * 末尾の YAML inline コメント (` # ...`) は値に含めない (scrum-reverse 版を canonical 採用)。
 * 値なし / key 不在は undefined。
 */
export function fmValue(content: string, key: string): string | undefined {
  return content.match(new RegExp(`^${key}:\\s*(.+?)\\s*(?:#.*)?$`, "m"))?.[1]?.trim();
}

// L6 機能設計の DbC テーブル見出し (関数仕様の substance マーカー)。
// l6-completion (freeze readiness) と l6-fr-coverage (FR 被覆) が同一判定を要するため共有する。
const DBC_TABLE_FULL =
  /\|\s*Function\(s\)\s*\|\s*Signature\s*\|\s*pre\s*\|\s*post\s*\|\s*invariant\s*\|\s*oracle\s*\|/i;
const DBC_TABLE_MIN = /\|\s*Function\s*\|\s*Signature\s*\|\s*pre\s*\|\s*post/i;

/** L6 spec doc が DbC 契約テーブル (Function/Signature/pre/post...) を持つか。 */
export function hasDbcTable(text: string): boolean {
  return DBC_TABLE_FULL.test(text) || DBC_TABLE_MIN.test(text);
}

// A-120 I-2: coding-rules / ddd-tdd-rules の境界チェックが各自コピペしていた
// TS module 解決 helper を単一正本化する (boundary 判定そのものは各 lint で別ルール = 統合しない)。

/** OS path 区切りを `/` に正規化。 */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** AST ノード位置 → 1-origin 行番号。 */
export function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

/** `src/<module>/...` の <module> 名 (src 直下ファイルは拡張子除く basename)。src 外は null。 */
export function sourceModule(path: string): string | null {
  const parts = normalizePath(path).split("/");
  if (parts[0] !== "src") return null;
  if (parts.length === 2) return basename(parts[1], ".ts");
  return parts[1] ?? null;
}

/** 相対 import specifier を解決し、import 先の src module 名を返す。外部/src 外は null。 */
export function importedSourceModule(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromParts = normalizePath(fromPath).split("/");
  if (fromParts[0] !== "src") return null;
  const resolvedParts: string[] = [];
  for (const part of [...fromParts.slice(0, -1), ...specifier.split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolvedParts.pop();
      continue;
    }
    resolvedParts.push(part);
  }
  if (resolvedParts[0] !== "src") return null;
  if (resolvedParts.length === 2) return basename(resolvedParts[1], ".ts");
  return resolvedParts[1] ?? null;
}
