import type { PackPublicationObservation } from "./pack-publication-staging.ts";

// Stub (issue #1894 Red): 契約は docs/design/harness/L6-function-design/pack-publication-audit-wiring.md §3.4。
// Green が git ls-tree / git cat-file --batch による観測を実装するまで、観測できないものとして fail-close する。

export interface PackPublicationGitResult {
  readonly status: number;
  readonly stdout: Uint8Array;
}

/** `git -C <repoRoot>` に渡す argv と、あれば標準入力を受ける。テストが argv / stdin を記録するために注入できる。 */
export type PackPublicationGitRunner = (
  args: readonly string[],
  stdin?: Uint8Array,
) => PackPublicationGitResult;

export type PackPublicationObservationResult =
  | { readonly status: "observed"; readonly observation: PackPublicationObservation }
  | { readonly status: "indeterminate"; readonly reason: "observation_unavailable" };

export function observePackPublication(_input: {
  readonly repoRoot: string;
  readonly c1: string;
  readonly c2: string;
  readonly runGit?: PackPublicationGitRunner;
}): PackPublicationObservationResult {
  return { status: "indeterminate", reason: "observation_unavailable" };
}
