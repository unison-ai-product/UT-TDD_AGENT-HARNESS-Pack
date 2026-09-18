/**
 * token-tracker — cross-runtime token telemetry の取得層 (FR-L1-38、PLAN-L7-57)。
 *
 * 設計 (PO 指摘 2026-06-15): harness は multi-runtime (claude-only / codex-only / hybrid)。FR-38 の
 * cost 評価は **両 runtime で機能しないと片肺**になる。さらに Codex CLI は Windows で 8009001d (sandbox
 * 起動失敗) のため委譲不可 — これが ADR-001 (TS-native 再実装) の動機そのもの。よって tracker は
 * **`codex exec` / `claude` を再実行してはいけない** (壊れた CLI への依存が復活する)。代わりに **両 runtime が
 * 既にディスクへ書き出した session JSONL ログを読むだけ**にする (OS 非依存、CLI 起動なし。ccusage と同方式)。
 *
 * core metric = **token 効率** (両 runtime とも token は確実に出す = provider 非依存)。$ コストは enrichment:
 *   - Claude: usage + CLAUDE_PRICING でローカル計算 (単価は claude-api 正本、単一正本化)。
 *   - Codex: usage + OPENAI_PRICING (公式 API pricing、2026-06-15 取得) でローカル計算。**公式 pricing に
 *     掲載のあるモデルのみ** cost を出し、未掲載 (例 gpt-5.4-codex) は null を維持する (捏造しない)。token 効率は常に成立。
 *
 * 純関数 (parse / cost) と I/O loader (loadRuntimeSessionUsage) を分離。ingest/projection は
 * projection-writer.ts 側 (projectTokenUsage) が本モジュールの純関数を消費する。
 *
 * repo スコープ ingest (issue #82、PLAN-L7-454): `loadRuntimeSessionUsage` は全 project 全量走査
 * (`ut-tdd telemetry scan` の明示実行専用、温存)。一方 `rebuildHarnessDb` の正規経路には **この repo に
 * 帰属する session usage のみ**を投入したい (他 repo の usage 混入は帰属外、かつ全量は rebuild を遅くする)。
 * そのため `loadRepoScopedRuntimeSessionUsage` を別途用意し、判定は純関数 (`claudeProjectSlug` /
 * `codexSessionBelongsToRepo`) + I/O (`resolveClaudeProjectDir` / `readCodexSessionCwd`) に分離する。
 *
 * blind review 是正 (2026-07-21、PLAN-L7-454): `claudeProjectSlug` はパス区切り文字を一律 `-` に潰すため
 * 非単射 (例: `C:\a-b\c` と `C:\a\b-c` が同一 slug に衝突しうる) で、slug 一致だけでは他 repo の session が
 * 同一 project-slug ディレクトリへ混入しうる (Finding 1)。是正として Claude 側も Codex と対称に **各
 * session ファイルの実 cwd で per-file 帰属検証**を追加した (`parseClaudeSessionCwd` /
 * `readClaudeSessionCwd`)。また `normalizePathForCompare` が無条件 lowercase しており POSIX の
 * case-sensitive path (`/work/Repo` ≠ `/work/repo`) を誤同一視していた (Finding 2)。case-fold は
 * win32 のみに限定し、`codexSessionBelongsToRepo` へ `options.platform` 注入を追加した。
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type RuntimeKind = "claude" | "codex";

/** 1 run (= 1 model turn) の正規化 usage。cost は出せる runtime のみ非 null。 */
export interface RunUsage {
  runtime: RuntimeKind;
  model: string;
  sessionId: string;
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  /** Claude=cache_read、Codex=cached_input。欠ける場合 0。 */
  cachedInputTokens: number;
  /** Codex reasoning_output_tokens。Claude には無く 0。 */
  reasoningTokens: number;
  /** $ enrichment。pricing 表に未掲載のモデルは null (捏造しない)。 */
  costUsd: number | null;
}

/**
 * Claude モデル単価 ($/1M tokens)。正本 = claude-api skill (2026-05-26 cached)。単一正本化。
 * 根拠: ハードコードだが「公式に published された単価」であり、model→price の散在を避けここへ集約。
 * 将来の改定は client.models.retrieve(id) のライブ単価へ差し替え可能 (本表は offline/CI 用 fallback)。
 */
export const CLAUDE_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
/** cache 読み出しは入力単価の ~0.1×、cache 書き込み (5分 TTL) は ~1.25× (claude-api 正本)。 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * OpenAI (Codex runtime) モデル単価 ($/1M tokens)。正本 = OpenAI 公式 API pricing
 * (https://developers.openai.com/api/docs/pricing、standard tier、2026-07-10 確認)。`cached` は公式
 * "cached input" 割引単価で、caching 非対応モデル (pro) は null → computeCodexCostUsd が input 単価で課金する。
 * 根拠: ハードコードだが公式 published 単価であり、model→price の散在を避けここへ集約 (CLAUDE_PRICING と対称)。
 * **未掲載モデルは表に入れない = cost null** (捏造禁止の不変条件)。例: gpt-5.4-codex は公式 pricing に未掲載の
 * ため意図的に不在にし null を維持する。将来の改定はこの表を差し替える (単一正本)。
 */
export const OPENAI_PRICING: Record<
  string,
  { input: number; cached: number | null; output: number }
> = {
  "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.6-luna": { input: 1, cached: 0.1, output: 6 },
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.5-pro": { input: 30, cached: null, output: 180 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30, cached: null, output: 180 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14 },
};

/**
 * model id を pricing table のキーへ正規化する**安全な** matcher (CLAUDE_PRICING / OPENAI_PRICING 共用)。
 * - 完全一致を最優先。
 * - 接尾辞は **日付 / version / `[1m]` 等の継続のみ**許容し、新しい variant 語 (`-codex` / `-mini` / `-pro`
 *   等) を跨いでマッチしない。これは `gpt-5.4-codex` が `gpt-5.4` 単価へ誤マッチして $ を捏造するのを防ぐため
 *   (= 残差が空、区切り直後が数字 `-2026…`/`.1`、または `[` で始まる場合のみ prefix-match 成立)。
 * - 複数候補は最長一致を採る (Object.keys 反復順に依存しない)。
 */
function pricingKeyFor(model: string, table: Record<string, unknown>): string | null {
  const m = model.toLowerCase().trim();
  if (Object.hasOwn(table, m)) return m;
  const matches = Object.keys(table).filter((key) => {
    if (!m.startsWith(key)) return false;
    const rest = m.slice(key.length);
    return rest === "" || /^[-_.]?\d/.test(rest) || rest.startsWith("[");
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

/**
 * Claude の 1 turn コスト ($) を usage から計算する。未知モデルは null。
 * cost = (input + cacheRead×0.1 + cacheWrite×1.25)×入力単価 + output×出力単価、すべて /1e6。
 */
export function computeClaudeCostUsd(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number | null {
  const key = pricingKeyFor(args.model, CLAUDE_PRICING);
  if (!key) return null;
  const p = CLAUDE_PRICING[key];
  const inputCost =
    (args.inputTokens +
      args.cacheReadTokens * CACHE_READ_MULTIPLIER +
      args.cacheWriteTokens * CACHE_WRITE_MULTIPLIER) *
    p.input;
  const outputCost = args.outputTokens * p.output;
  return Number(((inputCost + outputCost) / 1_000_000).toFixed(6));
}

/**
 * Codex (OpenAI) の 1 turn コスト ($) を usage から計算する。公式 pricing 未掲載モデルは null (捏造しない)。
 * OpenAI 課金: cached_input は割引 (cached) 単価、残りの input は通常単価、output (reasoning を内包) は
 * output 単価。cost = ((input - cached)×input単価 + cached×cached単価 + output×output単価) / 1e6。
 * caching 非対応 (cached=null) のモデルでは cached トークンも input 単価で課金する。
 */
export function computeCodexCostUsd(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): number | null {
  const key = pricingKeyFor(args.model, OPENAI_PRICING);
  if (!key) return null;
  const p = OPENAI_PRICING[key];
  const uncachedInput = Math.max(0, args.inputTokens - args.cachedInputTokens);
  const cachedRate = p.cached ?? p.input;
  const inputCost = uncachedInput * p.input + args.cachedInputTokens * cachedRate;
  const outputCost = args.outputTokens * p.output;
  return Number(((inputCost + outputCost) / 1_000_000).toFixed(6));
}

function safeParse(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Claude Code transcript JSONL を per-turn RunUsage に変換する (純関数)。
 * assistant 行: { type:"assistant", message:{ model, usage:{ input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens } }, sessionId }。usage は per-message なので
 * 累積差分は不要 (Codex と異なる)。cost は CLAUDE_PRICING で計算 (未知モデル null)。
 */
export function parseClaudeSessionUsage(content: string, sessionId = ""): RunUsage[] {
  const out: RunUsage[] = [];
  let turn = 0;
  for (const line of content.split("\n")) {
    const obj = safeParse(line);
    if (!obj || obj.type !== "assistant") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const model = typeof message?.model === "string" ? (message.model as string) : "";
    const inputTokens = num(usage.input_tokens);
    const outputTokens = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    out.push({
      runtime: "claude",
      model,
      sessionId: (obj.sessionId as string) || sessionId,
      turnIndex: turn++,
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheRead,
      reasoningTokens: 0,
      costUsd: computeClaudeCostUsd({
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      }),
    });
  }
  return out;
}

interface CodexCumulative {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function readCodexCumulative(info: Record<string, unknown>): CodexCumulative | null {
  // Codex rollout の token_count.info は通常 `total_token_usage` ネストだが、版により info 直下に
  // フラットな input_tokens 等を持つ形も観測されうるため両対応 (review M-3、防御的フォールバック)。
  const total = (info.total_token_usage ?? info) as Record<string, unknown>;
  if (total == null || typeof total !== "object") return null;
  return {
    inputTokens: num(total.input_tokens),
    cachedInputTokens: num(total.cached_input_tokens),
    outputTokens: num(total.output_tokens),
    reasoningTokens: num(total.reasoning_output_tokens),
  };
}

/**
 * Codex rollout JSONL を per-turn RunUsage に変換する (純関数)。
 * token_count イベントは **session 累積** totals を報告するため、連続する token_count の **差分**で
 * per-turn を復元する (上流 issue openai/codex#17539 で per-call `last` が追加予定だが、それまでは差分)。
 * 想定行: { type:"event_msg", payload:{ type:"token_count", info:{ total_token_usage:{ input_tokens,
 * cached_input_tokens, output_tokens, reasoning_output_tokens } } } }。model は session_meta 行から。
 * cost は OPENAI_PRICING (公式 API pricing) で計算。公式 pricing 未掲載モデルは null (token 効率は成立、捏造しない)。
 */
export function parseCodexSessionUsage(content: string, sessionId = ""): RunUsage[] {
  const out: RunUsage[] = [];
  let model = "";
  let prev: CodexCumulative = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  let turn = 0;
  for (const line of content.split("\n")) {
    const obj = safeParse(line);
    if (!obj) continue;
    const payload = obj.payload as Record<string, unknown> | undefined;
    // model は session_meta / turn_context などの payload.model から拾う (最後に見た値を採用)。
    if (payload && typeof payload.model === "string" && payload.model) {
      model = payload.model as string;
    }
    if (!payload || payload.type !== "token_count") continue;
    const info = payload.info as Record<string, unknown> | undefined;
    if (!info) continue;
    const cum = readCodexCumulative(info);
    if (!cum) continue;
    // 累積 → 差分 (負にならないよう 0 でクランプ)。
    const delta = {
      inputTokens: Math.max(0, cum.inputTokens - prev.inputTokens),
      cachedInputTokens: Math.max(0, cum.cachedInputTokens - prev.cachedInputTokens),
      outputTokens: Math.max(0, cum.outputTokens - prev.outputTokens),
      reasoningTokens: Math.max(0, cum.reasoningTokens - prev.reasoningTokens),
    };
    prev = cum;
    if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.reasoningTokens === 0) {
      continue; // 変化なし (no-op event) は記録しない
    }
    out.push({
      runtime: "codex",
      model,
      sessionId,
      turnIndex: turn++,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cachedInputTokens: delta.cachedInputTokens,
      reasoningTokens: delta.reasoningTokens,
      costUsd: computeCodexCostUsd({
        model,
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        cachedInputTokens: delta.cachedInputTokens,
      }),
    });
  }
  return out;
}

function listJsonl(dir: string): string[] {
  const acc: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return; // 不在ディレクトリは黙ってスキップ (cold-start 安全)
    }
    for (const e of entries) {
      const full = join(d, e);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else if (e.endsWith(".jsonl")) acc.push(full);
    }
  };
  walk(dir);
  return acc;
}

export interface SessionScanDirs {
  /** Claude Code transcript ディレクトリ群 (例: ~/.claude/projects)。 */
  claudeDirs?: string[];
  /** Codex rollout session ディレクトリ群 (例: ~/.codex/sessions)。 */
  codexDirs?: string[];
}

/**
 * 両 runtime の session JSONL を走査して RunUsage[] を返す (I/O loader)。CLI は一切起動しない
 * (ディスク上の既存ログを読むだけ = 8009001d 無関係・OS 非依存)。不在ディレクトリは空 (cold-start 安全)。
 */
export function loadRuntimeSessionUsage(dirs: SessionScanDirs): RunUsage[] {
  const out: RunUsage[] = [];
  for (const dir of dirs.claudeDirs ?? []) {
    for (const file of listJsonl(dir)) {
      try {
        out.push(...parseClaudeSessionUsage(readFileSync(file, "utf8"), file));
      } catch {
        // 読めない 1 ファイルで全体を落とさない
      }
    }
  }
  for (const dir of dirs.codexDirs ?? []) {
    for (const file of listJsonl(dir)) {
      try {
        out.push(...parseCodexSessionUsage(readFileSync(file, "utf8"), file));
      } catch {
        // 同上
      }
    }
  }
  return out;
}

/**
 * repoRoot から Claude Code project-slug ディレクトリ名を導出する (純関数)。
 * Claude Code は `~/.claude/projects/` 配下に、絶対パスの区切り文字 (`\` `/`) とドライブ区切り `:` を
 * すべて `-` へ置換したディレクトリ名でセッションを保存する (実ディレクトリで確認済、例:
 * `<drive>:\workspace\repo` → `<drive>--workspace-repo`)。
 * 元パス中のハイフンはそのまま残る (二重 `--` は `:` `\` の連続置換由来であり衝突ではない)。
 */
export function claudeProjectSlug(repoRoot: string): string {
  return repoRoot.replace(/[\\/:]/g, "-");
}

/**
 * `claudeProjectsRoot` 直下から repoRoot に対応する project-slug ディレクトリを解決する (I/O)。
 * ドライブ文字の大文字小文字が Claude Code の起動経路 (bash 由来 `c--...` / GUI 由来 `C--...`) で
 * 揺れうるため、実在ディレクトリ一覧との比較は **大文字小文字を無視**する。不在ディレクトリ / 未一致は
 * null (cold-start 安全、fail-open)。
 */
export function resolveClaudeProjectDir(
  claudeProjectsRoot: string,
  repoRoot: string,
): string | null {
  const slug = claudeProjectSlug(repoRoot).toLowerCase();
  let entries: string[];
  try {
    entries = readdirSync(claudeProjectsRoot);
  } catch {
    return null;
  }
  const match = entries.find((entry) => entry.toLowerCase() === slug);
  return match ? join(claudeProjectsRoot, match) : null;
}

/**
 * パス比較の platform 注入用オプション (blind review Finding 2、PLAN-L7-454)。
 * 省略時は `process.platform`。テスト決定性のため明示注入できる。
 */
export interface PathCompareOptions {
  platform?: NodeJS.Platform;
}

/**
 * 比較用にパス区切りを `/` へ統一する。大文字小文字の畳み込みは **win32 のみ**
 * (blind review Finding 2、PLAN-L7-454): POSIX (linux/darwin) は case-sensitive
 * ファイルシステムのため `/work/Repo` と `/work/repo` を同一視してはならない。
 * 無条件 lowercase は Windows 前提の誤同一視バグだった。
 */
function normalizePathForCompare(p: string, options: PathCompareOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * Codex rollout の先頭 `session_meta` 行 (文字列) から `payload.cwd` を抽出する (純関数)。
 * 先頭行が `session_meta` でない、または `cwd` が無い/文字列でない形式は null (不採用 skip の判定材料)。
 */
export function parseCodexSessionMetaCwd(firstLine: string): string | null {
  const obj = safeParse(firstLine);
  if (!obj || obj.type !== "session_meta") return null;
  const payload = obj.payload as Record<string, unknown> | undefined;
  const cwd = payload?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

/**
 * session (Claude/Codex 共通) の `cwd` が repoRoot 配下かどうかを判定する (純関数、Codex 専用ではなく
 * 両 runtime の per-file 帰属検証で共用する)。cwd 不明 (null) は不採用。パス区切り (`\`/`/`) の揺れを
 * 常に吸収し、大文字小文字の畳み込みは win32 のときのみ行う (`options.platform` 省略時は
 * `process.platform`、POSIX では case-sensitive 比較、Finding 2 是正)。
 */
export function codexSessionBelongsToRepo(
  cwd: string | null,
  repoRoot: string,
  options: PathCompareOptions = {},
): boolean {
  if (!cwd) return false;
  const c = normalizePathForCompare(cwd, options);
  const r = normalizePathForCompare(repoRoot, options);
  return c === r || c.startsWith(`${r}/`);
}

/** 先頭 meta 行だけを読むための上限バイト数。観測値 (~7KB) に十分な余裕を持たせた固定サイズ。 */
const CODEX_META_LINE_MAX_BYTES = 65536;

/**
 * Codex rollout JSONL の **先頭行のみ**を読む (I/O)。全量 (`readFileSync`) と違い大半のファイルは
 * 走査対象外 (他 repo 帰属) になるため、cwd 判定のためだけに全ファイルを読むのは無駄が大きい
 * (観測: 先頭行 ~7KB vs ファイル全体 ~850KB)。上限内に改行が無ければ読めた分をそのまま返す
 * (JSON.parse が失敗すれば呼び出し側で null 扱いになる)。
 */
function readFirstLine(file: string, maxBytes = CODEX_META_LINE_MAX_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    const chunk = buf.toString("utf8", 0, bytesRead);
    const nl = chunk.indexOf("\n");
    return nl >= 0 ? chunk.slice(0, nl) : chunk;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // close 失敗は無視 (fd リークより読み取り結果を優先、プロセスは短命)
    }
  }
}

/** Codex rollout ファイルの `cwd` を先頭行のみ読んで判定する (I/O)。読取失敗は null (fail-open)。 */
function readCodexSessionCwd(file: string): string | null {
  const firstLine = readFirstLine(file);
  if (firstLine === null) return null;
  return parseCodexSessionMetaCwd(firstLine);
}

/** 先頭付近の Claude session `cwd` 検出のために読む上限バイト数/行数 (Codex の先頭行のみ読み取りと対称)。 */
const CLAUDE_META_SCAN_MAX_BYTES = 262144;
const CLAUDE_META_SCAN_MAX_LINES = 20;

/**
 * ファイル先頭の複数行 (改行区切り) を上限バイト数まで読む (I/O)。上限バイトぴったりで打ち切った場合、
 * 末尾行は途中切断されている可能性があるため破棄する。読取失敗は空配列 (fail-open)。
 */
function readLeadingLines(file: string, maxBytes: number): string[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    const chunk = buf.toString("utf8", 0, bytesRead);
    const lines = chunk.split("\n");
    if (bytesRead === maxBytes) lines.pop(); // 末尾行が切断されている可能性 → 破棄
    return lines;
  } catch {
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      // close 失敗は無視 (readCodexSessionCwd と同方針)
    }
  }
}

/**
 * Claude Code transcript の各行に載る `cwd` フィールドから帰属 repo を判定する (純関数、Codex の
 * `parseCodexSessionMetaCwd` と対称)。先頭付近の複数行を渡し、最初に見つかった文字列 `cwd` を採用する
 * (行 1-2 は `queue-operation` 等 `cwd` を持たない場合が実観測されており、先頭行のみでは不十分)。
 * 見つからなければ null (不採用 skip の判定材料)。
 */
export function parseClaudeSessionCwd(lines: string[]): string | null {
  for (const line of lines) {
    const obj = safeParse(line);
    if (!obj) continue;
    const cwd = obj.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return null;
}

/** Claude transcript ファイルの `cwd` を先頭付近の数行のみ読んで判定する (I/O)。読取失敗は null (fail-open)。 */
function readClaudeSessionCwd(file: string): string | null {
  const lines = readLeadingLines(file, CLAUDE_META_SCAN_MAX_BYTES).slice(
    0,
    CLAUDE_META_SCAN_MAX_LINES,
  );
  return parseClaudeSessionCwd(lines);
}

/** repo スコープ ingest の走査統計 (issue #82、PLAN-L7-454: 件数の可視化)。 */
export interface RepoScopeIngestStats {
  /** repoRoot に対応する Claude project-slug ディレクトリが見つかったか。 */
  claudeProjectDirResolved: boolean;
  /** cwd 判定のため先頭付近の行を確認した Claude transcript ファイル数 (走査候補の総数)。 */
  claudeFilesChecked: number;
  /** cwd が repoRoot 配下と判定され走査した Claude transcript ファイル数。 */
  claudeFilesScanned: number;
  /**
   * cwd は読めたが repoRoot 配下ではない (他 repo 帰属) ため不採用の Claude transcript ファイル数
   * (blind review Finding 1、PLAN-L7-454: `claudeProjectSlug` の非単射性による他 repo 混入を per-file
   * cwd 検証で遮断した件数)。
   */
  claudeFilesForeignRepo: number;
  /** 先頭付近の行に cwd が無い/読めない形式のため不採用の Claude transcript ファイル数 (可視化対象)。 */
  claudeFilesSkippedUnknownCwd: number;
  /** cwd 判定のため先頭行を確認した Codex rollout ファイル数 (走査候補の総数)。 */
  codexFilesChecked: number;
  /** cwd が repoRoot 配下と判定され走査した Codex rollout ファイル数。 */
  codexFilesMatched: number;
  /** cwd は読めたが repoRoot 配下ではない (他 repo 帰属) ため不採用の Codex rollout ファイル数。 */
  codexFilesForeignRepo: number;
  /** 先頭 meta 行に cwd が無い/読めない形式のため不採用の Codex rollout ファイル数 (可視化対象)。 */
  codexFilesSkippedUnknownCwd: number;
}

export interface RepoScopedSessionUsageResult {
  usages: RunUsage[];
  stats: RepoScopeIngestStats;
}

/**
 * repoRoot に帰属する session usage のみを走査して RunUsage[] を返す (I/O loader、issue #82)。
 * - Claude: `claudeDirs` 直下から repoRoot の project-slug ディレクトリを解決した上で、**その配下の
 *   各ファイルについても先頭付近の行から `cwd` を読み per-file 帰属検証を行う** (blind review Finding 1、
 *   PLAN-L7-454)。`claudeProjectSlug` はパス区切り文字を一律 `-` に潰すため非単射
 *   (例: `C:\a-b\c` と `C:\a\b-c` が同一 slug に衝突しうる) で、slug 一致だけでは他 repo の session が
 *   同一ディレクトリへ混入する余地がある。cwd 不一致 (`claudeFilesForeignRepo`) と cwd 不明形式
 *   (`claudeFilesSkippedUnknownCwd`) を分けて件数を可視化する (Codex と対称)。
 * - Codex: `codexDirs` 配下の全 rollout ファイルの **先頭行のみ**読み、`cwd` が repoRoot 配下のものだけ
 *   全文を読んで走査する。他 repo 帰属 (`codexFilesForeignRepo`) と cwd 不明形式
 *   (`codexFilesSkippedUnknownCwd`) を分けて件数を可視化する。
 * 個別ファイルの読取失敗は fail-open (該当ファイルを飛ばして継続、全体を落とさない)。
 */
export function loadRepoScopedRuntimeSessionUsage(
  repoRoot: string,
  dirs: SessionScanDirs,
): RepoScopedSessionUsageResult {
  const usages: RunUsage[] = [];
  const stats: RepoScopeIngestStats = {
    claudeProjectDirResolved: false,
    claudeFilesChecked: 0,
    claudeFilesScanned: 0,
    claudeFilesForeignRepo: 0,
    claudeFilesSkippedUnknownCwd: 0,
    codexFilesChecked: 0,
    codexFilesMatched: 0,
    codexFilesForeignRepo: 0,
    codexFilesSkippedUnknownCwd: 0,
  };
  for (const claudeRoot of dirs.claudeDirs ?? []) {
    const projectDir = resolveClaudeProjectDir(claudeRoot, repoRoot);
    if (!projectDir) continue;
    stats.claudeProjectDirResolved = true;
    for (const file of listJsonl(projectDir)) {
      stats.claudeFilesChecked++;
      const cwd = readClaudeSessionCwd(file);
      if (!codexSessionBelongsToRepo(cwd, repoRoot)) {
        if (cwd === null) stats.claudeFilesSkippedUnknownCwd++;
        else stats.claudeFilesForeignRepo++;
        continue;
      }
      stats.claudeFilesScanned++;
      try {
        usages.push(...parseClaudeSessionUsage(readFileSync(file, "utf8"), file));
      } catch {
        // 1 ファイル失敗で全体を落とさない
      }
    }
  }
  for (const codexRoot of dirs.codexDirs ?? []) {
    for (const file of listJsonl(codexRoot)) {
      stats.codexFilesChecked++;
      const cwd = readCodexSessionCwd(file);
      if (!codexSessionBelongsToRepo(cwd, repoRoot)) {
        if (cwd === null) stats.codexFilesSkippedUnknownCwd++;
        else stats.codexFilesForeignRepo++;
        continue;
      }
      stats.codexFilesMatched++;
      try {
        usages.push(...parseCodexSessionUsage(readFileSync(file, "utf8"), file));
      } catch {
        // 同上
      }
    }
  }
  return { usages, stats };
}

/** scan サマリ (CLI `ut-tdd telemetry scan` の表示用)。$ は cost を出せた run の合計のみ。 */
export interface UsageSummary {
  totalRuns: number;
  claudeRuns: number;
  codexRuns: number;
  inputTokens: number;
  outputTokens: number;
  /** cost を計算できた run の合計 ($)。未掲載モデル (cost=null) は加算しない。 */
  knownCostUsd: number;
  /** cost=null だった run 数 (公式単価未掲載モデル)。 */
  runsWithoutCost: number;
}

/** RunUsage[] を runtime 別に集計する純関数 (CLI scan の出力に使う)。 */
export function summarizeRunUsage(usages: RunUsage[]): UsageSummary {
  const s: UsageSummary = {
    totalRuns: 0,
    claudeRuns: 0,
    codexRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    knownCostUsd: 0,
    runsWithoutCost: 0,
  };
  for (const u of usages) {
    s.totalRuns++;
    if (u.runtime === "claude") s.claudeRuns++;
    else s.codexRuns++;
    s.inputTokens += u.inputTokens;
    s.outputTokens += u.outputTokens;
    if (u.costUsd === null) s.runsWithoutCost++;
    else s.knownCostUsd += u.costUsd;
  }
  s.knownCostUsd = Number(s.knownCostUsd.toFixed(6));
  return s;
}
