/**
 * review-guard — 委譲レビュー (read-only/判断ロール) の非破壊性を機械強制する (IMP-137)。
 *
 * 背景: full-access の委譲 Codex が DESK REVIEW (実装代行しない明示) 中に off-task で
 * 共有ファイルを直接編集し、その混入が commit へ紛れ込んで doctor が後追いで赤化した
 * (A-140 / IMP-137、IMP-125 同型の agent overstep)。本モジュールは
 *   ① read-only 期待ロール (相談/検証 archetype) が working tree を変更したら検知する
 *   ② 検知結果を warning として surface し、staged へ混入する前に弾く規律へ繋ぐ
 * を純関数で提供する。git/fs 端点は持たない (before/after の porcelain path 配列を受け取る)
 * — I/O は呼び出し側 (cli) の loadChangedFiles / loadStagedFiles が担い、module-boundary
 * (runtime は lint を import しない) を保つ。
 *
 * 純関数 (assess / detect 群) + message builder の分離は analyzeX / loadX 方針と同じ。
 */

/**
 * read-only (非破壊) を期待する委譲ロール集合。§1.8 role taxonomy の相談 (tl/uiux) +
 * 検証 (qa) archetype は「判断側」であり実装代行しない (worker=se/docs のみ書き込み)。
 * literal な review エイリアス (reviewer/review/security/audit/code-review/code-reviewer/
 * blind-review/blind-reviewer) も同区分に含め、実 delegation で使われる表記ゆれを吸収する。
 * blind-review* は Codex 側ブラインドレビュー委譲 (ut-tdd codex --role blind-reviewer) の
 * 非破壊性を強制する (著者主張を渡さない判定ロールは実装代行しない)。worker ロール・
 * 未知ロールは含めない (誤検知回避 — guard はレビュー session の変更のみを対象とする)。
 */
export const READ_ONLY_DELEGATION_ROLES: ReadonlySet<string> = new Set([
  "tl",
  "qa",
  "uiux",
  "reviewer",
  "review",
  "security",
  "audit",
  "code-review",
  "code-reviewer",
  "blind-review",
  "blind-reviewer",
]);

/** role を正規化 (trim + lowercase)。 */
function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

/** role が read-only (相談/検証) 委譲か。worker/未知は false。 */
export function isReadOnlyDelegationRole(role: string): boolean {
  return READ_ONLY_DELEGATION_ROLES.has(normalizeRole(role));
}

/**
 * before/after の working-tree 変更パス配列から、session が新たに変更したパスを返す。
 * 「after にあって before に無い」= session 由来の変更。決定論のため sorted + unique。
 * 境界: session 前から dirty だった path への追加編集は検知しない (path-presence ベース)。
 * IMP-137 の実 failure mode (clean な共有ファイルへの off-task 編集) は新規 dirty ゆえ捕捉する。
 */
export function detectWorkingTreeMutation(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const mutated = new Set<string>();
  for (const path of after) {
    if (!beforeSet.has(path)) mutated.add(path);
  }
  return [...mutated].sort();
}

/** 委譲機構が管理する review custody 投影。reviewer 本人の編集ではない。 */
export function isReviewCustodyProjection(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return /^\.ut-tdd\/review\/(?:requests|receipts|verdicts)\//.test(normalized);
}

/** `.ut-tdd/memory/` containment の先頭 segment 列 (case-sensitive、順序固定)。 */
const MEMORY_DIR_SEGMENTS = [".ut-tdd", "memory"] as const;

/**
 * `path` が `.ut-tdd/memory/` 配下に厳密に containment されているかを判定する。
 * git は常に `/` 区切りで path を返す (プラットフォームに依らず POSIX-style) ため、ここでは
 * セパレータ変換を一切行わない — `\` を含む path はセパレータではなく疑わしい入力として
 * 拒否する (Sol r1 FLAG 1、issue #721)。判定は case-sensitive (git path は case-sensitive) で
 * あり、`.` / `..` segment (`./` トリック、`../` 脱出) や空 segment (連続 `/`) を含む path も
 * containment 対象から除外する。
 */
function isUnderMemoryDirectory(path: string): boolean {
  if (path.length === 0 || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.length <= MEMORY_DIR_SEGMENTS.length) return false;
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return MEMORY_DIR_SEGMENTS.every((expected, index) => segments[index] === expected);
}

/**
 * hybrid 運用では他レーンが review session と並行して `ut-tdd memory add` を実行し、
 * `.ut-tdd/memory/` 配下へ新規 untracked ファイルを追加することがある (reviewer 本人の
 * 編集ではない、issue #721 / PR #719 2026-09-28)。「新規 untracked 追加」に限って exempt する
 * — session 開始前から tracked だった memory ファイルへの上書き編集は対象外 (untrackedAdded に
 * 含まれない限り exemption しない)。containment は `isUnderMemoryDirectory` が厳密判定する
 * (セパレータ変換なし、`..`/`.`/case 違いは非対象)。untracked/tracked の判定は呼び出し側の
 * porcelain 走査が担う (本 module は git/fs を持たない純関数のまま)。
 */
export function isExemptUntrackedMemoryAddition(
  path: string,
  untrackedAdded: ReadonlySet<string>,
): boolean {
  if (!isUnderMemoryDirectory(path)) return false;
  return untrackedAdded.has(path);
}

export interface ReviewSessionInput {
  role: string;
  /** session 開始前の working-tree 変更パス (git status --porcelain 由来)。 */
  before: string[];
  /** session 終了後の working-tree 変更パス。 */
  after: string[];
  /**
   * session 終了後時点で untracked-added (`??`) だった working-tree パス (任意)。
   * `.ut-tdd/memory/` 配下でこの集合に含まれるパスのみ exemption 対象になる
   * (issue #721)。未提供時は exemption なし (既存挙動を維持、後方互換)。
   */
  untrackedAdded?: string[];
}

export interface ReviewSessionAssessment {
  role: string;
  /** role が read-only 委譲 (相談/検証) か。 */
  readOnly: boolean;
  /** session が新たに変更したパス。 */
  mutatedPaths: string[];
  /** read-only 委譲が working tree を変更した = 違反 (要 inspect/隔離)。 */
  violation: boolean;
}

/**
 * 委譲レビュー session の非破壊性を評価する。read-only ロールが working tree を変更したら
 * violation=true。worker ロールの変更は正当ゆえ violation=false (mutatedPaths は記録)。
 */
export function assessReviewSession(input: ReviewSessionInput): ReviewSessionAssessment {
  const readOnly = isReadOnlyDelegationRole(input.role);
  const untrackedAdded = new Set(input.untrackedAdded ?? []);
  const mutatedPaths = detectWorkingTreeMutation(input.before, input.after).filter(
    (path) =>
      !isReviewCustodyProjection(path) && !isExemptUntrackedMemoryAddition(path, untrackedAdded),
  );
  return {
    role: normalizeRole(input.role),
    readOnly,
    mutatedPaths,
    violation: readOnly && mutatedPaths.length > 0,
  };
}

/**
 * 評価結果を人間/機械可読の warning 行に変換する。violation 時のみ非空。
 * IMP-137 の再発防止ガイダンス (staged へ混入する前に inspect/revert) を添える。
 */
export function reviewGuardMessages(assessment: ReviewSessionAssessment): string[] {
  if (!assessment.violation) return [];
  const paths = assessment.mutatedPaths.join(", ");
  return [
    `review-guard - violation: read-only role '${assessment.role}' mutated ${assessment.mutatedPaths.length} tracked path(s): ${paths}`,
    "review-guard - note: a review/consult delegation must stay non-destructive (IMP-137); inspect and revert off-task edits before 'git add' so they cannot leak into a commit.",
  ];
}

/** staged ファイル一覧から review 確認用サマリを作る純関数 (commit 前 staged-diff 確認の機械化)。 */
export interface StagedReviewSummary {
  staged: string[];
  /** staged のうち read-only review session が変更したパス (混入疑い)。 */
  suspect: string[];
  ok: boolean;
}

/**
 * commit 前の staged 集合を review session が変更したパス集合 (任意) と突き合わせる。
 * staged ∩ review-mutated は IMP-137 の混入パターン (off-task review 編集の staged) ゆえ
 * suspect として surface する。reviewMutated 未提供時は suspect 空 (純列挙)。
 */
export function summarizeStagedReview(
  staged: string[],
  reviewMutated: string[] = [],
): StagedReviewSummary {
  const mutatedSet = new Set(reviewMutated);
  const sortedStaged = [...new Set(staged)].sort();
  const suspect = sortedStaged.filter((path) => mutatedSet.has(path));
  return { staged: sortedStaged, suspect, ok: suspect.length === 0 };
}
