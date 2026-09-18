export type ProviderFamily = "claude" | "codex";

/** D3a custody が実 spawn から検証した invocation fact。 */
export interface VerifiedProviderInvocation extends ProviderJudgmentAttemptIdentity {
  readonly provider: ProviderFamily;
  readonly model: string;
}

export interface ProviderJudgmentAttemptIdentity {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly requestMemoryId: string;
  readonly requestDigest: string;
  readonly reviewRevision: string;
  readonly attempt: number;
  readonly authorFamily: ProviderFamily;
  readonly invocationNonce: string;
}

export type ProviderEvidenceReadResult =
  | {
      readonly status: "available";
      readonly identity: ProviderJudgmentAttemptIdentity;
      readonly provider: ProviderFamily;
      readonly model: string;
      readonly bytes: Uint8Array;
    }
  | { readonly status: "missing" | "superseded" }
  | { readonly status: "provider_failure"; readonly detail?: string };

export interface PersistedProviderJudgment {
  readonly identityDigest: string;
  readonly judgmentDigest: string;
  readonly bytes: Uint8Array;
}

export type ProviderJudgmentWriteResult =
  | { readonly status: "written" | "replay" }
  | { readonly status: "conflict" | "failed" };

/**
 * Provider evidence の取得と content-addressed judgment の永続化境界。
 * digest/ref は caller input にせず、producer が bytes から導出する。
 */
export interface ProviderJudgmentEvidencePort {
  read(identity: ProviderJudgmentAttemptIdentity): Promise<ProviderEvidenceReadResult>;
  write(judgment: PersistedProviderJudgment): Promise<ProviderJudgmentWriteResult>;
}
