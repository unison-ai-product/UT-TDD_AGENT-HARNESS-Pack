#!/usr/bin/env node
/**
 * pre-push 対象拡大スキャン本体 (PLAN-L7-260 §4、PO 採択案 A、2026-07-13、
 * blind review 指摘反映 2026-07-13)。
 *
 * `scripts/git-hooks/pre-push` から stdin 経由で「push される commit 群の diff スコープ」
 * (`<sha>\t<path>` 行の一覧) を受け取り、各 commit 時点の blob (`git show <sha>:<path>`)
 * を対象に以下 2 系統を検査する:
 *
 *   1. credential marker — `src/lint/secret-scan.ts` の `analyzeSecretScan` を再利用する
 *      (新規 scanner 実装禁止)。
 *   2. PII marker (電話番号 / 郵便番号 / email / internal URL) — 現行
 *      `.git/hooks/pre-push` の既存 SCAN_REGEX を後退させず
 *      温存し、ここで tracked 化する (unconditional match、dummy/placeholder 例外なし。
 *      legacy 挙動と 1:1 で揃える)。
 *
 * 対象は 3 パターン限定 (`*CLAUDE.md` / `*SKILL.md` / references 配下 `*.md`) を撤廃し、
 * docs/・.ut-tdd/audit/・.ut-tdd/logs/・.ut-tdd/memory を含む変更ファイルへ拡大する
 * (WIDENED_SCAN_PREFIXES)。
 *
 * 【設計注記: なぜ working tree ではなく blob を読むか】
 * 当初案は変更ファイル一覧を現在の working tree (disk) から読む方式だったが、blind review
 * (Codex gpt-5.6-terra) で次の bypass が実証された: 同一 push 内で commit A が secret を追加し
 * commit B がそれを削除すると、working tree はクリーンなまま push できてしまう
 * (旧来hook は diff 追加行を commit 単位で見ていたため block していた)。
 * これを塞ぐため、push される「各 commit」の「その時点の blob」を個別に読む方式へ変更した。
 *
 * 初回導入は warn-only。`UT_TDD_PRE_PUSH_SECRET_SCAN_MODE=fail-close` で
 * fail-close へ昇格できる (PLAN-L7-260 §4 DoD)。
 */
import { spawnSync } from "node:child_process";
import { analyzeSecretScan, secretScanMessages, type SecretScanArtifact } from "../../src/lint/secret-scan.ts";

/** pre-push が検査する変更ファイルの対象 prefix (PO 採択案 A、3 パターン限定を撤廃)。 */
export const WIDENED_SCAN_PREFIXES = [
  "docs/",
  ".ut-tdd/audit/",
  ".ut-tdd/logs/",
  ".ut-tdd/memory/",
] as const;

export function isWidenedScanSurface(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return WIDENED_SCAN_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// `src/lint/secret-scan.ts` の `loadSecretScanArtifactsForPaths` と同じ対象拡張子。
// git blob 読取り用に本ファイルで独立に持つ (disk 読取り前提の関数はここでは使わないため)。
const SCANNABLE_EXTENSION_PATTERN = /\.(md|json|ya?ml|ts|tsx|js|mjs|cjs|sh|ps1|toml|txt)$/;

export interface PushedFileEntry {
  readonly sha: string;
  readonly path: string;
}

/** `scripts/git-hooks/pre-push` が stdin へ渡す "<sha>\t<path>" 行を解析する。 */
export function parsePushedFileEntries(input: string): PushedFileEntry[] {
  const entries: PushedFileEntry[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex < 0) continue;
    const sha = line.slice(0, tabIndex).trim();
    const path = line.slice(tabIndex + 1).trim();
    if (!sha || !path) continue;
    entries.push({ sha, path });
  }
  return entries;
}

export type BlobReader = (repoRoot: string, sha: string, path: string) => string | null;

/** `git show <sha>:<path>` で commit 時点の blob を読む。読込不能 (対象外 commit / binary 等) は null。 */
export function defaultBlobReader(repoRoot: string, sha: string, path: string): string | null {
  const result = spawnSync("git", ["show", `${sha}:${path}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  // NUL バイトを含む blob は binary とみなし scan 対象から外す (scanner はテキスト前提)。
  if (result.stdout.includes("\u0000")) return null;
  return result.stdout;
}

/**
 * push される commit 群のうち widened surface に該当する (sha, path) を、各 commit 時点の
 * blob 内容で artifact 化する。同一 (sha, path) の重複は除く。commit を区別できるよう
 * artifact.path に `@<short sha>` を付与する (violation 表示で「どの commit か」を追える)。
 */
export function loadHistoricalArtifacts(
  repoRoot: string,
  entries: readonly PushedFileEntry[],
  readBlob: BlobReader = defaultBlobReader,
): SecretScanArtifact[] {
  const artifacts: SecretScanArtifact[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isWidenedScanSurface(entry.path)) continue;
    if (!SCANNABLE_EXTENSION_PATTERN.test(entry.path)) continue;
    const key = `${entry.sha}:${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = readBlob(repoRoot, entry.sha, entry.path);
    if (text === null) continue;
    artifacts.push({ path: `${entry.path}@${entry.sha.slice(0, 7)}`, text });
  }
  return artifacts;
}

export interface PiiScanViolation {
  path: string;
  line: number;
  marker: string;
}

export interface PiiScanResult {
  checked: number;
  violations: PiiScanViolation[];
  ok: boolean;
}

// 現行 `.git/hooks/pre-push` の SCAN_REGEX を後退させず温存する
// (電話番号 / 郵便番号 / internal URL / email)。「置換」でなく「対象拡大 + 温存」。
// legacy は POSIX ERE の非アンカー match (grep -Eao) で、行内のどこにあっても部分一致で
// 検出していた。JS 側で `\b` 境界を足すと legacy より弱くなる (blind review 指摘) ため、
// ここでは legacy と同じ非アンカーの部分一致にする。dummy/placeholder 例外も legacy には
// 無かったため、PII scan では適用しない (credential scan 側の ALLOW_LINE_MARKERS とは
// 意図的に別扱い。同一行 marker での例外は今回 PII には拡張しない、既存 legacy 感度を
// そのまま引き継ぐ判断)。
const PII_SCAN_PATTERNS: { marker: string; pattern: RegExp }[] = [
  { marker: "phone-number", pattern: /\d{3}-\d{4}-\d{4}/ },
  { marker: "postal-code", pattern: /(郵便番号|〒)[^0-9]{0,8}\d{3}-?\d{4}/ },
  {
    marker: "internal-url",
    pattern: /(?:[A-Za-z0-9-]+\.)+internal|(?:[A-Za-z0-9-]+\.)+corp\.[A-Za-z0-9.-]+/,
  },
  { marker: "email-address", pattern: /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

function firstPiiMatchLine(text: string, pattern: RegExp): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return null;
}

export function analyzePiiScan(artifacts: readonly SecretScanArtifact[]): PiiScanResult {
  const violations: PiiScanViolation[] = [];
  for (const artifact of artifacts) {
    for (const { marker, pattern } of PII_SCAN_PATTERNS) {
      const line = firstPiiMatchLine(artifact.text, pattern);
      if (line !== null) violations.push({ path: artifact.path, line, marker });
    }
  }
  return { checked: artifacts.length, violations, ok: violations.length === 0 };
}

export function piiScanMessages(result: PiiScanResult): string[] {
  if (result.ok) return [`pii-scan — OK (artifacts ${result.checked}件 PII marker 0)`];
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.marker}`)
    .join(", ");
  return [
    `pii-scan — PII marker ${result.violations.length}件 (${sample})。個人情報 (電話番号/郵便番号/email/internal URL) を push 対象へ含めない`,
  ];
}

export type ScanMode = "warn" | "fail-close";

/** `UT_TDD_PRE_PUSH_SECRET_SCAN_MODE=fail-close` のみ fail-close、それ以外は既定の warn-only。 */
export function resolveScanMode(env: NodeJS.ProcessEnv = process.env): ScanMode {
  return env.UT_TDD_PRE_PUSH_SECRET_SCAN_MODE === "fail-close" ? "fail-close" : "warn";
}

export interface SecretScanDiffOutcome {
  ok: boolean;
  mode: ScanMode;
  messages: string[];
  exitCode: number;
}

/**
 * pre-push が渡す「push される commit 群の diff スコープ」(sha, path のペア) を受け取り、
 * 各 commit 時点の blob を widened surface へ filter した上で credential + PII を検査する。
 * working tree (disk) には一切依存しない — これにより「途中 commit で追加 → 後続 commit で
 * 削除」を working tree 上のクリーン化で素通りさせない (blind review 指摘の bypass 対策)。
 */
export function runSecretScanDiff(
  repoRoot: string,
  entries: readonly PushedFileEntry[],
  mode: ScanMode = "warn",
  readBlob: BlobReader = defaultBlobReader,
): SecretScanDiffOutcome {
  const artifacts = loadHistoricalArtifacts(repoRoot, entries, readBlob);
  const secretResult = analyzeSecretScan(artifacts);
  const piiResult = analyzePiiScan(artifacts);
  const ok = secretResult.ok && piiResult.ok;

  const messages: string[] = [...secretScanMessages(secretResult), ...piiScanMessages(piiResult)];

  if (ok) {
    messages.push("[ut-tdd pre-push] OK: widened scan surface に violation なし (push される全 commit の blob を検査)。");
    return { ok: true, mode, messages, exitCode: 0 };
  }

  if (mode === "fail-close") {
    messages.push(
      "[ut-tdd pre-push] fail-close: UT_TDD_PRE_PUSH_SECRET_SCAN_MODE=fail-close により push を止めた。 " +
        "'git push --no-verify' は明示承認後のみ使う。",
    );
    return { ok: false, mode, messages, exitCode: 1 };
  }

  messages.push(
    "[ut-tdd pre-push] warn-only: violation を検出したが push は継続する " +
      "(fail-close へ昇格するには UT_TDD_PRE_PUSH_SECRET_SCAN_MODE=fail-close を設定する)。",
  );
  return { ok: false, mode, messages, exitCode: 0 };
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const input = await readStdinText();
  const entries = parsePushedFileEntries(input);
  const repoRoot = process.cwd();
  const mode = resolveScanMode(process.env);
  const outcome = runSecretScanDiff(repoRoot, entries, mode);
  for (const message of outcome.messages) {
    process.stdout.write(`${message}\n`);
  }
  process.exit(outcome.exitCode);
}

// Node で直接実行された場合のみ CLI として動く。vitest からの import では発火しない。
if (import.meta.main) {
  await main();
}
