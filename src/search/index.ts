import type { HarnessDb } from "../state-db/index";
import { isSecretLike, upsertRow } from "../state-db/index";

export interface SearchReferenceRow {
  subject_type: string;
  subject_id: string;
  path: string;
  title: string;
  tokens: string;
  summary: string;
  updated_at: string;
}

export interface SearchReferenceResult extends SearchReferenceRow {
  reason: "exact-id" | "token-match";
  evidence_path: string;
  score: number;
}

function searchId(row: Pick<SearchReferenceRow, "subject_type" | "subject_id">): string {
  return `${row.subject_type}:${row.subject_id}`;
}

export function upsertSearchReference(db: HarnessDb, row: SearchReferenceRow): void {
  const text = `${row.title} ${row.tokens} ${row.summary}`;
  // Use the canonical SECRET_PATTERN (state-db SSoT, min 16 chars) so legitimate
  // identifiers like the skill name "planning-and-task-breakdown" ("…task-break…")
  // are not false-positively rejected as secrets.
  if (isSecretLike(text)) {
    throw new Error("search_index cannot store secret-like tokens");
  }
  upsertRow(db, {
    table: "search_index",
    primaryKey: "search_id",
    row: {
      search_id: searchId(row),
      ...row,
    },
  });
}

function scoreRow(row: Record<string, unknown>, terms: string[], query: string): number {
  const subjectId = String(row.subject_id ?? "");
  if (subjectId === query) return 1000;
  const haystack =
    `${row.subject_id ?? ""} ${row.title ?? ""} ${row.tokens ?? ""} ${row.summary ?? ""}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function findReference(db: HarnessDb, query: string): SearchReferenceResult[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const terms = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = db.prepare("SELECT * FROM search_index").all();
  return rows
    .map((row) => {
      const score = scoreRow(row, terms, normalized);
      const reason = String(row.subject_id ?? "") === normalized ? "exact-id" : "token-match";
      return {
        subject_type: String(row.subject_type ?? ""),
        subject_id: String(row.subject_id ?? ""),
        path: String(row.path ?? ""),
        title: String(row.title ?? ""),
        tokens: String(row.tokens ?? ""),
        summary: String(row.summary ?? ""),
        updated_at: String(row.updated_at ?? ""),
        evidence_path: String(row.path ?? ""),
        reason,
        score,
      } satisfies SearchReferenceResult;
    })
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.reason === "exact-id" ? -1 : 1) ||
        a.subject_id.localeCompare(b.subject_id),
    );
}
