import { canonicalPath } from "../scripts/run-vitest-snapshot.ts";
import {
  assertGitWorkspaceUnchanged,
  captureGitWorkspaceFingerprint,
} from "./support/git-workspace-fingerprint.ts";

export default function setup(): () => void {
  const repoRoot = process.cwd();
  if (
    !process.env.UT_TDD_TEST_EXECUTION_ROOT ||
    canonicalPath(process.env.UT_TDD_TEST_EXECUTION_ROOT) !== canonicalPath(repoRoot)
  ) {
    throw new Error("Vitest must run through the detached HEAD snapshot runner");
  }
  const fenceRoot = process.env.UT_TDD_TEST_FENCE_ROOT;
  const headRoot = process.env.UT_TDD_HEAD_SNAPSHOT_ROOT;
  if (!fenceRoot) throw new Error("Vitest test workspace fence root is required");
  if (!headRoot) throw new Error("Vitest detached HEAD read root is required");
  const before = captureGitWorkspaceFingerprint(fenceRoot, { volatileRuntimeIndex: true });
  const headBefore = captureGitWorkspaceFingerprint(headRoot);
  return () => {
    assertGitWorkspaceUnchanged(
      before,
      captureGitWorkspaceFingerprint(fenceRoot, { volatileRuntimeIndex: true }),
    );
    assertGitWorkspaceUnchanged(headBefore, captureGitWorkspaceFingerprint(headRoot));
  };
}
