/**
 * default branch の ref→SHA 解決 (PLAN-L7-461)。
 *
 * ref 依存の doctor check (`memory-sync` の `git ls-tree origin/main`、`merged-plan-status` の
 * canonical target 解決) は、default branch の ref が無い面では評価できない。snapshot 作成時の
 * ref 注入と、doctor envelope の観測面記録の双方がこの解決結果を使う (同じ規則で解決した値どうしを
 * 比較しないと「同じ面を観測した」と言えない)。
 *
 * 解決できない場合は **null / 空 map** を返す。存在しない ref を推測で埋めると、ref 依存 check の
 * fail-close が壊れる。
 */

import { execFileSync } from "node:child_process";

export interface DefaultBranchRef {
  /** default branch 名 (例 `main`)。 */
  branch: string;
  /** 解決できた ref の完全名。 */
  ref: string;
  /** ref が指す commit SHA。 */
  sha: string;
}

function gitOutput(repoRoot: string, args: readonly string[]): string | null {
  try {
    const value = execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function resolveDefaultBranchRef(repoRoot: string): DefaultBranchRef | null {
  const symbolic = gitOutput(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const branch = symbolic?.replace(/^origin\//, "") || "main";
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const sha = gitOutput(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (sha) return { branch, ref, sha };
  }
  return null;
}

/**
 * 観測面の ref→SHA。ref 依存 check が実際に読む ref だけを載せる。
 * snapshot へ注入した ref 名 (`refs/remotes/origin/<branch>`) に正規化することで、
 * 「source では refs/heads、snapshot では refs/remotes」という表記差で不一致にしない。
 */
export function defaultBranchRefMap(repoRoot: string): Record<string, string> {
  const resolved = resolveDefaultBranchRef(repoRoot);
  if (!resolved) return {};
  return { [`refs/remotes/origin/${resolved.branch}`]: resolved.sha };
}

export function headSha(repoRoot: string): string | null {
  return gitOutput(repoRoot, ["rev-parse", "HEAD"]);
}
