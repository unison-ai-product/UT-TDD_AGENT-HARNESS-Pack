/**
 * provider family authority port (PLAN-L7-465 §D3c freeze「信頼根を誇張しない」4)。
 *
 * **本 repo に受理側の実装は無い。** family を機械的に強証明する provider 別 GitHub App /
 * bot / OIDC subject 等は authentication / authorization を変える外部権限設計であり、
 * PO の明示承認を要する。承認・実装されるまで D3d は `unverified_family` を返し、
 * `custody_admitted` を生成しない。
 *
 * 自己申告 `reviewerFamily`、PR comment marker、HARNESS memory 本文、commit trailer、
 * local JSON/HMAC、同一 OS user が使える鍵は、この port の実装として受理してはならない。
 */

export interface VerifiedProviderIdentity {
  /** 承認済み authority が発行した identity であることを型で示す closed tag。 */
  readonly kind: "verified_provider_identity";
  readonly family: "claude" | "codex";
  /** 束縛先 subject。custody receipt と一致しない identity は昇格に使えない。 */
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  /** 承認済み authority の識別子 (PO 承認済み方式名)。 */
  readonly authority: string;
}

export interface ProviderFamilyAuthorityPort {
  resolve(query: {
    readonly repository: string;
    readonly prNumber: number;
    readonly headSha: string;
  }): Promise<VerifiedProviderIdentity | null>;
}
