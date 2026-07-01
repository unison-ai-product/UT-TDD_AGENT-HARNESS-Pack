/**
 * session-log — セッションログ + PLAN 単位ダイジェスト圧縮 (fail-OPEN)。
 *
 * 設計 (①): docs/design/harness/L6-function-design/session-log.md (PLAN-L6-03 add-design)。
 * テスト設計 (③): docs/test-design/harness/L7-unit-test-design.md §1.5 U-SLOG-001〜005。
 * PLAN: PLAN-L7-01-session-log (add-impl)。
 *
 * agent-guard と同じ hook shim + 純粋関数分離パターン。ただし **fail-OPEN** (常に 0、
 * never throws)。ログがワークフローを止めてはならない。判定本体は本ファイル、hook entry は
 * .claude/hooks/session-log.ts。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { classifyVerificationVerb } from "./verb-classify";

export type SessionEventType =
  | "session_start"
  | "tool_use"
  | "commit"
  | "plan_switch"
  | "session_end"
  | "forced_stop" // 強制停止 (推定、PLAN-L6-04/L7-02 forced-stop-feedback)
  | "user_prompt"; // ユーザー入力 (dangling-turn 推定の活動 marker)

export interface SessionEvent {
  ts: string; // ISO8601 (hook 受領時)
  session_id: string;
  plan_id: string | null;
  event_type: SessionEventType;
  tool?: string;
  target?: string; // path / 要約のみ (sanitize 済、値・引数は載せない)
  outcome?: "ok" | "error";
}

export interface PlanDigest {
  plan_id: string;
  sessions: string[];
  event_counts: Partial<Record<SessionEventType, number>>;
  files_touched: string[];
  commits: string[];
  failures: { ts: string; summary: string }[];
  updated_at: string;
  // PLAN-L7-80: per-session high-watermark = how many of that session's
  // matching events have already been folded into this digest. Lets a session
  // that is summarized more than once (e.g. multiple Stop hooks) count only its
  // incremental events instead of dropping them all. Optional for backward
  // compatibility with pre-L7-80 digests (migration seeds it from updated_at).
  session_watermarks?: Record<string, number>;
}

export interface SessionHookInput {
  hook_event_name?: string;
  session_id?: string;
  plan_id?: string | null;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

/** I/O・clock・branch を注入 (compressPlanDigest 以外も test 可能、now 注入で決定論)。 */
export interface SessionLogDeps {
  repoRoot: string;
  now: () => string;
  appendLine: (path: string, line: string) => void;
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
  currentBranch: () => string | null;
  /** dir 内の entry 名一覧 (feedback ログ走査用、PLAN-L7-02)。未提供/失敗時は []。 */
  listDir?: (dir: string) => string[];
  /** file 削除 (current-plan clear 用、PLAN-L7-04)。未提供時は空文字書込で代替。 */
  removeFile?: (path: string) => void;
  /** 直近 commit hash (`git rev-parse HEAD`)。IMP-078 gap③: commit 捕捉を hook で供給。未提供→hash 無し。 */
  headCommit?: () => string | null;
}

const BRANCH_PLAN_RE = /^(?:add|design|feature|reverse|hotfix|poc|refactor)\/(.+)$/;
// token/key/secret/password 様の `name=value` / `name: value` を値マスク
const SECRET_RE =
  /\b([A-Za-z0-9_-]*(?:token|key|secret|password|passwd|pwd|bearer)[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi;
const MAX_SUMMARY = 120;

/** 禁則 (token/key/secret 様) をマスクし 120 文字へ truncate。durable digest への漏洩防止。 */
export function sanitize(raw: string | undefined): string {
  if (!raw) return "";
  const masked = raw.replace(SECRET_RE, "$1***");
  return masked.length > MAX_SUMMARY ? `${masked.slice(0, MAX_SUMMARY - 1)}…` : masked;
}

/** ツール名 + 対象 path のみ。引数値・ファイル内容は載せない。 */
export function summarize(input: SessionHookInput): string {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const path = (ti.file_path ?? ti.path ?? ti.notebook_path) as string | undefined;
  // Bash は引数を残さず固定の検証 verb token だけを hint にする (PLAN-RECOVERY-05 item 2)。
  // attempt-escalation が「同じ検証コマンドの連続失敗」を grouping できるよう、command を
  // whitelist verb (vitest/tsc/doctor/lint/...) に分類して埋める。未分類/非 Bash は従来どおり。
  if (tool === "Bash" && !path) {
    const verb = classifyVerificationVerb(String(ti.command ?? ""));
    return sanitize(`${tool} (${verb ?? "bash"})`);
  }
  const hint = path ? String(path) : tool === "Bash" ? "(bash)" : "";
  return sanitize(`${tool} ${hint}`.trim());
}

function isPath(s: string): boolean {
  return s.includes("/") || s.includes("\\");
}

/** session_id / plan_id を file 名に使う前に path 分離子を除去 (traversal 防止)。 */
export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

function outcomeOf(input: SessionHookInput): "ok" | "error" | undefined {
  const r = input.tool_response as { outcome?: string } | undefined;
  if (r?.outcome === "error") return "error";
  if (r?.outcome === "ok") return "ok";
  return undefined;
}

function emptyDigest(planId: string): PlanDigest {
  return {
    plan_id: planId,
    sessions: [],
    event_counts: {},
    files_touched: [],
    commits: [],
    failures: [],
    updated_at: "",
    session_watermarks: {},
  };
}

/**
 * U-SLOG-001: state ファイル優先 → branch fallback → 解決不能は null。throw しない。
 * current-plan は 1 行目 = plan_id (IMP-078 gap②で 2 行目に updated_at を追記、後方互換で 1 行目のみ読む)。
 */
export function resolveActivePlan(deps: SessionLogDeps): string | null {
  const fromState = deps.readText(currentPlanPath(deps.repoRoot));
  const firstLine = fromState?.split("\n")[0]?.trim();
  if (firstLine) return firstLine;
  const branch = deps.currentBranch();
  const m = branch?.match(BRANCH_PLAN_RE);
  return m ? m[1] : null;
}

/** IMP-078 gap②: current-plan marker の 2 行目 (updated_at) を読む。無ければ null。 */
export function activePlanUpdatedAt(deps: SessionLogDeps): string | null {
  const raw = deps.readText(currentPlanPath(deps.repoRoot));
  const second = raw?.split("\n")[1]?.trim();
  return second || null;
}

/**
 * IMP-078 gap②: current-plan marker が maxHours を超えて未更新なら stale (古い PLAN を active 誤判定する元)。
 * updated_at 不在 (旧形式) は判定不能 = false (stale 扱いにしない、後方互換)。境界 (=maxHours) は stale でない。
 */
export function activePlanStale(deps: SessionLogDeps, now: string, maxHours = 24): boolean {
  const u = activePlanUpdatedAt(deps);
  if (!u) return false;
  const uMs = Date.parse(u);
  const nMs = Date.parse(now);
  if (Number.isNaN(uMs) || Number.isNaN(nMs)) return false;
  return (nMs - uMs) / 3_600_000 > maxHours;
}

function currentPlanPath(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "state", "current-plan");
}

// PLAN-L6-06 §2.3: ID 単体形 (slug 任意)。commit message 抽出 / handover scope 解決で再利用。
const PLAN_ID_RE = /PLAN-(?:L(?:[0-9]|1[0-4])|DISCOVERY|REVERSE|RECOVERY|M)-\d{2}(?:-[a-z0-9-]+)?/;

/**
 * U-HOVER-006: active PLAN を `.ut-tdd/state/current-plan` へ書く (Gap B 活性化)。
 * planId!==null → 書く / null + removeFile 有 → 削除 / null + removeFile 無 → 空文字書込
 * (resolveActivePlan は空文字を trim で falsy 判定し branch fallback→null へ落とす = 実質 clear)。
 * resolveActivePlan の解決ロジックは不変。
 */
export function setActivePlan(planId: string | null, deps: SessionLogDeps): void {
  const path = currentPlanPath(deps.repoRoot);
  if (planId !== null) {
    // IMP-078 gap②: 2 行目に updated_at を刻む (stale 検知用)。1 行目 = plan_id は不変 (後方互換)。
    deps.writeText(path, `${planId}\n${deps.now()}`);
    return;
  }
  if (deps.removeFile) deps.removeFile(path);
  else deps.writeText(path, "");
}

/**
 * U-HOVER-006: commit message から PLAN ID を抽出 (best-effort、純関数)。
 * `git commit -F -` heredoc は本文が command に乗らないため null (= no-op)。
 */
export function inferPlanFromCommit(commitMessage: string): string | null {
  const m = commitMessage.match(PLAN_ID_RE);
  return m ? m[0] : null;
}

/**
 * U-SLOG-002: session jsonl へ 1 行 append。**never throws (fail-open)**。
 */
export function recordEvent(ev: SessionEvent, deps: SessionLogDeps): void {
  try {
    const file = join(
      deps.repoRoot,
      ".ut-tdd",
      "logs",
      "session",
      `${safeName(ev.session_id)}.jsonl`,
    );
    deps.appendLine(file, JSON.stringify(ev));
  } catch {
    // fail-open: ログ失敗で作業を止めない
  }
}

/** session_id の jsonl ログ path (`.ut-tdd/logs/session/<safeName>.jsonl`)。 */
export function sessionLogFile(repoRoot: string, sessionId: string): string {
  return join(repoRoot, ".ut-tdd", "logs", "session", `${safeName(sessionId)}.jsonl`);
}

/** jsonl raw を SessionEvent[] へ。壊れた行は skip (fail-open)。 */
export function parseSessionEvents(raw: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      /* 壊れた行は skip (fail-open) */
    }
  }
  return events;
}

/**
 * PLAN-L7-80 migration: a pre-L7-80 digest has no `session_watermarks`. The old
 * code folded whole sessions, so every matching event with `ts <= updated_at`
 * for an already-folded session was counted. Seed each folded session's
 * watermark to that leading count (events are appended in chronological order,
 * so `ts <= updated_at` events are the contiguous leading ones) so they are not
 * re-counted on the first post-migration run.
 */
function initialSessionWatermarks(
  base: PlanDigest,
  events: SessionEvent[],
  planId: string,
): Record<string, number> {
  if (base.session_watermarks) return { ...base.session_watermarks };
  const seed: Record<string, number> = {};
  if (!base.updated_at) return seed;
  const foldedSessions = new Set(base.sessions);
  for (const ev of events) {
    if (ev.plan_id !== planId) continue;
    if (!foldedSessions.has(ev.session_id)) continue;
    if (ev.ts <= base.updated_at) seed[ev.session_id] = (seed[ev.session_id] ?? 0) + 1;
  }
  return seed;
}

/**
 * U-SLOG-003 / U-SLOG-008: 純関数。再適用は **event 単位の high-watermark** で
 * idempotent (PLAN-L7-80)。`session_watermarks[sid]` = その session の matching
 * event を何件まで畳み済みか。同一 session が再 summarize されても、watermark を
 * 超える増分だけ計上し、旧実装の「session 単位 fold = 2 回目以降を全 skip」による
 * 過少計上を避ける。events は append-only ログのファイル順 = 計上順。
 * updated_at は max(prev, events) で巻き戻り禁止。failures は ts キーで dedupe。
 */
export function compressPlanDigest(
  events: SessionEvent[],
  planId: string,
  prev?: PlanDigest,
): PlanDigest {
  const base = prev ? structuredClone(prev) : emptyDigest(planId);
  const files = new Set(base.files_touched);
  const commits = new Set(base.commits);
  const failByTs = new Map(base.failures.map((f) => [f.ts, f]));
  const tsList: string[] = base.updated_at ? [base.updated_at] : [];
  const sessions = new Set(base.sessions);
  // Migration: a pre-L7-80 digest has no session_watermarks. Seed them from the
  // events already reflected in `base` (sessions previously folded, ts within the
  // recorded updated_at), so those events are not re-counted on the first run.
  const watermarks = initialSessionWatermarks(base, events, planId);

  const seenPerSession = new Map<string, number>();
  for (const ev of events) {
    if (ev.plan_id !== planId) continue;
    tsList.push(ev.ts);
    sessions.add(ev.session_id);
    const index = seenPerSession.get(ev.session_id) ?? 0;
    seenPerSession.set(ev.session_id, index + 1);
    if (index < (watermarks[ev.session_id] ?? 0)) continue; // 畳み済み (high-watermark)
    base.event_counts[ev.event_type] = (base.event_counts[ev.event_type] ?? 0) + 1;
    if (ev.target && isPath(ev.target)) files.add(ev.target);
    if (ev.event_type === "commit" && ev.target) commits.add(ev.target);
    if (ev.outcome === "error") failByTs.set(ev.ts, { ts: ev.ts, summary: sanitize(ev.target) });
  }
  for (const [sid, count] of seenPerSession) {
    watermarks[sid] = Math.max(watermarks[sid] ?? 0, count);
  }

  base.sessions = [...sessions];
  base.files_touched = [...files];
  base.commits = [...commits];
  base.failures = [...failByTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  base.updated_at = tsList.length ? tsList.reduce((a, b) => (a > b ? a : b)) : "";
  base.session_watermarks = watermarks;
  return base;
}

/** U-SLOG-005: session_start を append。常に 0 (fail-open)。 */
export function onSessionStart(input: SessionHookInput, deps: SessionLogDeps): number {
  try {
    recordEvent(
      {
        ts: deps.now(),
        session_id: input.session_id ?? "unknown",
        plan_id: input.plan_id ?? resolveActivePlan(deps),
        event_type: "session_start",
      },
      deps,
    );
  } catch {
    /* fail-open */
  }
  return 0;
}

/** tool_use (git commit は commit) を append。常に 0 (fail-open)。 */
export function onPostToolUse(input: SessionHookInput, deps: SessionLogDeps): number {
  try {
    const cmd = String((input.tool_input as { command?: unknown })?.command ?? "");
    const isCommit = input.tool_name === "Bash" && /git\s+commit/.test(cmd);
    // PLAN-L7-04 Gap B 配線: commit message に PLAN ID があれば current-plan を活性化 (best-effort)。
    // `-F -` heredoc は cmd に本文が乗らず inferred=null → no-op。fail-open (throw しない)。
    if (isCommit) {
      const inferred = inferPlanFromCommit(cmd);
      if (inferred) setActivePlan(inferred, deps);
    }
    recordEvent(
      {
        ts: deps.now(),
        session_id: input.session_id ?? "unknown",
        plan_id: input.plan_id ?? resolveActivePlan(deps),
        event_type: isCommit ? "commit" : "tool_use",
        tool: input.tool_name,
        // IMP-078 gap③: commit は HEAD hash を捕捉 (deps.headCommit、PostToolUse は commit 完了後 = 新 HEAD)。
        // hash 取得不能 (headCommit 未提供/null) なら undefined = 旧挙動 ("Bash (bash)" 汚染は避ける、I-2)。
        target: isCommit ? (deps.headCommit?.() ?? undefined) : summarize(input),
        outcome: outcomeOf(input),
      },
      deps,
    );
  } catch {
    /* fail-open */
  }
  return 0;
}

/**
 * U-SLOG-004: session の events を plan 別に compress し digest を更新。
 * plan_id=null のみの session は digest を書かない。常に 0 (fail-open)。
 */
export function onStop(input: SessionHookInput, deps: SessionLogDeps): number {
  try {
    const sid = input.session_id ?? "unknown";
    recordEvent(
      {
        ts: deps.now(),
        session_id: sid,
        plan_id: input.plan_id ?? resolveActivePlan(deps),
        event_type: "session_end",
      },
      deps,
    );
    const file = join(deps.repoRoot, ".ut-tdd", "logs", "session", `${safeName(sid)}.jsonl`);
    const raw = deps.readText(file);
    if (!raw) return 0;
    const events = parseSessionEvents(raw);
    const plans = new Set(
      events.map((e) => e.plan_id).filter((p): p is string => p !== null && p !== undefined),
    );
    for (const planId of plans) {
      const digestFile = join(
        deps.repoRoot,
        ".ut-tdd",
        "logs",
        "plan",
        `${safeName(planId)}.digest.json`,
      );
      const prevRaw = deps.readText(digestFile);
      let prev: PlanDigest | undefined;
      if (prevRaw) {
        try {
          prev = JSON.parse(prevRaw) as PlanDigest;
        } catch {
          prev = undefined;
        }
      }
      deps.writeText(digestFile, JSON.stringify(compressPlanDigest(events, planId, prev), null, 2));
    }
  } catch {
    /* fail-open */
  }
  return 0;
}

/** hook_event_name (正) / argv variant (fallback) で handler を選ぶ。常に 0。 */
export function dispatch(
  input: SessionHookInput,
  deps: SessionLogDeps,
  argvVariant?: string,
): number {
  const ev = input.hook_event_name ?? argvVariant ?? "";
  if (ev === "SessionStart" || ev === "start") return onSessionStart(input, deps);
  if (ev === "Stop" || ev === "stop") return onStop(input, deps);
  return onPostToolUse(input, deps); // default = PostToolUse
}

/**
 * hook entry 用の実 I/O deps (fail-open: I/O 例外は呼び出し側 try/catch が握る)。
 * gitHead (IMP-078 gap③): `git rev-parse HEAD` closure。未指定なら commit hash 捕捉なし (旧挙動)。
 */
export function nodeDeps(
  repoRoot: string,
  gitBranch: () => string | null,
  gitHead?: () => string | null,
): SessionLogDeps {
  return {
    repoRoot,
    now: () => new Date().toISOString(),
    appendLine: (path, line) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`, "utf8");
    },
    readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    writeText: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
    },
    currentBranch: gitBranch,
    listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    removeFile: (path) => {
      if (existsSync(path)) rmSync(path);
    },
    headCommit: gitHead,
  };
}
