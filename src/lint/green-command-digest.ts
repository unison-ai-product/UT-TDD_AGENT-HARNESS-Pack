/**
 * green-command-digest (PLAN-L7-132) — green_command evidence の digest 実体検査。
 *
 * 既存 green-command gate (review-evidence.ts) は `output_digest` の **形式** (`sha256:[a-f0-9]{16,64}`)
 * しか見ず、それが `evidence_path` の **実ファイル hash** かを照合しない。よって形式さえ整えば
 * `sha256:110feedbac000001` のような **fake/プレースホルダ digest** が gate を通り、「substance を
 * 強制する gate」が fake substance で満たせる穴がある (coverage ≠ substance のメタ再発)。
 *
 * 本検査は各 green_command の `output_digest` が `evidence_path` の実 sha256 と一致するかを照合し、
 * 不一致 (fake / stale) を surface する。
 *
 * **非破壊 (advisory)**: 既存の committed PLAN が fake digest を持つため、これを hard-fail にすると
 * doctor を一斉に赤化させ他ランタイムの committed 状態をデグレさせる。よって本検査は note (warn) で
 * 可視化に留め、訂正は coordinated に行う (hard 化は全 fake 是正後)。判定は I/O 注入で純粋に保つ。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReviewPlans, type ParsedReviewPlan } from "./review-evidence";

export interface DigestMismatch {
  plan_id: string;
  evidence_path: string;
  claimed: string;
  actual: string;
  reason: "file-missing" | "digest-mismatch";
}

export interface DigestAuditDeps {
  /** evidence_path (repo-relative) の中身を返す。存在しなければ null。 */
  readBytes: (repoRelativePath: string) => Buffer | null;
  /** Buffer の digest を `sha256:<hex>` で返す。 */
  hash: (bytes: Buffer) => string;
}

/**
 * 全 PLAN の green_command evidence を走査し、`output_digest` が `evidence_path` の実 hash と
 * 一致しないもの (fake / stale / file 不在) を返す純関数 (I/O は deps 注入)。
 */
export function auditGreenCommandDigests(
  plans: ParsedReviewPlan[],
  deps: DigestAuditDeps,
): DigestMismatch[] {
  const mismatches: DigestMismatch[] = [];
  for (const plan of plans) {
    for (const entry of plan.crossEntries ?? []) {
      for (const cmd of entry.green_commands ?? []) {
        const path = cmd.evidence_path?.trim();
        const claimed = cmd.output_digest?.trim();
        if (!path || !claimed) continue;
        const bytes = deps.readBytes(path);
        if (bytes === null) {
          mismatches.push({
            plan_id: plan.plan_id,
            evidence_path: path,
            claimed,
            actual: "",
            reason: "file-missing",
          });
          continue;
        }
        const actual = deps.hash(bytes);
        // 大文字小文字を無視して比較 (claimed が SHA256:ABC.. 表記でも実 hash と一致なら pass)。
        if (actual.toLowerCase() !== claimed.toLowerCase()) {
          mismatches.push({
            plan_id: plan.plan_id,
            evidence_path: path,
            claimed,
            actual,
            reason: "digest-mismatch",
          });
        }
      }
    }
  }
  return mismatches.sort(
    (a, b) => a.plan_id.localeCompare(b.plan_id) || a.evidence_path.localeCompare(b.evidence_path),
  );
}

/** Node I/O 実装 (repoRoot 基準で evidence_path を読み、sha256 を計算)。 */
export function nodeDigestAuditDeps(repoRoot: string): DigestAuditDeps {
  return {
    readBytes: (rel) => {
      const file = join(repoRoot, rel);
      return existsSync(file) ? readFileSync(file) : null;
    },
    hash: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/**
 * doctor 向け advisory メッセージ (非ブロック)。不一致が無ければ OK 行、有れば note 行で可視化する。
 */
const DIGEST_NOTE_CAP = 8;

export function greenCommandDigestMessages(mismatches: DigestMismatch[]): string[] {
  if (mismatches.length === 0) {
    return ["green-command-digest — OK (全 green_command digest が evidence_path 実 hash と一致)"];
  }
  const shown = mismatches.slice(0, DIGEST_NOTE_CAP);
  const detail = shown.map((m) => `${m.plan_id}:${m.evidence_path} (${m.reason})`).join(", ");
  const more =
    mismatches.length > shown.length ? ` (+${mismatches.length - shown.length} more)` : "";
  const planCount = new Set(mismatches.map((m) => m.plan_id)).size;
  return [
    `green-command-digest — note: ${mismatches.length} 件の output_digest が evidence_path の実 hash と不一致 ` +
      `(${planCount} PLAN、fake/stale substance、要訂正・hard 化前に是正): ${detail}${more}`,
  ];
}

/** repoRoot を読み、digest 不一致の advisory メッセージを返す (doctor 配線の薄いラッパ)。 */
export function checkGreenCommandDigests(repoRoot: string = process.cwd()): {
  messages: string[];
  mismatches: DigestMismatch[];
} {
  try {
    const mismatches = auditGreenCommandDigests(
      loadReviewPlans(repoRoot),
      nodeDigestAuditDeps(repoRoot),
    );
    return { messages: greenCommandDigestMessages(mismatches), mismatches };
  } catch {
    // advisory ゆえ非ブロック: PLAN 読取失敗でも doctor を止めない。
    return {
      messages: ["green-command-digest — note: 検査スキップ (PLAN 読取失敗、advisory)"],
      mismatches: [],
    };
  }
}
