import { reviewerAdmissionDenial } from "../feedback/review-admission-check.ts";

// review identity を渡した委譲の入口の検査 (#1600)。request を書く前に、失敗を文字列で返す。
// 契約: docs/design/harness/L6-function-design/review-request-admission.md §4

interface ReviewIdentityOptions {
  reviewPr?: string;
  reviewHead?: string;
  reviewRevision?: string;
  reviewAuthorFamily?: string;
  reviewMemoryId?: string;
}

export function reviewIdentityDeclared(opts: ReviewIdentityOptions): boolean {
  return Boolean(
    opts.reviewPr ||
      opts.reviewHead ||
      opts.reviewRevision ||
      opts.reviewAuthorFamily ||
      opts.reviewMemoryId,
  );
}

// 宣言の部分指定・空 memory id・review lane でない role を拒否する (既存の検査)。
export function reviewIdentityDenial(
  opts: ReviewIdentityOptions & { role: string },
  reviewLane: string | undefined,
): string | undefined {
  if (!reviewIdentityDeclared(opts)) {
    // 空 memory id の単独指定は「宣言なし」に見えるが、既存の検査どおり拒否する。
    return opts.reviewMemoryId !== undefined && !opts.reviewMemoryId.trim()
      ? "review_memory_id_required: --review-memory-id must not be blank"
      : undefined;
  }
  if (!opts.reviewPr || !opts.reviewHead || !opts.reviewRevision?.trim()) {
    return "review_head_required: review identity requires --review-pr, --review-head, and --review-revision together";
  }
  if (opts.reviewMemoryId !== undefined && !opts.reviewMemoryId.trim()) {
    return "review_memory_id_required: --review-memory-id must not be blank";
  }
  if (!reviewLane) {
    return (
      `review_identity_requires_review_lane: role=${opts.role} is not a review lane role; ` +
      "review identity flags produce no receipt here"
    );
  }
  return undefined;
}

// option 値の取り違え (値が別 option 名になる、値が消えて位置引数が余る) を拒否する。
export function reviewShapeDenial(
  revision: string | undefined,
  extraArgs: readonly string[],
): string | undefined {
  if (revision?.trim().startsWith("-")) {
    return "review_revision_invalid: --review-revision must not look like an option";
  }
  if (extraArgs.length > 0) {
    return `review_unexpected_argument: unexpected argument(s): ${extraArgs.join(" ")}`;
  }
  return undefined;
}

// 値の形、族分離、model の下限を request の書き込み前に判定する。
export function reviewAdmissionDenial(input: {
  revision: string | undefined;
  extraArgs: readonly string[];
  authorFamily: "codex" | "claude";
  provider: "codex" | "claude";
  model: string;
}): string | undefined {
  return (
    reviewShapeDenial(input.revision, input.extraArgs) ??
    reviewerAdmissionDenial({
      authorFamily: input.authorFamily,
      provider: input.provider,
      model: input.model,
    })
  );
}
