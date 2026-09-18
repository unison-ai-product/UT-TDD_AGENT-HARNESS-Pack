export type ReviewVerdictName = "PASS" | "PASS-WEAK" | "FLAG";

export interface VerdictExtraction {
  verdict: ReviewVerdictName;
  blockingFindings: string[];
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; reasons: string[] };

/** reviewer が verdict file を書くための単一の環境変数名。 */
export const REVIEW_VERDICT_FILE_ENV = "UT_TDD_REVIEW_VERDICT_FILE";

export interface ReviewVerdictContractMetadata {
  schemaVersion: string;
  requestDigest: string;
  attempt: number;
  pr: number;
  exactHead: string;
  reviewRevision: string;
  reviewerProvider: "codex" | "claude";
  reviewerModel: string;
  invocationNonce: string;
}

const EXAMPLE_START = "<!-- review-output-example:start -->";
const EXAMPLE_END = "<!-- review-output-example:end -->";
const VERDICTS: readonly ReviewVerdictName[] = ["PASS", "PASS-WEAK", "FLAG"];

/**
 * 模範出力ブロック内の各行に付ける退避 indent。
 *
 * **これは飾りではなく blocking bug の対策である。** 委譲した task text は provider の
 * captured log へ**行頭のまま verbatim に echo される** (2026-07-31 実測: 委譲ログに
 * `^# タスク: ...` / `^## 実装 1: ...` が行頭一致で現れる)。したがって模範出力を行頭
 * `VERDICT: FLAG` で書くと、reviewer が `PASS` を返したログに
 * 「echo された FLAG」と「実判定の PASS」の 2 値が並び、`verdict_ambiguous` で
 * **PASS だけが恒久 fail-close する** (FLAG は同値なので通る) という非対称な破壊が起きる。
 *
 * indent された行は `extractVerdict` の候補にならない (行頭のみを候補とする) ので、
 * echo されても無害になる。`reviewOutputContractExample` が抽出時に dedent するため、
 * contract と parser の round-trip は維持される (U-RVCON-017 / 019 が回帰フェンス)。
 */
const EXAMPLE_INDENT = "    ";

/**
 * reviewer に注入する、構造化 verdict の出力契約。
 *
 * `verdictFilePath` を渡すと、書き出し先を**literal absolute path として本文へ埋め込む**。
 * env 変数名だけを渡す形は、子 runtime が環境変数を参照できない構成 (Claude Code の
 * permission 設定が `env` / `printenv` / `echo $VAR` を拒否する等) で履行不能になり、
 * verdict は stdout に出ているのに verdict file が 0 件 → receipt 0 件 → wrapper deny という
 * 恒久 fail が起きる (2026-08-14 実測: PR #319 の self-bootstrap で delegated Claude が
 * `VERDICT: PASS` を返しながら path を解決できず `reviewer_execution_failed`)。
 * env 名も併記して従来経路との互換を保つ。
 */
export function reviewOutputContract(
  verdictFilePath?: string,
  metadata?: ReviewVerdictContractMetadata,
): string {
  const destination = verdictFilePath
    ? `同じ verdict ブロックを次の path にも書いてください: ${verdictFilePath} (環境変数 ${REVIEW_VERDICT_FILE_ENV} と同値です。環境変数を読めない場合はこの path をそのまま使ってください)。`
    : `同じ verdict ブロックを ${REVIEW_VERDICT_FILE_ENV} が指す path にも書いてください。`;
  const envelope = metadata
    ? [
        "verdict file の VERDICT 行より前に、次の custody envelope を値を変えずに書いてください:",
        `schema_version: ${metadata.schemaVersion}`,
        `request_digest: ${metadata.requestDigest}`,
        `attempt: ${metadata.attempt}`,
        `pr: ${metadata.pr}`,
        `exact_head: ${metadata.exactHead}`,
        `review_revision: ${metadata.reviewRevision}`,
        `reviewer_provider: ${metadata.reviewerProvider}`,
        `reviewer_model: ${metadata.reviewerModel}`,
        `invocation_nonce: ${metadata.invocationNonce}`,
      ]
    : [];
  return [
    "レビュー完了時は、行頭の verdict 行を必ず 1 件出力してください。再掲する場合も値を一致させてください。",
    "使用できる verdict は `VERDICT: PASS`、`VERDICT: PASS-WEAK`、`VERDICT: FLAG` の 3 種だけです。",
    "FLAG の場合は、行頭 `FINDING:` に blocking finding を 1 件以上、1 行ずつ出力してください。",
    "PASS または PASS-WEAK の場合は `FINDING:` を出力しないでください。",
    destination,
    ...envelope,
    "下記は書式の例です。**実際の出力は行頭に置くこと** (下の例は説明用に字下げしてあります)。",
    EXAMPLE_START,
    `${EXAMPLE_INDENT}VERDICT: FLAG`,
    `${EXAMPLE_INDENT}FINDING: blocking finding summary`,
    EXAMPLE_END,
  ].join("\n");
}

/** path 不明時の既定契約 (identity 宣言のない review lane はこちらを使う)。 */
export const REVIEW_OUTPUT_CONTRACT = reviewOutputContract();

/**
 * contract 内の parser 検証用模範出力を、行頭形へ dedent して返す。
 *
 * contract 側は echo 対策で字下げしてある (`EXAMPLE_INDENT`) ため、parser へ渡す前に外す。
 * これにより「contract が指示した書式は parser が受理する」round-trip を機械保証できる。
 */
export function reviewOutputContractExample(): string {
  const start = REVIEW_OUTPUT_CONTRACT.indexOf(EXAMPLE_START);
  const end = REVIEW_OUTPUT_CONTRACT.indexOf(EXAMPLE_END);
  if (start < 0 || end < 0 || end <= start) return "";
  return REVIEW_OUTPUT_CONTRACT.slice(start + EXAMPLE_START.length, end)
    .split(/\r?\n/)
    .map((line) => (line.startsWith(EXAMPLE_INDENT) ? line.slice(EXAMPLE_INDENT.length) : line))
    .join("\n")
    .trim();
}

function failure(reason: string): Outcome<never> {
  return { ok: false, reasons: [reason] };
}

export function extractVerdict(logText: string): Outcome<VerdictExtraction> {
  const lines = logText.split(/\r?\n/);
  const candidates: Array<{ value: string; lineIndex: number }> = [];
  const verdictLine = /^VERDICT:[ \t]*(.*)$/;

  for (const [lineIndex, line] of lines.entries()) {
    const match = verdictLine.exec(line);
    if (match) candidates.push({ value: match[1].trim(), lineIndex });
  }

  if (candidates.length === 0) return failure("verdict_absent");

  const candidateValues = new Set(candidates.map((candidate) => candidate.value));
  if (candidateValues.size > 1) return failure("verdict_ambiguous");

  const verdict = candidates[0].value;
  if (!VERDICTS.includes(verdict as ReviewVerdictName)) return failure("verdict_unknown");

  const lastVerdictLine = candidates.at(-1)?.lineIndex ?? -1;
  const blockingFindings = lines.slice(lastVerdictLine + 1).flatMap((line) => {
    const match = /^FINDING:(.*)$/.exec(line);
    const finding = match?.[1].trim() ?? "";
    return finding ? [finding] : [];
  });

  if (verdict === "FLAG" && blockingFindings.length === 0) {
    return failure("flag_without_findings");
  }
  if (verdict !== "FLAG" && blockingFindings.length > 0) {
    return failure("findings_on_pass");
  }

  return {
    ok: true,
    value: { verdict: verdict as ReviewVerdictName, blockingFindings },
  };
}
