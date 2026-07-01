/**
 * Feedback-log discipline lint (IMP-085、A-138 ITEM-3、cross_agent TL 裏取り済)。
 *
 * `docs/feedback-log.md` は PO フィードバックの可視 tracked トレイル (柱3)。各 FB エントリが
 * memory / IMP / doc へ実際にドメスティック化されたか (= `domesticated to` 非空 + `status≠open` +
 * 参照先の実在) は従来 human-依存だった。本 lint は improvement-backlog lint と同型の
 * existence/consistency 検査で「ドメスティック化されず放置」を fail-close で塞ぐ
 * (§1.10.G.12 backlog discipline / FR-L1-19 Learning Engine 手動橋渡しの隣接拡張)。
 *
 * 検査:
 *  - FB-ID 形式 (FB-NNN) + 一意性
 *  - status が enum 内 (open / domesticated / superseded)
 *  - 必須列の充足 (date/source/feedback/lesson/domesticated/status)
 *  - **未ドメスティック化**: status=open、または status≠superseded かつ `domesticated to` 空 → violation
 *  - **参照先実在 (in-repo verifiable)**: `domesticated to` の IMP-NNN が improvement-backlog に実在 /
 *    backtick path (`docs/...`/`src/...` 等) が repo に実在。
 *  - FB らしき行 (`| **FB…`) が parse されず黙って skip される absence-blindness の検出。
 *
 * 限界 (honest): memory `[[name]]` は agent-private (repo 外) なので存在突合しない。`domesticated to`
 * の非空のみ要求する (memory file の実在は in-repo では検証不能、false-confidence を作らないため明示)。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBacklogEntries } from "./improvement-backlog";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

export const VALID_FB_STATUS = ["open", "domesticated", "superseded"] as const;
export type FeedbackStatus = (typeof VALID_FB_STATUS)[number];
const FB_ID_REGEX = /^FB-\d{3}$/;
const IMP_REF_REGEX = /\bIMP-\d{3}\b/g;
/**
 * backtick で囲まれた file path 様トークン (拡張子付き、`/` を含む)。
 * 制約 (QA review nit): 突合対象は **backtick で囲んだ repo 相対 POSIX path** のみ。
 * 素の path / Windows 区切り `\` / `#anchor` 付き / スペース入りは意図的に対象外
 * (prose 中の偶然のファイル名を拾わない false-positive 回避)。feedback-log の `domesticated to`
 * は backtick + repo 相対 `/` 区切りで書く運用 (docs/feedback-log.md §運用)。
 */
const PATH_REF_REGEX = /`([\w./-]+\.(?:md|ts|tsx|json|yaml|yml))`/g;

export interface FeedbackEntry {
  id: string;
  date: string;
  source: string;
  feedback: string;
  lesson: string;
  domesticated: string;
  status: string;
  cellCount: number;
}

export interface FeedbackLogInput {
  md: string;
  /** improvement-backlog の md (IMP-NNN 実在突合用)。 */
  backlogMd: string;
  /** repo-relative path 実在判定 (default = fs existsSync(resolve(repoRoot, p)))。 */
  existsPath: (relPath: string) => boolean;
}

export interface FeedbackLogResult {
  entries: FeedbackEntry[];
  total: number;
  malformedIds: string[];
  duplicateIds: string[];
  invalidStatus: { id: string; status: string }[];
  incompleteRows: string[];
  /** status=open または domesticated 空 (status≠superseded) の未ドメスティック化 FB。 */
  undomesticated: string[];
  /** domesticated to の IMP-NNN が improvement-backlog に不在。 */
  danglingImpRefs: { id: string; ref: string }[];
  /** domesticated to の backtick path が repo に不在。 */
  missingPathRefs: { id: string; ref: string }[];
  /** FB エントリ行に見えるのに parse できなかった行 (absence-blindness)。 */
  unparseableRows: string[];
  ok: boolean;
}

export function loadFeedbackLog(repoRoot: string = ROOT): string {
  return readFileSync(resolve(repoRoot, "docs/feedback-log.md"), "utf-8");
}

/** `## エントリ` table の FB 行を構造化抽出。 */
export function parseFeedbackEntries(md: string): FeedbackEntry[] {
  const sec = md.match(/## エントリ[\s\S]*?(?=\n## |\n*$)/)?.[0] ?? "";
  const entries: FeedbackEntry[] = [];
  for (const line of sec.split("\n")) {
    const idMatch = line.match(/^\|\s*\*\*(FB-[\w-]+)\*\*\s*\|/);
    if (!idMatch) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    entries.push({
      id: idMatch[1],
      date: cells[1] ?? "",
      source: cells[2] ?? "",
      feedback: cells[3] ?? "",
      lesson: cells[4] ?? "",
      domesticated: cells[5] ?? "",
      status: (cells[6] ?? "").replace(/`/g, ""),
      cellCount: cells.length,
    });
  }
  return entries;
}

function isEmptyCell(value: string): boolean {
  const v = value.trim();
  return v === "" || v === "-" || v === "—" || v.toLowerCase() === "none";
}

export function analyzeFeedbackLog(input: FeedbackLogInput): FeedbackLogResult {
  const entries = parseFeedbackEntries(input.md);

  // absence-blindness guard: FB エントリ行に見えるのに parse されない行を surface。
  const sec = input.md.match(/## エントリ[\s\S]*?(?=\n## |\n*$)/)?.[0] ?? "";
  const unparseableRows: string[] = [];
  for (const line of sec.split("\n")) {
    if (!/^\|\s*\*\*FB/.test(line)) continue;
    if (/^\|\s*\*\*(FB-[\w-]+)\*\*\s*\|/.test(line)) continue;
    unparseableRows.push(line.match(/\*\*([^*]+)\*\*/)?.[1]?.trim() ?? line.trim().slice(0, 48));
  }

  const knownImps = new Set(parseBacklogEntries(input.backlogMd).map((e) => e.id));

  const malformedIds: string[] = [];
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const invalidStatus: { id: string; status: string }[] = [];
  const incompleteRows: string[] = [];
  const undomesticated: string[] = [];
  const danglingImpRefs: { id: string; ref: string }[] = [];
  const missingPathRefs: { id: string; ref: string }[] = [];

  for (const e of entries) {
    if (!FB_ID_REGEX.test(e.id)) malformedIds.push(e.id);
    if (seen.has(e.id)) duplicateIds.push(e.id);
    seen.add(e.id);

    if (!(VALID_FB_STATUS as readonly string[]).includes(e.status)) {
      invalidStatus.push({ id: e.id, status: e.status });
    }
    if (e.cellCount < 7 || !e.date || !e.source || !e.feedback || !e.lesson) {
      incompleteRows.push(e.id);
    }

    // 未ドメスティック化: open は常に違反。superseded 以外で domesticated 空も違反。
    if (e.status === "open" || (e.status !== "superseded" && isEmptyCell(e.domesticated))) {
      undomesticated.push(e.id);
    }

    // 参照先実在 (in-repo verifiable のみ)。superseded は対象外。
    if (e.status !== "superseded") {
      for (const m of e.domesticated.matchAll(IMP_REF_REGEX)) {
        if (!knownImps.has(m[0])) danglingImpRefs.push({ id: e.id, ref: m[0] });
      }
      for (const m of e.domesticated.matchAll(PATH_REF_REGEX)) {
        if (!input.existsPath(m[1])) missingPathRefs.push({ id: e.id, ref: m[1] });
      }
    }
  }

  const ok =
    malformedIds.length === 0 &&
    duplicateIds.length === 0 &&
    invalidStatus.length === 0 &&
    incompleteRows.length === 0 &&
    undomesticated.length === 0 &&
    danglingImpRefs.length === 0 &&
    missingPathRefs.length === 0 &&
    unparseableRows.length === 0;

  return {
    entries,
    total: entries.length,
    malformedIds,
    duplicateIds,
    invalidStatus,
    incompleteRows,
    undomesticated,
    danglingImpRefs,
    missingPathRefs,
    unparseableRows,
    ok,
  };
}

export function loadFeedbackLogInput(repoRoot: string = ROOT): FeedbackLogInput {
  return {
    md: loadFeedbackLog(repoRoot),
    backlogMd: readFileSync(resolve(repoRoot, "docs/improvement-backlog.md"), "utf-8"),
    existsPath: (relPath) => existsSync(resolve(repoRoot, relPath)),
  };
}

export function feedbackLogMessages(r: FeedbackLogResult): string[] {
  if (r.ok) {
    return [`feedback-log — OK (${r.total} FB entries domesticated、open/dangling 0)`];
  }
  const parts: string[] = [];
  if (r.undomesticated.length > 0) parts.push(`未ドメスティック化 ${r.undomesticated.join(",")}`);
  if (r.danglingImpRefs.length > 0)
    parts.push(`IMP 参照不在 ${r.danglingImpRefs.map((d) => `${d.id}:${d.ref}`).join(",")}`);
  if (r.missingPathRefs.length > 0)
    parts.push(`path 参照不在 ${r.missingPathRefs.map((d) => `${d.id}:${d.ref}`).join(",")}`);
  if (r.invalidStatus.length > 0)
    parts.push(`status 不正 ${r.invalidStatus.map((d) => `${d.id}:${d.status}`).join(",")}`);
  if (r.malformedIds.length > 0) parts.push(`ID 不正 ${r.malformedIds.join(",")}`);
  if (r.duplicateIds.length > 0) parts.push(`ID 重複 ${r.duplicateIds.join(",")}`);
  if (r.incompleteRows.length > 0) parts.push(`列欠落 ${r.incompleteRows.join(",")}`);
  if (r.unparseableRows.length > 0) parts.push(`parse 不能行 ${r.unparseableRows.join(",")}`);
  return [`feedback-log — ⚠ ${parts.join(" / ")}`];
}
