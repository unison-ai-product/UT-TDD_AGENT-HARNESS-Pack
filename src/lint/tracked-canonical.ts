/**
 * git tracked top-level ⊆ repository-structure.md canonical の突合 (IMP-127、PLAN-REVERSE-41 塊B)。
 *
 * asset-drift (FR-L1-49) only checks legacy path / command residue. It does
 * not ensure that the tracked top-level set fits the canonical tree.
 * 本 lint は git tracked ファイルの top-level path component が repository-structure.md に記載される
 * ことを検査し、NEW 未記載 top-level (canonical ツリー外の tracked 物) を fail-close する。
 *
 * 粒度 = top-level (現 18 entry 全件記載済 = drift 0、baseline 空)。深い粒度は将来拡張。
 * baseline = known-exception。現状 0。**追加は新規 drift を許容する穴になるため慎重に**。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TRACKED_CANONICAL_BASELINE: ReadonlySet<string> = new Set<string>();

export interface TrackedCanonicalInput {
  /** git tracked ファイルの top-level path component (一意)。 */
  trackedTopLevels: string[];
  /** repository-structure.md 全文 (canonical ツリー定義)。 */
  canonicalText: string;
  baseline: ReadonlySet<string>;
}

export interface TrackedCanonicalResult {
  drift: string[];
  ok: boolean;
}

/** canonical に記載されず baseline 外の top-level を drift として返す。 */
export function analyzeTrackedCanonical(input: TrackedCanonicalInput): TrackedCanonicalResult {
  const drift = [...new Set(input.trackedTopLevels)]
    .filter((t) => !input.canonicalText.includes(t) && !input.baseline.has(t))
    .sort();
  return { drift, ok: drift.length === 0 };
}

export function loadTrackedCanonicalInput(repoRoot: string): TrackedCanonicalInput {
  let trackedTopLevels: string[] = [];
  try {
    const out = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
    trackedTopLevels = [
      ...new Set(
        out
          .split("\n")
          .filter(Boolean)
          .map((p) => p.split("/")[0] ?? p),
      ),
    ];
  } catch {
    // git 不在 / 非 repo → 空集合 (fail-open、doctor 堅牢性)
  }
  let canonicalText = "";
  try {
    canonicalText = readFileSync(
      join(repoRoot, "docs", "governance", "repository-structure.md"),
      "utf8",
    );
  } catch {
    // repository-structure.md 不在 → 空文字 (全 top-level が drift になるが fail-open は loader 側でなく
    // analyze 側の判定に委ねる。実 repo では存在するため通常起きない)
  }
  return { trackedTopLevels, canonicalText, baseline: TRACKED_CANONICAL_BASELINE };
}

export function trackedCanonicalMessages(r: TrackedCanonicalResult): string[] {
  if (r.drift.length === 0) {
    return [
      "tracked-canonical — OK (tracked top-level 全件 repository-structure.md 記載、drift 0)",
    ];
  }
  return [
    `tracked-canonical — ⚠ canonical 未記載の tracked top-level ${r.drift.length} 件: ${r.drift.join(", ")} (repository-structure.md に追記 or baseline)`,
  ];
}
