import { execFileSync } from "node:child_process";

/** HEAD が実際に持つ PLAN doc 数。live repo の PLAN 追加で HEAD-bound oracle が
 * 壊れないよう、固定 count ではなく inventory と同じ HEAD 基準 (git ls-tree) から導出する。 */
export function headPlanDocCount(cwd: string): number {
  return execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "docs/plans"], {
    cwd,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path.endsWith(".md")).length;
}
