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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReviewPlans, type ParsedReviewPlan } from "./review-evidence";

export interface DigestMismatch {
  plan_id: string;
  evidence_path: string;
  claimed: string;
  actual: string;
  /**
   * - file-missing: working tree に evidence_path が無い (anchor 無し entry)。
   * - digest-mismatch: working tree の実 hash が claimed と不一致 (anchor 無し entry)。
   * - anchor-path-missing: anchor_commit は存在するがその commit に evidence_path が無い。
   * - anchor-digest-mismatch: anchor_commit の blob hash が claimed と不一致 = 捏造/改ざん。
   */
  reason: "file-missing" | "digest-mismatch" | "anchor-path-missing" | "anchor-digest-mismatch";
}

/** anchor_commit の blob を引く結果。unverifiable は「fail にしない」区分 (GC/shallow で検証不能)。 */
export type BlobAtCommit =
  | { kind: "bytes"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "unverifiable" };

export interface DigestAuditDeps {
  /** evidence_path (repo-relative) の中身を返す。存在しなければ null。 */
  readBytes: (repoRelativePath: string) => Buffer | null;
  /** Buffer の digest を `sha256:<hex>` で返す。 */
  hash: (bytes: Buffer) => string;
  /**
   * anchor_commit の時点での evidence_path blob を返す (PLAN-L7-303、二層照合の永続検証層)。
   * 未提供なら anchor_commit 付き entry も working tree と照合する (完全後方互換)。
   */
  readBlobAtCommit?: (sha: string, repoRelativePath: string) => BlobAtCommit;
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
        const anchor = cmd.anchor_commit?.trim();

        // 永続検証層 (PLAN-L7-303): anchor_commit があればその時点の blob と照合する。
        // working tree の健全な進化で不一致にならない = 証跡が永続的に検証可能。
        if (anchor && deps.readBlobAtCommit) {
          const blob = deps.readBlobAtCommit(anchor, path);
          if (blob.kind === "unverifiable") continue; // GC/shallow で検証不能 → fail にしない
          if (blob.kind === "missing") {
            mismatches.push({
              plan_id: plan.plan_id,
              evidence_path: path,
              claimed,
              actual: "",
              reason: "anchor-path-missing",
            });
            continue;
          }
          const actualAtAnchor = deps.hash(blob.bytes);
          if (actualAtAnchor.toLowerCase() !== claimed.toLowerCase()) {
            mismatches.push({
              plan_id: plan.plan_id,
              evidence_path: path,
              claimed,
              actual: actualAtAnchor,
              reason: "anchor-digest-mismatch",
            });
          }
          continue;
        }

        // 後方互換層: anchor 無し (or dep 未提供) は従来どおり working tree と照合。
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

/** Buffer → `sha256:<hex>`。 */
function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * git は pathspec を forward slash で扱う。evidence_path は Windows で書かれると backslash を含み
 * (`tests\\foo.test.ts`)、`git show <sha>:<path>` / `git log -- <path>` が解決に失敗する。git 呼び出し前に
 * 正規化して、Windows 由来の backslash path を「捏造 (suspect)」と誤分類しないようにする (Windows 第一級)。
 */
export function toGitPath(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/** repoRoot でその commit の commit object が存在するか (GC/shallow 判定)。 */
function commitExists(repoRoot: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Node I/O 実装 (repoRoot 基準で evidence_path を読み、sha256 を計算、anchor blob を git show で引く)。 */
export function nodeDigestAuditDeps(repoRoot: string): DigestAuditDeps {
  return {
    readBytes: (rel) => {
      const file = join(repoRoot, rel);
      return existsSync(file) ? readFileSync(file) : null;
    },
    hash: sha256,
    readBlobAtCommit: (sha, rel): BlobAtCommit => {
      try {
        // encoding 未指定 = Buffer で返る (raw blob を hash するため text 変換しない)。
        const bytes = execFileSync("git", ["-C", repoRoot, "show", `${sha}:${toGitPath(rel)}`], {
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 64 * 1024 * 1024,
        });
        return { kind: "bytes", bytes };
      } catch {
        // commit object 自体が無い (GC/shallow) → 検証不能。commit はあるが path が無い → missing。
        return commitExists(repoRoot, sha) ? { kind: "missing" } : { kind: "unverifiable" };
      }
    },
  };
}

/** digest-migrate の 1 件分の判定 (dry-run 出力単位)。 */
export interface DigestMigrationCandidate {
  plan_id: string;
  evidence_path: string;
  claimed: string;
  /** claimed digest と一致する blob を持つ最新 commit (見つかれば anchor 候補)。 */
  anchor_candidate: string | null;
  /**
   * - recoverable: 過去 commit に claimed 一致 blob あり → anchor_candidate を back-fill 可能。
   * - suspect: どの commit にも一致 blob が無い → 捏造/回復不能疑い、手動台帳化 (A-18x)。
   * - already-anchored: 既に anchor_commit を持つ (移行不要)。
   */
  disposition: "recoverable" | "suspect" | "already-anchored";
}

export interface HistoryScanDeps {
  /** evidence_path に触れた commit を新しい順で返す。 */
  commitsTouchingPath: (repoRelativePath: string) => string[];
  /** その commit 時点の blob を引く。 */
  readBlobAtCommit: (sha: string, repoRelativePath: string) => BlobAtCommit;
  hash: (bytes: Buffer) => string;
}

/**
 * 各 green_command について、claimed digest に一致する blob を持つ最新 commit を履歴走査で特定する
 * 純関数 (PLAN-L7-303 item 3 の dry-run 計画器)。**書き込みは行わない** — 移行実行 (--execute) は
 * committed PLAN の frontmatter 改変になり監査境界に触れるため PO ゲート。
 */
export function planDigestMigration(
  plans: ParsedReviewPlan[],
  deps: HistoryScanDeps,
): DigestMigrationCandidate[] {
  const out: DigestMigrationCandidate[] = [];
  for (const plan of plans) {
    for (const entry of plan.crossEntries ?? []) {
      for (const cmd of entry.green_commands ?? []) {
        const path = cmd.evidence_path?.trim();
        const claimed = cmd.output_digest?.trim();
        if (!path || !claimed) continue;
        if (cmd.anchor_commit?.trim()) {
          out.push({
            plan_id: plan.plan_id,
            evidence_path: path,
            claimed,
            anchor_candidate: cmd.anchor_commit.trim(),
            disposition: "already-anchored",
          });
          continue;
        }
        let anchor: string | null = null;
        for (const sha of deps.commitsTouchingPath(path)) {
          const blob = deps.readBlobAtCommit(sha, path);
          if (blob.kind !== "bytes") continue;
          if (deps.hash(blob.bytes).toLowerCase() === claimed.toLowerCase()) {
            anchor = sha;
            break; // 新しい順走査ゆえ最初の一致が最新
          }
        }
        out.push({
          plan_id: plan.plan_id,
          evidence_path: path,
          claimed,
          anchor_candidate: anchor,
          disposition: anchor ? "recoverable" : "suspect",
        });
      }
    }
  }
  return out;
}

/** Node I/O 実装の履歴走査 deps。 */
export function nodeHistoryScanDeps(repoRoot: string): HistoryScanDeps {
  const node = nodeDigestAuditDeps(repoRoot);
  const readBlobAtCommit = node.readBlobAtCommit;
  if (!readBlobAtCommit) {
    throw new Error("nodeDigestAuditDeps must provide readBlobAtCommit");
  }
  const commitsByPath = new Map<string, string[]>();
  const blobByCommitPath = new Map<string, BlobAtCommit>();
  return {
    commitsTouchingPath: (rel) => {
      const gitPath = toGitPath(rel);
      const cached = commitsByPath.get(gitPath);
      if (cached) return cached;
      try {
        const out = execFileSync("git", ["-C", repoRoot, "log", "--format=%H", "--", gitPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 16 * 1024 * 1024,
        });
        const commits = out.split(/\r?\n/).filter(Boolean);
        commitsByPath.set(gitPath, commits);
        return commits;
      } catch {
        commitsByPath.set(gitPath, []);
        return [];
      }
    },
    readBlobAtCommit: (sha, rel) => {
      const gitPath = toGitPath(rel);
      const key = `${sha}:${gitPath}`;
      const cached = blobByCommitPath.get(key);
      if (cached) return cached;
      const blob = readBlobAtCommit(sha, gitPath);
      blobByCommitPath.set(key, blob);
      return blob;
    },
    hash: node.hash,
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
