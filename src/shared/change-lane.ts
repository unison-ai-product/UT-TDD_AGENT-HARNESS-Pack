export type ChangeLane = "doc" | "full";

export interface ChangeLaneClassification {
  lane: ChangeLane;
  reason: string;
  fileCount: number;
}

/**
 * doc-safe とみなす非正本の参照 prose prefix (allowlist の SSoT)。
 *
 * `.github/workflows/harness-check.yml` の header コメントはこの配列を転記しており、
 * `tests/change-lane.test.ts` が header を parse して集合一致を検査する
 * (コメントが実装より広い allowlist を記述する drift の再発防止、2026-07-28)。
 */
export const DOC_LANE_PREFIXES = [
  "docs/archive/",
  "docs/migration/",
  "docs/reference/",
  "docs/research/",
] as const;

function normalizeChangedPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 単一の変更 path が doc-safe allowlist に一致するか (fail-close: 未知 path は false)。
 * allowlist は意図的に狭い: 非正本の参照 prose 4 treeにある `*.md` のみ。
 */
export function isDocSafeChangePath(path: string): boolean {
  const normalized = normalizeChangedPath(path);
  if (!normalized) return false;
  return (
    DOC_LANE_PREFIXES.some((prefix) => normalized.startsWith(prefix)) && /\.md$/i.test(normalized)
  );
}

/** 変更ファイル一覧から lane を判定する純粋関数 (git 非依存、fail-close)。 */
export function classifyChangeLane(changedFiles: readonly string[]): ChangeLaneClassification {
  const files = changedFiles.map((file) => file.trim()).filter(Boolean);
  if (files.length === 0) {
    return {
      lane: "full",
      reason: "no-changed-files (fail-close: cannot confirm doc-only)",
      fileCount: 0,
    };
  }
  const unsafe = files.filter((file) => !isDocSafeChangePath(file));
  if (unsafe.length > 0) {
    return {
      lane: "full",
      reason: `non-doc-lane-path (fail-close): ${unsafe.slice(0, 5).join(", ")}${
        unsafe.length > 5 ? ", ..." : ""
      }`,
      fileCount: files.length,
    };
  }
  return {
    lane: "doc",
    reason: "all changed files match the noncanonical prose doc-lane allowlist",
    fileCount: files.length,
  };
}
