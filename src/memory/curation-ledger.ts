/**
 * Memory curation ledger (PLAN-L6-104 §3.1 判断 6 / 7, PLAN-L7-566 §3, CANDIDATE-U-MEMCUT-024..028).
 *
 * The ledger records, for every legacy corpus source, the adopt / reject decision against the six
 * PO criteria. Tracked sources are named by their archive path; untracked sources appear only as a
 * content digest plus an opaque local-archive custody id (never a path). Every adopt row is bound to
 * the `ut-tdd memory add` registration receipt of the re-registered canonical entry, and the ledger
 * as a whole carries the non-author reviewer record bound to the exact head that was judged.
 *
 * The document that ships is Markdown (`docs/governance/memory-curation-ledger-2026-09.md`) whose
 * machine section is a fenced ```json block; this module owns both directions.
 */
import {
  type LegacyArchiveManifest,
  sha256Hex,
  untrackedSetDigest,
} from "./legacy-archive-manifest.ts";

// Keep the memory verifier in the low-level memory layer. Importing the team policy here would
// create a cycle (memory → team → workflow/state-db → graph/vmodel → runtime → memory) while the
// reviewer record only needs the two immutable frontier identities for the blind-review lane.
const BLIND_REVIEW_FRONTIER_MODELS: Readonly<Record<CurationReviewer["family"], string>> = {
  claude: "claude-opus-5",
  codex: "gpt-5.6-sol",
};

export const CURATION_LEDGER_PATH = "docs/governance/memory-curation-ledger-2026-09.md";
export const CURATION_LEDGER_SCHEMA = "ut-tdd.memory-curation-ledger/v1";
export const CURATION_CRITERIA = [
  "reusable",
  "evidenced",
  "actionable",
  "episode_independent",
  "no_secret_pii",
  "deduplicated",
] as const;
export type CurationCriterion = (typeof CURATION_CRITERIA)[number];

export interface RegistrationReceipt {
  operation_id: string;
  memory_id: string;
  /** Canonical source path written by `memory add`, always under `.ut-tdd/memory/`. */
  source_path: string;
  content_digest: string;
  exit_code: number;
}

export interface CurationAdopt {
  memory_id: string;
  kind: "feedback" | "project" | "reference" | "user";
  title: string;
  tags: string[];
  registration: RegistrationReceipt;
  /** sha256 hex over the canonical JSON of `registration` (see registrationReceiptDigest). */
  receipt_digest: string;
}

export interface CurationRow {
  source: "tracked" | "untracked";
  /** tracked only: the archive path recorded in MANIFEST.json */
  archive_path?: string;
  /** untracked only: opaque custody id derived from the digest, never a path */
  custody_id?: string;
  source_digest: string;
  decision: "adopt" | "reject";
  criteria: Record<CurationCriterion, boolean>;
  evidence: string[];
  reason: string;
  merged_from?: string[];
  adopt?: CurationAdopt;
}

export interface CurationReviewer {
  model: string;
  family: "claude" | "codex";
  /** exact head (40 hex) whose ledger and canonical corpus were judged */
  exact_head: string;
  verdict: "PASS" | "PASS-WEAK";
  receipt: string;
}

export interface CurationLedger {
  schema_version: typeof CURATION_LEDGER_SCHEMA;
  base_commit: string;
  author: { model: string; family: "claude" | "codex" };
  reviewer?: CurationReviewer;
  rows: CurationRow[];
}

export interface CurationFinding {
  kind:
    | "row-path-not-in-manifest"
    | "row-digest-mismatch"
    | "untracked-row-carries-path"
    | "untracked-custody-id-mismatch"
    | "untracked-set-mismatch"
    | "criteria-incomplete"
    | "reason-missing"
    | "adopt-criteria-not-met"
    | "adopt-evidence-missing"
    | "adopt-registration-missing"
    | "adopt-receipt-digest-mismatch"
    | "adopt-source-path-outside-canonical"
    | "adopt-replay-missing"
    | "adopt-replay-exit-nonzero"
    | "adopt-replay-source-path-outside-canonical"
    | "adopt-replay-memory-id-mismatch"
    | "adopt-replay-content-digest-mismatch"
    | "adopt-replay-receipt-digest-mismatch"
    | "merged-from-unknown"
    | "adopt-not-in-canonical"
    | "canonical-not-in-ledger"
    | "adopt-body-episodic"
    | "reject-evidence-missing"
    | "reviewer-missing"
    | "reviewer-same-family"
    | "reviewer-not-frontier"
    | "reviewer-head-invalid"
    | "reviewer-receipt-invalid";
  subject: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ALL_ZERO_HEAD = /^0{40}$/;
// A real review receipt id: the `rv1-<sha256>` form written under `.ut-tdd/review/receipts/`,
// a bare sha256 digest, or a `certificate:`-prefixed plan-admission style id. The unbound
// placeholder string "pending-review-receipt" matches none of these.
const REVIEW_RECEIPT_ID = /^(?:rv1-[0-9a-f]{64}|[0-9a-f]{64}|certificate:[A-Za-z0-9._:-]+)$/;

export function custodyIdFor(sourceDigest: string): string {
  return `local-archive:${sha256Hex(`ut-tdd.memory-legacy-local-archive/v1\n${sourceDigest}\n`).slice(0, 24)}`;
}

/**
 * CANDIDATE-U-MEMCUT-026: the digest a canonical `.ut-tdd/memory/*.md` file's raw bytes must
 * produce to match `RegistrationReceipt.content_digest` (same sha256-over-raw-text scheme as
 * `MemoryEntry.content_hash` in `src/memory/index.ts`). Exposed so the ledger test can assert the
 * receipt actually binds to the canonical file's bytes instead of only recomputing its own digest.
 */
export function canonicalMemoryContentDigest(rawFileText: string): string {
  return sha256Hex(rawFileText);
}

export function registrationReceiptDigest(receipt: RegistrationReceipt): string {
  const canonical = JSON.stringify({
    content_digest: receipt.content_digest,
    exit_code: receipt.exit_code,
    memory_id: receipt.memory_id,
    operation_id: receipt.operation_id,
    source_path: receipt.source_path,
  });
  return sha256Hex(canonical);
}

/**
 * Digest over the receipt fields a real `ut-tdd memory add --receipt-json` invocation reports and
 * that are invariant across replays: `operation_id` (the pin the caller passed with
 * `--operation-id`, which the test derives from the archived source bytes, never from the ledger),
 * `memory_id`, `source_path` and `exit_code`. `content_digest` is deliberately compared separately
 * (see `verifyAdoptRegistrationReplay`): it is a whole-file sha256 that embeds `updated_at`, so a
 * replay run at a later real time can never reproduce the historical value byte-for-byte; the
 * test-design oracle (U-MEMCUT-026) requires the replayed file to match the canonical file on
 * every frontmatter value and the body *except* `updated_at`.
 */
function replayReceiptDigest(receipt: RegistrationReceipt): string {
  const canonical = JSON.stringify({
    exit_code: receipt.exit_code,
    memory_id: receipt.memory_id,
    operation_id: receipt.operation_id,
    source_path: receipt.source_path,
  });
  return sha256Hex(canonical);
}

/** The bytes of a canonical memory file with the one replay-variant frontmatter value removed. */
export function memoryTextWithoutUpdatedAt(rawFileText: string): string {
  return rawFileText.replace(/^updated_at:.*$/m, "updated_at: <redacted>");
}

/** `memory add --receipt-json` prints `sha256:<hex>`; the ledger records the bare hex. */
function bareDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function criteriaComplete(row: CurationRow): boolean {
  return CURATION_CRITERIA.every((key) => typeof row.criteria?.[key] === "boolean");
}

/** CANDIDATE-U-MEMCUT-024: every row is bound to the manifest and carries a complete decision. */
export function verifyCurationRows(input: {
  ledger: CurationLedger;
  manifest: LegacyArchiveManifest;
}): CurationFinding[] {
  const findings: CurationFinding[] = [];
  const byArchivePath = new Map(input.manifest.tracked.map((row) => [row.archive_path, row]));
  const digests = new Set(input.ledger.rows.map((row) => row.source_digest));
  const untrackedDigests: string[] = [];
  for (const row of input.ledger.rows) {
    const subject = row.archive_path ?? row.custody_id ?? row.source_digest;
    if (row.source === "tracked") {
      const manifestRow = row.archive_path ? byArchivePath.get(row.archive_path) : undefined;
      if (!manifestRow) findings.push({ kind: "row-path-not-in-manifest", subject });
      else if (manifestRow.sha256 !== row.source_digest)
        findings.push({ kind: "row-digest-mismatch", subject });
    } else {
      if (row.archive_path !== undefined || /[\\/]/.test(row.custody_id ?? ""))
        findings.push({ kind: "untracked-row-carries-path", subject });
      if (row.custody_id !== custodyIdFor(row.source_digest))
        findings.push({ kind: "untracked-custody-id-mismatch", subject });
      untrackedDigests.push(row.source_digest);
    }
    if (!HEX64.test(row.source_digest)) findings.push({ kind: "row-digest-mismatch", subject });
    if (!criteriaComplete(row)) findings.push({ kind: "criteria-incomplete", subject });
    if (!row.reason?.trim()) findings.push({ kind: "reason-missing", subject });
    for (const merged of row.merged_from ?? []) {
      if (!digests.has(merged)) findings.push({ kind: "merged-from-unknown", subject: merged });
    }
    if (row.decision === "adopt") findings.push(...verifyAdoptRow(row, subject));
    else if (!row.evidence || row.evidence.length === 0)
      findings.push({ kind: "reject-evidence-missing", subject });
  }
  if (
    untrackedDigests.length !== input.manifest.untracked.count ||
    untrackedSetDigest(untrackedDigests) !== input.manifest.untracked.set_digest
  )
    findings.push({ kind: "untracked-set-mismatch", subject: "manifest.untracked" });
  return findings;
}

function verifyAdoptRow(row: CurationRow, subject: string): CurationFinding[] {
  const findings: CurationFinding[] = [];
  if (!CURATION_CRITERIA.every((key) => row.criteria?.[key] === true))
    findings.push({ kind: "adopt-criteria-not-met", subject });
  if (!row.evidence || row.evidence.length === 0)
    findings.push({ kind: "adopt-evidence-missing", subject });
  const adopt = row.adopt;
  if (!adopt?.registration) {
    findings.push({ kind: "adopt-registration-missing", subject });
    return findings;
  }
  const receipt = adopt.registration;
  if (
    receipt.exit_code !== 0 ||
    receipt.memory_id !== adopt.memory_id ||
    !receipt.operation_id ||
    !HEX64.test(receipt.content_digest)
  )
    findings.push({ kind: "adopt-registration-missing", subject });
  if (adopt.receipt_digest !== registrationReceiptDigest(receipt))
    findings.push({ kind: "adopt-receipt-digest-mismatch", subject });
  const path = receipt.source_path.replaceAll("\\", "/");
  if (!path.startsWith(".ut-tdd/memory/") || path.slice(".ut-tdd/memory/".length).includes("/"))
    findings.push({ kind: "adopt-source-path-outside-canonical", subject });
  return findings;
}

/**
 * CANDIDATE-U-MEMCUT-026 (Sol r2 FLAG 2): the ledger's adopt→registration binding must be checked
 * against an actual `memory add` replay, not against the ledger's own self-declared registration
 * object. `replay` is built by the caller from the *output* of a real replay (in-process
 * `writeMemory` call or `memory add` subprocess): the memory id / source path / exit code the
 * replay reported, and a content digest recomputed over the file bytes the replay actually wrote.
 * `null` means no successful replay was obtained at all (a handwritten twin with no registration,
 * or a replay that threw) and is itself a finding, never a silent skip.
 */
export function verifyAdoptRegistrationReplay(input: {
  row: CurationRow;
  /** Current raw bytes of the canonical file the row claims to be bound to. */
  canonicalRawText: string;
  /** The receipt the real `memory add --receipt-json` subprocess printed (never test-built). */
  replay: RegistrationReceipt | null;
  /** The bytes that subprocess actually wrote at `replay.source_path` in its scratch root. */
  replayRawText?: string;
}): CurationFinding[] {
  const subject = input.row.archive_path ?? input.row.custody_id ?? input.row.source_digest;
  const adopt = input.row.adopt;
  if (!adopt) return [{ kind: "adopt-registration-missing", subject }];
  if (!input.replay) return [{ kind: "adopt-replay-missing", subject }];
  const findings: CurationFinding[] = [];
  const replay = input.replay;
  if (replay.exit_code !== 0) findings.push({ kind: "adopt-replay-exit-nonzero", subject });
  const path = replay.source_path.replaceAll("\\", "/");
  if (!path.startsWith(".ut-tdd/memory/") || path.slice(".ut-tdd/memory/".length).includes("/"))
    findings.push({ kind: "adopt-replay-source-path-outside-canonical", subject });
  if (replay.memory_id !== adopt.memory_id)
    findings.push({ kind: "adopt-replay-memory-id-mismatch", subject });
  // Content binding, three legs that together close the "handwritten twin" bypass: the ledger's
  // registration digest must be the canonical file's real digest; the CLI receipt's digest must be
  // the digest of the bytes the CLI actually wrote (a receipt cannot lie about its own output); and
  // those bytes must equal the canonical file except `updated_at`.
  const replayRawText = input.replayRawText ?? "";
  if (
    bareDigest(adopt.registration.content_digest) !==
      canonicalMemoryContentDigest(input.canonicalRawText) ||
    bareDigest(replay.content_digest) !== canonicalMemoryContentDigest(replayRawText) ||
    memoryTextWithoutUpdatedAt(replayRawText) !== memoryTextWithoutUpdatedAt(input.canonicalRawText)
  )
    findings.push({ kind: "adopt-replay-content-digest-mismatch", subject });
  // The replay-invariant receipt fields (operation id / memory id / source path / exit code) must
  // reproduce the ledger's registration. The receipt is CLI output, so a ledger row can no longer
  // satisfy this by echoing its own declared values through a test-built receipt (Sol r3/r4 FLAG).
  if (replayReceiptDigest(replay) !== replayReceiptDigest(adopt.registration))
    findings.push({ kind: "adopt-replay-receipt-digest-mismatch", subject });
  return findings;
}

/** CANDIDATE-U-MEMCUT-025: adopt rows and the canonical corpus are the same set of memory ids. */
export function verifyCurationCoverage(input: {
  ledger: CurationLedger;
  canonicalMemoryIds: readonly string[];
}): CurationFinding[] {
  const findings: CurationFinding[] = [];
  const adopted = new Set(
    input.ledger.rows.filter((row) => row.decision === "adopt").map((row) => row.adopt?.memory_id),
  );
  const canonical = new Set(input.canonicalMemoryIds);
  for (const id of adopted) {
    if (id && !canonical.has(id)) findings.push({ kind: "adopt-not-in-canonical", subject: id });
  }
  for (const id of canonical) {
    if (!adopted.has(id)) findings.push({ kind: "canonical-not-in-ledger", subject: id });
  }
  return findings;
}

const EPISODIC_MARKERS: Array<[RegExp, string]> = [
  [/\bPR\s?#?\d{2,5}\b/i, "pr-number"],
  [/#\d{2,5}\b/, "issue-number"],
  [/\b[0-9a-f]{7,40}\b/, "commit-hash"],
  [
    /exact[- ]head\s+[0-9a-f]{7,}|verdict:?\s*(?:PASS-WEAK|PASS|FLAG)\b|receipt\s+[0-9a-f]{7,}|\brv1-[0-9a-f]{8,}/i,
    "review-episode",
  ],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "timestamp"],
  [/[A-Za-z]:\\Users\\|\/Users\/|\/home\/[a-z]/, "personal-path"],
  [
    /AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    "secret-like",
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "email"],
];

/** CANDIDATE-U-MEMCUT-027: an adopted body must not carry episode identity, secrets or personal paths. */
export function screenAdoptText(text: string): string[] {
  return EPISODIC_MARKERS.filter(([re]) => re.test(text)).map(([, tag]) => tag);
}

/** CANDIDATE-U-MEMCUT-028: the reviewer record is non-author, frontier tier and head-bound. */
export function verifyCurationReviewer(ledger: CurationLedger): CurationFinding[] {
  const reviewer = ledger.reviewer;
  if (!reviewer) return [{ kind: "reviewer-missing", subject: "ledger.reviewer" }];
  const findings: CurationFinding[] = [];
  if (reviewer.family === ledger.author.family)
    findings.push({ kind: "reviewer-same-family", subject: reviewer.model });
  const frontier = BLIND_REVIEW_FRONTIER_MODELS[reviewer.family];
  if (reviewer.model !== frontier)
    findings.push({ kind: "reviewer-not-frontier", subject: reviewer.model });
  if (!HEX40.test(reviewer.exact_head) || ALL_ZERO_HEAD.test(reviewer.exact_head))
    findings.push({ kind: "reviewer-head-invalid", subject: reviewer.exact_head });
  if (!REVIEW_RECEIPT_ID.test(reviewer.receipt))
    findings.push({ kind: "reviewer-receipt-invalid", subject: reviewer.receipt });
  return findings;
}

const FENCE_OPEN = "```json ut-tdd-memory-curation-ledger";
const FENCE_CLOSE = "```";

export function parseCurationLedgerDocument(markdown: string): CurationLedger {
  const start = markdown.indexOf(FENCE_OPEN);
  if (start < 0) throw new Error("curation ledger machine section is missing");
  const bodyStart = markdown.indexOf("\n", start) + 1;
  const end = markdown.indexOf(`\n${FENCE_CLOSE}`, bodyStart);
  if (end < 0) throw new Error("curation ledger machine section is unterminated");
  const raw = JSON.parse(markdown.slice(bodyStart, end)) as CurationLedger;
  if (raw.schema_version !== CURATION_LEDGER_SCHEMA)
    throw new Error(`unexpected curation ledger schema: ${String(raw.schema_version)}`);
  return raw;
}

export function renderCurationLedgerDocument(ledger: CurationLedger): string {
  const adopt = ledger.rows.filter((row) => row.decision === "adopt").length;
  const reject = ledger.rows.length - adopt;
  const merged = ledger.rows.reduce((sum, row) => sum + (row.merged_from?.length ?? 0), 0);
  const tracked = ledger.rows.filter((row) => row.source === "tracked").length;
  const untracked = ledger.rows.length - tracked;
  const reviewer = ledger.reviewer
    ? `- 非著者 reviewer: \`${ledger.reviewer.model}\` (${ledger.reviewer.family} family、frontier tier)、対象 exact head \`${ledger.reviewer.exact_head}\`、verdict ${ledger.reviewer.verdict}、receipt \`${ledger.reviewer.receipt}\``
    : "- 非著者 reviewer: 未記録 (非著者 frontier review の receipt を待つ)";
  return [
    "# legacy memory corpus 採否台帳 2026-09 (Issue #424 PR-2)",
    "",
    "legacy memory corpus (PLAN-L6-104 §3.1 判断 6 / 7) の採否台帳。自動分類は候補提示にだけ使い、採用は 6 基準を全て満たす entry に限る。",
    "採用 entry は `ut-tdd memory add` で 1 件ずつ canonical root へ登録し、その registration receipt の digest を行に束縛する。",
    "untracked source は内容 digest と opaque な local-archive custody id だけを記録し、path・title・本文は書かない。",
    "",
    `- スキーマ: \`${ledger.schema_version}\``,
    `- 基準 commit (PR-2 base): \`${ledger.base_commit}\``,
    `- 著者 (author family): \`${ledger.author.model}\` (${ledger.author.family})`,
    reviewer,
    `- 行数: ${ledger.rows.length} 件 (tracked ${tracked} / untracked ${untracked})、採用 (adopt) ${adopt} 件、不採用 (reject) ${reject} 件、統合元 (merged_from) ${merged} 件`,
    "",
    "## 6 基準",
    "",
    "1. reusable — 再利用可能である",
    "2. evidenced — 現行の canonical doc / code / incident evidence に裏付けがある",
    "3. actionable — 具体的な action / decision rule である",
    "4. episode_independent — PR 番号・exact head・review request・verdict・handoff・進捗から独立している",
    "5. no_secret_pii — secret / PII / 個人環境を含まない",
    "6. deduplicated — 同義語を統合済みで、他の entry と矛盾しない",
    "",
    "機械照合は `tests/memory-curation-ledger.test.ts` (U-MEMCUT-024〜028) が `MANIFEST.json` と canonical root に対して行う。",
    "",
    "## 台帳本体 (機械照合用 JSON)",
    "",
    FENCE_OPEN,
    JSON.stringify(ledger, null, 1),
    FENCE_CLOSE,
    "",
  ].join("\n");
}
