export const REPOSITORY_DOCUMENT_ZONES = [
  "docs_tree",
  "root_policy",
  "runtime_policy",
  "skills",
  "github_policy",
] as const;

export type RepositoryDocumentZone = (typeof REPOSITORY_DOCUMENT_ZONES)[number];

export interface GitObjectSnapshotMember {
  readonly pathBytes: Uint8Array;
  readonly blobOid: string;
  readonly contentSha256: string;
  readonly fileMode: string;
  readonly zone: RepositoryDocumentZone;
}

export interface GitObjectSnapshotZone {
  readonly zone: RepositoryDocumentZone;
  readonly selectorDigest: string;
  readonly memberCount: number;
  readonly treeOid?: string;
}

export interface GitObjectTreeSnapshot {
  readonly commitOid: string;
  readonly repositoryTreeOid: string;
  readonly rawPathStream: Uint8Array;
  readonly unclassifiedPathStream: Uint8Array;
  readonly members: readonly GitObjectSnapshotMember[];
  readonly zones: readonly GitObjectSnapshotZone[];
}

export interface GitObjectSnapshotRequest {
  readonly repositoryIdentity: string;
  readonly commitOid: string;
  readonly repositoryTreeOid: string;
  readonly selectionRevision: "repository-documents-v1";
  readonly selectionDigest: string;
}

export interface GitObjectSnapshotPort {
  readTree(request: GitObjectSnapshotRequest): Promise<GitObjectTreeSnapshot>;
}
