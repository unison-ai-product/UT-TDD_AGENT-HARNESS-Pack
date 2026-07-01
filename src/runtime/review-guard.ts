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
 * literal な review エイリアス (reviewer/review/security/audit/code-review/code-reviewer) も
 * 同区分に含め、実 delegation で使われる表記ゆれを吸収する。worker ロール・未知ロールは
 * 含めない (誤検知回避 — guard はレビュー session の変更のみを対象とする)。
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

export interface ReviewSessionInput {
  role: string;
  /** session 開始前の working-tree 変更パス (git status --porcelain 由来)。 */
  before: string[];
  /** session 終了後の working-tree 変更パス。 */
  after: string[];
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
  const mutatedPaths = detectWorkingTreeMutation(input.before, input.after);
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
