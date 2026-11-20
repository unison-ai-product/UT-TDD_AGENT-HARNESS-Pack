/**
 * session-log — session event recording (fail-OPEN)。
 *
 * 設計 (①): docs/design/harness/L6-function-design/session-log.md (PLAN-L6-03 add-design)。
 * テスト設計 (③): docs/test-design/harness/L7-unit-test-design.md §1.5 U-SLOG。
 *
 * agent-guard と同じ hook shim + 純粋関数分離パターン。ただし **fail-OPEN** (常に 0、
 * never throws)。ログがワークフローを止めてはならない。判定本体は本ファイル、hook entry は
 * .claude/hooks/session-log.ts。
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "../shared/fs.ts";
import { evaluateMemoryPromotion } from "./memory-promotion.ts";
import { outcomeOf } from "./post-tool-use-input.ts";
import { classifyVerificationVerb } from "./verb-classify.ts";

export type SessionEventType =
  | "session_start"
  | "tool_use"
  | "commit"
  | "plan_switch"
  | "memory_write"
  | "memory_promotion_missed"
  | "session_end"
  | "forced_stop" // 強制停止 (推定、PLAN-L6-04/L7-02 forced-stop-feedback)
  | "user_prompt" // ユーザー入力 (dangling-turn 推定の活動 marker)
  | "skill_injection"; // skill context 注入の成功/skip (PLAN-L7-262、silent fail-open の可視化)

export interface SessionEvent {
  ts: string; // ISO8601 (hook 受領時)
  session_id: string;
  plan_id: string | null;
  event_type: SessionEventType;
  tool?: string;
  target?: string; // path / 要約のみ (sanitize 済、値・引数は載せない)
  outcome?: "ok" | "error";
}

export interface SessionHookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  plan_id?: string | null;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

/** I/O・clock を注入 (now 注入で決定論)。 */
export interface SessionLogDeps {
  repoRoot: string;
  now: () => string;
  appendLine: (path: string, line: string) => void;
  readText: (path: string) => string | null;
  /** dir 内の entry 名一覧 (feedback log readers 用)。未提供/失敗時は []。 */
  listDir?: (dir: string) => string[];
  /** 直近 commit hash (`git rev-parse HEAD`)。IMP-078 gap③: commit 捕捉を hook で供給。未提供→hash 無し。 */
  headCommit?: () => string | null;
  /** Optional user-facing warning sink. Omitted in tests and non-interactive consumers. */
  warn?: (message: string) => void;
}

// token/key/secret/password 様の `name=value` / `name: value` を値マスク
const SECRET_RE =
  /\b([A-Za-z0-9_-]*(?:token|key|secret|password|passwd|pwd|bearer)[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi;
const MAX_SUMMARY = 120;

/** token/key/secret 様の値をマスクする (truncate はしない、path 系の再利用向け純関数)。 */
function maskSecrets(raw: string): string {
  return raw.replace(SECRET_RE, "$1***");
}

/** 禁則 (token/key/secret 様) をマスクし 120 文字へ truncate。durable digest への漏洩防止。 */
export function sanitize(raw: string | undefined): string {
  if (!raw) return "";
  const masked = maskSecrets(raw);
  return masked.length > MAX_SUMMARY ? `${masked.slice(0, MAX_SUMMARY - 1)}…` : masked;
}

/**
 * ツール名 + 対象 path のみ。引数値・ファイル内容は載せない。
 *
 * path を伴うツールは 120 文字 truncate を **適用しない** (mask のみ)。この target は
 * work-guard の sessionTouchedFiles (このセッションが触ったファイル一覧) の突合キーに
 * そのまま再利用されており、途中で "…" 省略されると実 path と文字列一致せず、深い
 * repo path + 説明的なファイル名 (本 repo の PLAN 命名規約) で長さ 120 超が普通に起き、
 * 自分自身の正当な編集が「他ランタイムの foreign uncommitted file」と誤検知され block
 * される (システム全体監査で実発見、2026-07-08)。path が secret を含むことは通常無いが
 * mask 自体は安全側で維持する。
 */
export function summarize(input: SessionHookInput): string {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const path = (ti.file_path ?? ti.path ?? ti.notebook_path) as string | undefined;
  // Bash は引数を残さず固定の検証 verb token だけを hint にする (PLAN-RECOVERY-05 item 2)。
  // attempt-escalation が「同じ検証コマンドの連続失敗」を grouping できるよう、command を
  // whitelist verb (vitest/tsc/doctor/lint/...) に分類して埋める。未分類/非 Bash は従来どおり。
  if ((tool === "Bash" || tool === "PowerShell") && !path) {
    const verb = classifyVerificationVerb(String(ti.command ?? ""));
    return sanitize(`${tool} (${verb ?? tool.toLowerCase()})`);
  }
  if (path) {
    return maskSecrets(`${tool} ${path}`.trim());
  }
  const hint = tool === "Bash" ? "(bash)" : tool === "PowerShell" ? "(powershell)" : "";
  return sanitize(`${tool} ${hint}`.trim());
}

/** session_id / plan_id を file 名に使う前に path 分離子を除去 (traversal 防止)。 */
export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isMemoryWriteInput(input: SessionHookInput): boolean {
  const tool = input.tool_name ?? "";
  const values = input.tool_input ?? {};
  const path = String(values.file_path ?? values.path ?? values.notebook_path ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();
  if (
    path.includes(".ut-tdd/memory/") &&
    /^(?:Edit|Write|MultiEdit|apply_patch|write_file)$/i.test(tool)
  ) {
    return true;
  }
  const patch = String(values.patch ?? values.input ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();
  if (
    /^(?:apply_patch|write_file)$/i.test(tool) &&
    /\*\*\* (?:update|add|delete) file: .*\.ut-tdd\/memory\//i.test(patch)
  ) {
    return true;
  }
  const command = String(values.command ?? values.cmd ?? "");
  return /(?:ut-tdd|src[\\/]cli\.ts)\s+memory\s+add\b/i.test(command);
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

// PLAN-L7-262: 注入実績/失敗の記録。session_id が引けない CLI 経路は
// UT_TDD_SESSION_ID env、それも無ければ明示の不明 marker を使う (空文字での偽装をやめる)。
export const SKILL_INJECTION_UNKNOWN_SESSION_ID = "cli:unknown-session";

export interface SkillInjectionAttempt {
  plan_id: string;
  status: "injected" | "skipped";
  reason?: string;
  required: number;
  optional: number;
  session_id?: string;
}

/** skill context 注入の成功/skip を session jsonl へ記録する (fail-open は recordEvent 側)。 */
export function recordSkillInjectionAttempt(
  attempt: SkillInjectionAttempt,
  deps: SessionLogDeps,
): void {
  const sessionId =
    attempt.session_id?.trim() ||
    process.env.UT_TDD_SESSION_ID?.trim() ||
    SKILL_INJECTION_UNKNOWN_SESSION_ID;
  const reason = attempt.reason ? ` reason=${attempt.reason}` : "";
  // outcome=error は真の障害系 skip (reason が *-failed) のみ。no-matching-skills 等の
  // 正常系 skip は error event にしない。
  const isFailure = attempt.status === "skipped" && (attempt.reason?.endsWith("-failed") ?? false);
  recordEvent(
    {
      ts: deps.now(),
      session_id: sessionId,
      plan_id: attempt.plan_id || null,
      event_type: "skill_injection",
      tool: "skill-injection",
      target: sanitize(
        `${attempt.status} required=${attempt.required} optional=${attempt.optional}${reason}`,
      ),
      outcome: isFailure ? "error" : "ok",
    },
    deps,
  );
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

/** U-SLOG-005: session_start を append。常に 0 (fail-open)。 */
export function onSessionStart(input: SessionHookInput, deps: SessionLogDeps): number {
  try {
    recordEvent(
      {
        ts: deps.now(),
        session_id: input.session_id ?? "unknown",
        plan_id: input.plan_id ?? null,
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
    const shellInput = input.tool_input as { command?: unknown; cmd?: unknown };
    const cmd = String(shellInput?.command ?? shellInput?.cmd ?? "");
    // PowerShell は Windows ネイティブ Claude Code の主シェルツール (PLAN-RECOVERY-13 / issue #86)。
    const isShellTool = /^(?:Bash|PowerShell|exec_command|local_shell)$/i.test(
      input.tool_name ?? "",
    );
    const isCommit = isShellTool && /\bgit\s+commit\b/i.test(cmd);
    const isMemoryWrite = isMemoryWriteInput(input);
    const observedOutcome = outcomeOf(input);
    recordEvent(
      {
        ts: deps.now(),
        session_id: input.session_id ?? "unknown",
        plan_id: input.plan_id ?? null,
        event_type: isCommit ? "commit" : isMemoryWrite ? "memory_write" : "tool_use",
        tool: input.tool_name,
        // IMP-078 gap③: commit は HEAD hash を捕捉 (deps.headCommit、PostToolUse は commit 完了後 = 新 HEAD)。
        // hash 取得不能 (headCommit 未提供/null) なら undefined = 旧挙動 ("Bash (bash)" 汚染は避ける、I-2)。
        target: isCommit ? (deps.headCommit?.() ?? undefined) : summarize(input),
        outcome: isCommit || isMemoryWrite ? (observedOutcome ?? "ok") : observedOutcome,
      },
      deps,
    );
  } catch {
    /* fail-open */
  }
  return 0;
}

/** Stop event と generic memory-promotion nudge を記録する。常に 0 (fail-open)。 */
export function onStop(input: SessionHookInput, deps: SessionLogDeps): number {
  try {
    const sid = input.session_id ?? "unknown";
    recordEvent(
      {
        ts: deps.now(),
        session_id: sid,
        plan_id: input.plan_id ?? null,
        event_type: "session_end",
      },
      deps,
    );
    const file = join(deps.repoRoot, ".ut-tdd", "logs", "session", `${safeName(sid)}.jsonl`);
    const raw = deps.readText(file);
    if (!raw) return 0;
    const events = parseSessionEvents(raw);
    const promotion = evaluateMemoryPromotion(events);
    if (promotion.should_nudge) {
      const nudge: SessionEvent = {
        ts: deps.now(),
        session_id: sid,
        plan_id: input.plan_id ?? null,
        event_type: "memory_promotion_missed",
        tool: "session-summary",
        target: promotion.reason,
        outcome: "ok",
      };
      recordEvent(nudge, deps);
      deps.warn?.(
        "memory nudge: commit/PLAN transition occurred without a durable HARNESS memory write",
      );
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
export function nodeDeps(repoRoot: string, gitHead?: () => string | null): SessionLogDeps {
  return {
    repoRoot,
    now: () => new Date().toISOString(),
    appendLine: (path, line) => {
      ensureDir(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`, "utf8");
    },
    readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
    headCommit: gitHead,
    warn: (message) => process.stdout.write(`${message}\n`),
  };
}
