/**
 * Runtime-agnostic edit target extraction shared by guard surfaces.
 *
 * Work-guard and write-encoding-guard both need to understand Claude/Codex
 * edit payloads, but they live in different module bands. Keeping this helper
 * under shared avoids lint<->runtime dependencies while preserving one parser.
 */

/**
 * Windows 絶対パス / バックスラッシュ / repoRoot 接頭辞を repo-relative forward-slash へ正規化。
 * git porcelain と tool_input.file_path の表記差を吸収する。
 */
export function normalizeRepoRelative(path: string, repoRoot: string): string {
  const unify = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = unify(path.trim());
  const root = unify(repoRoot.trim());
  if (root) {
    const idx = target.toLowerCase().indexOf(`${root.toLowerCase()}/`);
    if (idx >= 0) {
      return target.slice(idx + root.length + 1);
    }
  }
  return target.replace(/^\.\//, "");
}

/**
 * `apply_patch` (Codex freeform) の patch 本文ヘッダ。1 patch に複数ファイルセクションが入る。
 * rename は `*** Update File: <old>` + `*** Move to: <new>` の 2 パスを持つ。
 */
const PATCH_HEADER_RE =
  /\*\*\*[ \t]+(?:Update File|Add File|Delete File|Move to):[ \t]*([^\r\n]+)/g;

function collectStringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStringLeaves(v, out);
  }
}

function stripPathQuotes(p: string): string {
  return p
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * tool_input から編集対象パス群を抽出する純関数。
 *
 * Claude `Edit|Write|MultiEdit` と Codex `write_file` は `tool_input.file_path` / `.path` を運ぶが、
 * Codex の `apply_patch` は freeform で、編集対象パスは patch 本文ヘッダに埋め込まれる。
 */
export function extractEditTargets(toolInput: unknown): string[] {
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    const obj = toolInput as Record<string, unknown>;
    const explicit: string[] = [];
    for (const key of ["file_path", "path"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) explicit.push(v.trim());
    }
    if (explicit.length > 0) return [...new Set(explicit)];
  }
  const strings: string[] = [];
  collectStringLeaves(toolInput, strings);
  const targets: string[] = [];
  for (const s of strings) {
    if (!s.includes("*** ")) continue;
    PATCH_HEADER_RE.lastIndex = 0;
    for (let m = PATCH_HEADER_RE.exec(s); m !== null; m = PATCH_HEADER_RE.exec(s)) {
      const p = stripPathQuotes(m[1]);
      if (p) targets.push(p);
    }
  }
  return [...new Set(targets)];
}
