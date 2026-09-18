import { type ReleaseManifest, resolveReleaseChannel } from "../schema/release-manifest.ts";
import type { ReleaseArtifactResolution } from "./release-artifact-resolver.ts";
import type { MaterializedReleaseEntry } from "./release-materializer.ts";

export type ReleaseChannelUnavailableReason =
  | "unknown_channel"
  | "unavailable"
  | "invalid_distribution_plan"
  | "invalid_artifact";

export interface ReleaseChannelAdapterInput {
  readonly repository: string;
  readonly manifest: ReleaseManifest;
  readonly channel: string;
}

export interface ReleaseChannelAdapterPorts {
  readonly resolveArtifacts: (input: {
    readonly repository: string;
    readonly release: {
      readonly releaseId: string;
      readonly materializerVersion: string;
      readonly artifactSourceCommit: string;
      readonly artifactSetDigest: string;
    };
  }) => ReleaseArtifactResolution | Promise<ReleaseArtifactResolution>;
}

export type ReleaseChannelAttestation =
  | {
      readonly status: "attested";
      readonly releaseId: string;
      readonly artifactSourceCommit: string;
      readonly expectedDigest: string;
      readonly actualDigest: string;
      readonly entries: readonly MaterializedReleaseEntry[];
    }
  | {
      readonly status: "mismatch";
      readonly releaseId: string;
      readonly artifactSourceCommit: string;
      readonly expectedDigest: string;
      readonly actualDigest: string;
    }
  | {
      readonly status: "unavailable";
      readonly releaseId?: string;
      readonly reason: ReleaseChannelUnavailableReason;
    };

function unavailable(
  reason: ReleaseChannelUnavailableReason,
  releaseId?: string,
): ReleaseChannelAttestation {
  return releaseId === undefined
    ? { status: "unavailable", reason }
    : { status: "unavailable", releaseId, reason };
}

export async function attestReleaseChannel(
  input: ReleaseChannelAdapterInput,
  ports: ReleaseChannelAdapterPorts,
): Promise<ReleaseChannelAttestation> {
  const selected = resolveReleaseChannel(input.manifest, input.channel);
  if (!selected.ok) return unavailable("unknown_channel");

  const release = selected.release;
  let resolved: ReleaseArtifactResolution;
  try {
    resolved = await ports.resolveArtifacts({ repository: input.repository, release });
  } catch {
    return unavailable("unavailable", release.releaseId);
  }
  if (!resolved.ok) return unavailable(resolved.error, release.releaseId);

  if (
    resolved.releaseId !== release.releaseId ||
    resolved.artifactSourceCommit !== release.artifactSourceCommit ||
    resolved.artifactSetDigest !== release.artifactSetDigest
  )
    return unavailable("invalid_artifact", release.releaseId);

  const common = {
    releaseId: release.releaseId,
    artifactSourceCommit: release.artifactSourceCommit,
    expectedDigest: release.artifactSetDigest,
    actualDigest: resolved.digest,
  } as const;
  if (resolved.digest !== release.artifactSetDigest) return { status: "mismatch", ...common };
  return { status: "attested", ...common, entries: resolved.entries };
}

export function createReleaseChannelAdapter(
  ports: ReleaseChannelAdapterPorts,
): (input: ReleaseChannelAdapterInput) => Promise<ReleaseChannelAttestation> {
  return (input) => attestReleaseChannel(input, ports);
}
