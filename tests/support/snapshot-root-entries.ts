// 契約形の stub (issue #1665 の Red)。判定は Green の PR で入れる。
// 契約: docs/design/harness/L6-function-design/snapshot-runner-lock.md §10。
export function ownSnapshotRootEntries(_names: readonly string[], _pid: number): string[] {
  return [];
}
