/**
 * Work guard (PLAN-L7-114) — PreToolUse(Edit|Write|MultiEdit) の作業衝突ガードレール。
 *
 * hybrid 多ランタイム (Claude ↔ Codex) では working tree を双方が同時に書き換える。
 * doc 規律「相手のファイルに触れない」だけでは盲目的なクロバー (互いの未コミット成果の
 * 上書き) を防げなかった (実際に surface.ts / PLAN を相互 adopt して衝突した)。本ガードは
 * その機械強制: **このセッションが触っていない uncommitted ファイル (= 他ランタイムの
 * in-flight 成果と推定) への Edit/Write を block** し、意図的な編集は override (+evidence)
 * を要求する。これにより「相手の成果の上に積む / 触る前に確認」を機械で担保する。
 *
 * 判定本体は純関数。git / session-log / env の I/O は hook 側 (.claude/hooks/work-guard.ts)。
 */

export interface WorkGuardInput {
  /** 編集対象 (repo-relative, forward-slash 正規化済)。 */
  targetPath: string;
  /** git 上の uncommitted パス群 (modified + untracked、repo-relative 正規化済)。 */
  uncommittedFiles: string[];
  /** このセッションが既に touch した (= 自分の作業) パス群 (正規化済)。 */
  sessionTouchedFiles: string[];
  /** override env (UT_TDD_ALLOW_FOREIGN_EDIT=1) が立っているか。 */
  bypass: boolean;
}

export interface WorkGuardResult {
  decision: "pass" | "block";
  /** 機械判定理由 (ledger / surface 用の安定キー)。 */
  reason: "bypass" | "foreign-uncommitted" | "clean-or-own" | "no-target";
  /** 人間向けメッセージ (block 時のみ非空)。 */
  message: string;
}

export interface WorkGuardTargetResult extends WorkGuardResult {
  targetPath: string;
}

export interface WorkGuardTargetsResult {
  decision: "pass" | "block";
  reason: WorkGuardResult["reason"];
  results: WorkGuardTargetResult[];
  blocked: WorkGuardTargetResult | null;
}

/**
 * Windows 絶対パス / バックスラッシュ / repoRoot 接頭辞を repo-relative forward-slash へ正規化。
 * git porcelain と Claude tool_input.file_path の表記差を吸収する (NFR-01 cross-platform)。
 */
export function normalizeRepoRelative(path: string, repoRoot: string): string {
  const unify = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = unify(path.trim());
  const root = unify(repoRoot.trim());
  if (root) {
    // session-log の target は "Write c:\\...\\repo\\src\\x.ts" のように tool 名プレフィックス +
    // 絶対パスで記録される。startsWith では prefix で外れるため、repoRoot を **部分一致** で探し、
    // その直後から repo-relative を取る (裸の絶対パスは idx=0 で従来と同一挙動 = 後方互換)。
    const idx = target.toLowerCase().indexOf(`${root.toLowerCase()}/`);
    if (idx >= 0) {
      return target.slice(idx + root.length + 1);
    }
  }
  return target.replace(/^\.\//, "");
}

/**
 * 作業衝突を評価する純関数。
 *
 * block 条件: target が uncommitted (他者 or 既存の未コミット変更) **かつ** このセッションが
 * 未 touch (= 自分が作った/触った形跡が無い = 他ランタイムの in-flight と推定) **かつ** 未 bypass。
 * 自分が今セッションで作成/編集中のファイル (session-touched) や、クリーンな (uncommitted でない)
 * ファイルへの編集は pass する (誤検知で自分の作業を止めない)。
 */
export function evaluateWorkGuard(input: WorkGuardInput): WorkGuardResult {
  if (!input.targetPath) {
    return { decision: "pass", reason: "no-target", message: "" };
  }
  if (input.bypass) {
    return { decision: "pass", reason: "bypass", message: "" };
  }
  const uncommitted = new Set(input.uncommittedFiles);
  const touched = new Set(input.sessionTouchedFiles);
  if (uncommitted.has(input.targetPath) && !touched.has(input.targetPath)) {
    return {
      decision: "block",
      reason: "foreign-uncommitted",
      message:
        `[ut-tdd-work-guard] BLOCK: ${input.targetPath} はこのセッションが触っていない uncommitted ファイルです` +
        ` (他ランタイムの in-flight 成果の可能性)。盲目的に編集すると相手の未コミット成果をクロバーします。` +
        ` git log / git status で出所を確認し、相手の commit の上に積む / 自分の意図ファイルのみ編集すること。` +
        ` 意図的に編集する場合のみ UT_TDD_ALLOW_FOREIGN_EDIT=1 (理由を記録) で override。`,
    };
  }
  return { decision: "pass", reason: "clean-or-own", message: "" };
}

export function evaluateWorkGuardTargets(input: {
  targetPaths: string[];
  uncommittedFiles: string[];
  sessionTouchedFiles: string[];
  bypass: boolean;
}): WorkGuardTargetsResult {
  const uniqueTargets = [...new Set(input.targetPaths.filter((target) => target.length > 0))];
  if (uniqueTargets.length === 0) {
    return {
      decision: "pass",
      reason: "no-target",
      results: [],
      blocked: null,
    };
  }
  const results = uniqueTargets.map((targetPath): WorkGuardTargetResult => {
    const result = evaluateWorkGuard({
      targetPath,
      uncommittedFiles: input.uncommittedFiles,
      sessionTouchedFiles: input.sessionTouchedFiles,
      bypass: input.bypass,
    });
    return { ...result, targetPath };
  });
  const blocked = results.find((result) => result.decision === "block") ?? null;
  if (blocked) {
    return {
      decision: "block",
      reason: blocked.reason,
      results,
      blocked,
    };
  }
  return {
    decision: "pass",
    reason: results.some((result) => result.reason === "bypass") ? "bypass" : "clean-or-own",
    results,
    blocked: null,
  };
}

/**
 * `apply_patch` (Codex freeform) の patch 本文ヘッダ。1 patch に複数ファイルセクションが入る。
 * rename は `*** Update File: <old>` + `*** Move to: <new>` の 2 パスを持つ (両方を編集対象とみなす)。
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
 * tool_input から編集対象パス群を抽出する純関数 (runtime-agnostic, PLAN-L7-139)。
 *
 * Claude `Edit|Write|MultiEdit` と Codex `write_file` は `tool_input.file_path` / `.path` を運ぶが、
 * Codex の主編集ツール `apply_patch` は **freeform** で、編集対象パスは patch 本文のヘッダ
 * (`*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:`) に埋め込まれる
 * (複数ファイル可)。`tool_input.file_path` だけを見ると apply_patch では undefined になり work-guard が
 * 黙って no-op = 偽パリティになる (Codex cross-runtime review Critical, codex.exe 0.128.0 実機で確認)。
 *
 * 抽出順:
 *  1. `file_path` / `path` があればそれ (= Claude/write_file 形)。この場合 content 本文は走査しない
 *     (doc が apply_patch 例文を含むと誤抽出して false-block するため)。
 *  2. file_path が無い = apply_patch (freeform)。tool_input の string leaf を走査し patch ヘッダから
 *     全ファイルパスを抽出する (正確な arg key (`input` / `command[]` 等) はランタイムで揺れるため
 *     leaf 全走査が安全)。どちらも取れなければ空配列 (= work-guard は no-target で fail-open)。
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

export interface ForeignEditOverride {
  bypass: boolean;
  /** どこから override したか (audit 用)。 */
  source: "env" | "marker" | "none";
  /** override 理由 (marker は本文、env は固定文言)。none は空。 */
  reason: string;
}

/**
 * foreign-edit override を解決する純関数 (agent-accessible 経路、PLAN-L7-114 correction)。
 *
 * override は 2 経路:
 *  - `env`: `UT_TDD_ALLOW_FOREIGN_EDIT=1` (人間が out-of-band で設定)。
 *  - `marker`: `.ut-tdd/state/foreign-edit-override` に **非空の理由** を書く。env はセッション中に
 *    agent が設定できないため、agent が意図的に foreign 編集する時はこの marker を使う。理由が空の
 *    marker は override 不成立 (silent bypass を許さない = 必ず理由を残す)。
 *
 * hook は marker bypass を durable log へ追記して audit する (証跡を残す)。
 */
export function resolveForeignEditOverride(opts: {
  env?: string;
  markerReason?: string | null;
}): ForeignEditOverride {
  if (opts.env === "1") {
    return { bypass: true, source: "env", reason: "UT_TDD_ALLOW_FOREIGN_EDIT=1" };
  }
  const reason = (opts.markerReason ?? "").trim();
  if (reason) {
    return { bypass: true, source: "marker", reason };
  }
  return { bypass: false, source: "none", reason: "" };
}
