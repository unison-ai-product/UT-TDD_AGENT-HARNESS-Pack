/**
 * Improvement backlog lint (A-59 ledger、5 つ目の lint)。
 * 「作業中に発見した不備・改善を蓄積 → triage → 機能化」する living backlog の構造を機械検証。
 * PO 指摘「作業ログ memory 機能 (不備/改善をまとめて後で機能化する仕組み)」反映。
 * FR-L1-19 (Learning Engine) 本実装までの手動橋渡し。requirements §1.10.G.12。
 *
 * SSoT = docs/improvement-backlog.md §1 table。本 lint は entry の構造健全性を検証:
 *  - ID 形式 (IMP-NNN) + 一意性
 *  - status / 自動化候補 が enum 内
 *  - 必須 7 列の充足
 *  - IMP らしき行 (`| **IMP…`) が parse されず黙って skip される absence-blindness の検出
 *    (`→suffix` で ID regex を外すと行ごと未検証になる穴を塞ぐ、[[project_descent_absence_blindness]])
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

export const VALID_STATUS = ["observed", "triaged", "implemented", "verified"] as const;
export const VALID_CANDIDATE = ["lint", "FR", "policy", "doc", "none"] as const;
const ID_REGEX = /^IMP-\d{3}$/;

export type BacklogStatus = (typeof VALID_STATUS)[number];

export interface BacklogEntry {
  id: string;
  date: string;
  context: string;
  issue: string;
  candidate: string;
  status: string;
  link: string;
  cellCount: number;
}

// A-120 I-5: repoRoot 注入可 (default = ROOT で挙動保存)。
export function loadBacklog(repoRoot: string = ROOT): string {
  return readFileSync(resolve(repoRoot, "docs/improvement-backlog.md"), "utf-8");
}

/** §1 backlog table の行を構造化抽出 */
export function parseBacklogEntries(md: string): BacklogEntry[] {
  const sec = md.match(/## §1 backlog[\s\S]*$/)?.[0] ?? md;
  const entries: BacklogEntry[] = [];
  for (const line of sec.split("\n")) {
    const idMatch = line.match(/^\|\s*\*\*(IMP-[\w-]+)\*\*\s*\|/);
    if (!idMatch) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    entries.push({
      id: idMatch[1],
      date: cells[1] ?? "",
      context: cells[2] ?? "",
      issue: cells[3] ?? "",
      candidate: (cells[4] ?? "").replace(/`/g, ""),
      status: (cells[5] ?? "").replace(/`/g, ""),
      link: cells[6] ?? "",
      cellCount: cells.length,
    });
  }
  return entries;
}

export interface ImprovementBacklogResult {
  entries: BacklogEntry[];
  total: number;
  byStatus: Record<BacklogStatus, number>;
  /** 機能化待ち (verified 以外) */
  openCount: number;
  malformedIds: string[];
  duplicateIds: string[];
  invalidStatus: { id: string; status: string }[];
  invalidCandidate: { id: string; candidate: string }[];
  incompleteRows: string[];
  /**
   * §1 で IMP エントリ行に見える (`| **IMP…**`) のに parseBacklogEntries が
   * 抽出できなかった行のラベル。`**IMP-064→enforced**` のように ID に `→suffix`
   * を付けると ID regex を外れて行ごと黙って skip され、status / 構造が一切検証
   * されない absence-blindness になる ([[project_descent_absence_blindness]])。
   * 不在を違反として surface する (進捗注記は原 entry の status 更新で表現する)。
   */
  unparseableRows: string[];
  missingBackpropClassification: { id: string; missing: string[] }[];
}

const BACKPROP_CLASSIFICATION_FIELDS = [
  "backprop_decision",
  "reverse_type",
  "target_layer",
  "upstream_docs",
  "evidence_path",
  "closure_status",
] as const;

function needsBackpropClassification(entry: BacklogEntry): boolean {
  const text = `${entry.context}\n${entry.issue}\n${entry.link}`;
  return /下位\s*L|lower-layer|back-?prop|backprop_decision|Reverse back-prop/i.test(text);
}

function missingBackpropFields(entry: BacklogEntry): string[] {
  const text = `${entry.issue}\n${entry.link}`;
  return BACKPROP_CLASSIFICATION_FIELDS.filter((field) => {
    const pattern = new RegExp(`(?:\\*\\*)?${field}(?:\\*\\*)?\\s*=`);
    return !pattern.test(text);
  });
}

export function analyzeImprovementBacklog(md?: string): ImprovementBacklogResult {
  const src = md ?? loadBacklog();
  const entries = parseBacklogEntries(src);

  // absence-blindness guard: a line that looks like an IMP entry row but is not
  // parsed by parseBacklogEntries (same id regex) is silently dropped today.
  const sec = src.match(/## §1 backlog[\s\S]*$/)?.[0] ?? src;
  const unparseableRows: string[] = [];
  for (const line of sec.split("\n")) {
    if (!/^\|\s*\*\*IMP/.test(line)) continue; // candidate IMP entry row
    if (/^\|\s*\*\*(IMP-[\w-]+)\*\*\s*\|/.test(line)) continue; // parseBacklogEntries extracts it
    unparseableRows.push(line.match(/\*\*([^*]+)\*\*/)?.[1]?.trim() ?? line.trim().slice(0, 48));
  }

  const byStatus: Record<BacklogStatus, number> = {
    observed: 0,
    triaged: 0,
    implemented: 0,
    verified: 0,
  };
  const malformedIds: string[] = [];
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const invalidStatus: { id: string; status: string }[] = [];
  const invalidCandidate: { id: string; candidate: string }[] = [];
  const incompleteRows: string[] = [];
  const missingBackpropClassification: { id: string; missing: string[] }[] = [];

  for (const e of entries) {
    if (!ID_REGEX.test(e.id)) malformedIds.push(e.id);
    if (seen.has(e.id)) duplicateIds.push(e.id);
    seen.add(e.id);

    if ((VALID_STATUS as readonly string[]).includes(e.status)) {
      byStatus[e.status as BacklogStatus] += 1;
    } else {
      invalidStatus.push({ id: e.id, status: e.status });
    }

    // candidate は "/" 区切り複数可、各値が enum 内
    const cands = e.candidate.split("/").map((c) => c.trim());
    for (const c of cands) {
      if (!(VALID_CANDIDATE as readonly string[]).includes(c)) {
        invalidCandidate.push({ id: e.id, candidate: e.candidate });
        break;
      }
    }

    if (e.cellCount < 7 || !e.date || !e.context || !e.issue || !e.link) {
      incompleteRows.push(e.id);
    }

    if (needsBackpropClassification(e)) {
      const missing = missingBackpropFields(e);
      if (missing.length > 0) missingBackpropClassification.push({ id: e.id, missing });
    }
  }

  const openCount = entries.length - byStatus.verified;

  return {
    entries,
    total: entries.length,
    byStatus,
    openCount,
    malformedIds,
    duplicateIds,
    invalidStatus,
    invalidCandidate,
    incompleteRows,
    unparseableRows,
    missingBackpropClassification,
  };
}
