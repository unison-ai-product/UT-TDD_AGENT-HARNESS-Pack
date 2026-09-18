/**
 * D3 trusted custody の canonicalization (PLAN-L7-465 §D3c freeze「Receipt envelope」)。
 *
 * 既存 `review-attestation.ts` の preimage 生成を**流用しない**のは仕様である:
 * あちらは key 整列に `localeCompare` を使い digest を 16 桁へ切り詰めている。前者は
 * ICU の locale / 実装差で順序が動き、後者は 64 bit しか残らないため、GitHub attestation
 * の binding 入力にできない。ここは RFC 8785 (JSON Canonicalization Scheme) の
 * UTF-16 code unit 順 + SHA-256 lowerhex 全 64 桁に固定する。
 */
import { createHash } from "node:crypto";

/** canonicalize が受理する値。undefined / 非有限数 / 非安全整数は受理しない。 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export type CanonicalOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: "canonical_unsupported_value" };

const REVIEW_REVISION_PREFIX = "rv1-";

/** RFC 8785 が要求する key 順は UTF-16 code unit 昇順であり、locale 照合順ではない。 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeValue(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "undefined") return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const entry of value as readonly unknown[]) {
      const encoded = canonicalizeValue(entry);
      if (encoded === null) return null;
      parts.push(encoded);
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value !== "object") return null;
  const record = value as { readonly [key: string]: unknown };
  const parts: string[] = [];
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    const encoded = canonicalizeValue(record[key]);
    if (encoded === null) return null;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * RFC 8785 JCS で正規化した JSON 文字列を返す。`CanonicalValue` で表現できない値
 * (undefined / 非安全整数 / function 等) は例外にせず typed failure にする。
 */
export function canonicalize(value: unknown): CanonicalOutcome {
  const encoded = canonicalizeValue(value);
  return encoded === null
    ? { ok: false, reason: "canonical_unsupported_value" }
    : { ok: true, value: encoded };
}

/** UTF-8 bytes の SHA-256 を 64 桁 lowerhex で返す (切り詰めない)。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 完成 artifact bytes の SHA-256。receipt へ書き戻さない一方向計算に使う。 */
export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * review request の exact identity。`requestedAt` は更新可能な metadata なので含めない
 * (同一レビューの retry が同じ revision へ収束する)。
 */
export interface ReviewRequestIdentity {
  readonly schemaVersion: "review-request/v1";
  readonly memoryId: string;
  readonly pr: number;
  readonly exactHead: string;
  readonly authorFamily: "claude" | "codex";
}

export type ReviewRevisionOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: "canonical_unsupported_value" };

/** request digest (`rv1-<64 lowerhex>`) を canonical identity から導出する。 */
export function computeReviewRevision(identity: ReviewRequestIdentity): ReviewRevisionOutcome {
  const canonical = canonicalize({
    schemaVersion: identity.schemaVersion,
    memoryId: identity.memoryId,
    pr: identity.pr,
    exactHead: identity.exactHead,
    authorFamily: identity.authorFamily,
  });
  if (!canonical.ok) return canonical;
  return { ok: true, value: `${REVIEW_REVISION_PREFIX}${sha256Hex(canonical.value)}` };
}

export const REVIEW_REVISION_PATTERN = /^rv1-[0-9a-f]{64}$/;
