import {
  type AllowedPathRemap,
  remapTopologyIdentities,
  topologyDigest,
  type WorktreeTopologyReport,
} from "./worktree-topology.ts";

export type TopologyMigrationReason =
  | "accepted"
  | "findings_present"
  | "identity_mismatch"
  | "invalid_remap";

export interface TopologyMigrationInput {
  before: WorktreeTopologyReport;
  after: WorktreeTopologyReport;
  remaps: readonly AllowedPathRemap[];
}

export interface TopologyMigrationResult {
  accepted: boolean;
  reason: TopologyMigrationReason;
  beforeDigest: string;
  afterDigest: string;
}

/**
 * 配置移設を公開する前の純粋acceptance。件数ではなく、許可されたpath remap後の
 * healthy identity集合を比較する。collector・doctor・ファイル操作をここへ混ぜない。
 */
export function evaluateTopologyMigration(input: TopologyMigrationInput): TopologyMigrationResult {
  const beforeDigest = input.before.digest;
  const afterDigest = topologyDigest(input.after.identities);
  if (input.before.findings.length > 0 || input.after.findings.length > 0)
    return { accepted: false, reason: "findings_present", beforeDigest, afterDigest };
  try {
    const remappedDigest = topologyDigest(
      remapTopologyIdentities(input.before.identities, input.remaps),
    );
    return {
      accepted: remappedDigest === afterDigest,
      reason: remappedDigest === afterDigest ? "accepted" : "identity_mismatch",
      beforeDigest: remappedDigest,
      afterDigest,
    };
  } catch {
    return { accepted: false, reason: "invalid_remap", beforeDigest, afterDigest };
  }
}
