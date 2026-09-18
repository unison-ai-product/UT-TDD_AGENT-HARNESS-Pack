import {
  type RepositoryDocsSnapshotResult,
  RepositoryDocsSnapshotValue,
  validateSnapshotRequest,
} from "../domain/repository-docs-snapshot.ts";
import type {
  GitObjectSnapshotPort,
  GitObjectSnapshotRequest,
} from "../ports/git-object-snapshot.ts";

export async function captureRepositoryDocsSnapshot(
  input: GitObjectSnapshotRequest,
  git: GitObjectSnapshotPort,
): Promise<RepositoryDocsSnapshotResult> {
  const invalid = validateSnapshotRequest(input);
  if (invalid) return invalid;
  return RepositoryDocsSnapshotValue.create(input, await git.readTree(input));
}
