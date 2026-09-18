export interface DuplicateArtifactOwnershipFinding {
  kind: "duplicate-artifact-ownership";
  artifactPath: string;
  planIds: string[];
}

export interface ArtifactOwnershipResult {
  findings: DuplicateArtifactOwnershipFinding[];
  ok: boolean;
}

export function analyzeArtifactOwnership(input: {
  ownersByPath: ReadonlyMap<string, readonly string[]>;
  baseline: ReadonlySet<string>;
}): ArtifactOwnershipResult {
  const findings = [...input.ownersByPath]
    .filter(([path, planIds]) => planIds.length > 1 && !input.baseline.has(path))
    .map(([artifactPath, planIds]) => ({
      kind: "duplicate-artifact-ownership" as const,
      artifactPath,
      planIds: [...planIds].sort(),
    }))
    .sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
  return { findings, ok: findings.length === 0 };
}
