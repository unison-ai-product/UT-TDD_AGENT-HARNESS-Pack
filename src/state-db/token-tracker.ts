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
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
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
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
/** cache 読み出しは入力単価の ~0.1×、cache 書き込み (5分 TTL) は ~1.25× (claude-api 正本)。 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * OpenAI (Codex runtime) モデル単価 ($/1M tokens)。正本 = OpenAI 公式 API pricing
 * (https://developers.openai.com/api/docs/pricing、standard tier、2026-06-15 取得)。`cached` は公式
 * "cached input" 割引単価で、caching 非対応モデル (pro) は null → computeCodexCostUsd が input 単価で課金する。
 * 根拠: ハードコードだが公式 published 単価であり、model→price の散在を避けここへ集約 (CLAUDE_PRICING と対称)。
 * **未掲載モデルは表に入れない = cost null** (捏造禁止の不変条件)。例: gpt-5.4-codex は公式 pricing に未掲載の
 * ため意図的に不在にし null を維持する。将来の改定はこの表を差し替える (単一正本)。
 */
export const OPENAI_PRICING: Record<
  string,
  { input: number; cached: number | null; output: number }
> = {
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
