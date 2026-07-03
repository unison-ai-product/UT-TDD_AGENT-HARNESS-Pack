/**
 * doc-router (PLAN-L7-302, doc-router 部分) — 起動コンテキスト tier 化の索引エンジン。
 *
 * CLAUDE.md「Claude Code Read Order」が canonical 指定する concept/requirements は合計 11.3 万
 * トークン (A-181 CE-1) で、plan lint / status のような軽いループでは「読むだけ」で window の
 * 半分超を消費する。本 module は canonical doc の**見出しセクション索引**を実 doc から生成し、
 * タスク分類 (`classifyTask` と同じ signal 語彙 = kind) から**読むべきセクションの一覧**を返す。
 * skill suggest と同型の「関連物だけ注入」機構 (概念 4 の doc への適用)。
 *
 * 重要な設計制約:
 * - 索引は**実行時 parse** (commit 時静的生成でない)。doc 更新で見出し行範囲がずれるため、
 *   索引は常に現在の doc から作る (キャッシュは呼び出し側の裁量)。
 * - kind→topic の対応は**ヒューリスティック**。マッチ 0 件のときは fail-open =「全文読み推奨」を
 *   返す (読み過ぎは安全側、読み漏れは危険側)。substance を偽装しないため、抽出粒度は
 *   「見出しセクション丸ごと」で、文単位の要約はしない。
 * - 本 module は CLAUDE.md / .claude/CLAUDE.md / AGENTS.md の Read Order を**変更しない**
 *   (canonical read order の改訂は PLAN-L7-302 の別スライスで、PO ゲート + rule-drift 3 面同期が必要)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 見出し 1 つ = 1 セクション。endLine はセクション本文の最終行 (次の同/上位見出しの直前)。 */
export interface DocSection {
  /** 見出しレベル (# の数)。 */
  level: number;
  /** 見出しテキスト (# と前後空白を除去)。 */
  heading: string;
  /** 見出し先頭の節番号 (`§2`, `2.1`, `2.1.2.1` 等)。無ければ null。 */
  section_number: string | null;
  /** 見出し行 (1-indexed)。 */
  start_line: number;
  /** セクション本文の最終行 (1-indexed、次の同/上位見出しの直前 or 文末)。 */
  end_line: number;
}

export interface DocIndex {
  /** repo-relative なドキュメントパス。 */
  path: string;
  /** 総行数。 */
  total_lines: number;
  sections: DocSection[];
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
// 見出し先頭の節番号: `§2`, `§2.1`, `2.1`, `2.1.2.1`, `1.1.parent_design` 等の数字ドット列を拾う。
const SECTION_NUMBER_RE = /^§?\s*(\d+(?:\.\d+)*)/;

/** markdown テキストから見出しセクション索引を生成する純関数 (I/O なし)。 */
export function buildDocIndex(path: string, content: string): DocIndex {
  const lines = content.split("\n");
  const raw: Omit<DocSection, "end_line">[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (!m) continue;
    const heading = m[2].trim();
    const numMatch = heading.match(SECTION_NUMBER_RE);
    raw.push({
      level: m[1].length,
      heading,
      section_number: numMatch ? numMatch[1] : null,
      start_line: i + 1,
    });
  }
  const sections: DocSection[] = raw.map((sec, idx) => {
    // end_line = 次の「同レベル以上 (level <= 自分)」の見出し直前。無ければ文末。
    let end = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j].level <= sec.level) {
        end = raw[j].start_line - 1;
        break;
      }
    }
    return { ...sec, end_line: end };
  });
  return { path, total_lines: lines.length, sections };
}

/** repo-relative パスを読んで索引化。存在しなければ null。 */
export function loadDocIndex(repoRoot: string, path: string): DocIndex | null {
  const file = join(repoRoot, path);
  if (!existsSync(file)) return null;
  return buildDocIndex(path, readFileSync(file, "utf8"));
}

/**
 * canonical doc のうち tier 化 (動的読み) の対象。CLAUDE.md Read Order の重量 90.7% を占める 2 本
 * (A-181 CE-1)。extraction-plan / ADR は Tier 2 (明示参照のみ) なので索引ルーティング対象外。
 */
export const ROUTABLE_DOCS = [
  "docs/governance/ut-tdd-agent-harness-concept_v3.1.md",
  "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
] as const;

/**
 * タスク kind → topic キーワード。見出しテキストがいずれかのキーワードを含むセクションを推挙する。
 * ヒューリスティック (節番号のハードコードでなく見出し語で照合 → doc 改訂に強い)。
 * マッチ 0 件なら fail-open で全文読みを返す。
 */
const KIND_TOPIC_KEYWORDS: Record<string, string[]> = {
  design: ["設計", "V-model", "freeze", "trace", "経路", "骨格", "granularity", "粒度"],
  "add-feature": ["経路", "補助軸", "bottom-up", "kind", "drive", "reverse", "追加"],
  refactor: ["原則", "失敗を仕組み", "リファクタ", "不変"],
  troubleshoot: ["Recovery", "失敗", "troubleshoot", "復旧", "回復"],
  poc: ["Scrum", "PoC", "poc", "backlog", "verify", "decide"],
  reverse: ["Reverse", "逆", "R0", "R4", "back"],
};

export interface SectionSuggestion {
  path: string;
  heading: string;
  section_number: string | null;
  start_line: number;
  end_line: number;
  /** そのセクションを推挙した理由 (照合したキーワード)。 */
  matched: string;
}

export interface ContextSuggestResult {
  kind: string;
  /** fail-open か (kind 不明 or topic マッチ 0 件)。true のとき sections は空で全文読みを推奨。 */
  fail_open: boolean;
  /** fail_open のとき、全文読みが必要な理由の説明。 */
  fail_open_reason: string | null;
  sections: SectionSuggestion[];
}

/**
 * タスク kind と索引群から、読むべきセクションを推挙する純関数。
 * @param kind classifyTask の kind (design/add-feature/refactor/troubleshoot/poc/reverse/unknown)
 * @param indexes ルーティング対象 doc の索引 (null は読込失敗として無視)
 */
export function suggestSections(kind: string, indexes: (DocIndex | null)[]): ContextSuggestResult {
  const keywords = KIND_TOPIC_KEYWORDS[kind];
  if (!keywords) {
    return {
      kind,
      fail_open: true,
      fail_open_reason: `kind=${kind} は既知の topic に対応しない。canonical doc を全文読みすること (読み漏れ回避、安全側)。`,
      sections: [],
    };
  }
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  const sections: SectionSuggestion[] = [];
  for (const idx of indexes) {
    if (!idx) continue;
    for (const sec of idx.sections) {
      const hLower = sec.heading.toLowerCase();
      const hit = lowerKeywords.find((k) => hLower.includes(k));
      if (hit) {
        sections.push({
          path: idx.path,
          heading: sec.heading,
          section_number: sec.section_number,
          start_line: sec.start_line,
          end_line: sec.end_line,
          matched: hit,
        });
      }
    }
  }
  if (sections.length === 0) {
    return {
      kind,
      fail_open: true,
      fail_open_reason: `kind=${kind} に対応する見出しが索引に見つからない (doc 改訂で topic 語が消えた可能性)。全文読みを推奨。`,
      sections: [],
    };
  }
  return { kind, fail_open: false, fail_open_reason: null, sections };
}

/** repoRoot からルーティング対象 doc を読み、kind に対する推挙を返す (CLI 配線用の薄いラッパ)。 */
export function contextSuggest(repoRoot: string, kind: string): ContextSuggestResult {
  const indexes = ROUTABLE_DOCS.map((p) => loadDocIndex(repoRoot, p));
  return suggestSections(kind, indexes);
}
