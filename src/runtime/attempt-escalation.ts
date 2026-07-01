/**
 * attempt-escalation (PLAN-RECOVERY-05) — systematic-debugging の Iron Law を機械化。
 *
 * source concept: obra/superpowers `systematic-debugging` (reference-only)。skill を複製せず
 * UT-TDD の Recovery/troubleshoot 駆動の要件から author する ([[feedback_migration_is_requirements_driven]])。
 *
 * 規律: **「同一 subject への修正試行が threshold (既定 3) 回連続で失敗したら STOP し、症状追いを
 * 止めて root cause / アーキテクチャを疑え」**。guess-and-check のスパイラル (本セッションで私が
 * 陥った moving tree の繰り返し計測 + 場当たり修正) を機械シグナルで止める。
 *
 * 判定は純関数 (`evaluateAttemptEscalation`)。session-log からの attempt 抽出
 * (`attemptsFromSessionEvents`) を分離し、emission/wiring は呼び出し側に委ねる
 * (forced-stop.ts と同方針、fail-open)。
 */
import type { SessionEvent } from "./session-log";

/** 1 回の修正試行。subject=対象 (file path / gate id / test name)、outcome=結果。 */
export interface AttemptRecord {
  subject: string;
  outcome: "ok" | "error";
}

export interface EscalationSignal {
  escalate: true;
  subject: string;
  /** 直近の連続失敗数 (ok を挟むとリセット)。 */
  failureCount: number;
  /** 人間/エージェント向けの STOP メッセージ (Iron Law を明示)。 */
  message: string;
}

export const DEFAULT_ATTEMPT_THRESHOLD = 3;

/**
 * 試行列から escalation signal を導く純関数。
 *
 * 各 subject の **直近連続失敗数** を数え (ok が挟まれば 0 にリセット)、threshold 以上の subject を
 * 失敗数降順 → subject 昇順で返す。空入力・閾値未満は空配列 (誤検知で作業を止めない)。
 */
export function evaluateAttemptEscalation(
  attempts: AttemptRecord[],
  opts: { threshold?: number } = {},
): EscalationSignal[] {
  const threshold = opts.threshold ?? DEFAULT_ATTEMPT_THRESHOLD;
  const consecutiveFailures = new Map<string, number>();
  for (const attempt of attempts) {
    if (!attempt.subject) continue;
    if (attempt.outcome === "error") {
      consecutiveFailures.set(attempt.subject, (consecutiveFailures.get(attempt.subject) ?? 0) + 1);
    } else {
      consecutiveFailures.set(attempt.subject, 0);
    }
  }

  const signals: EscalationSignal[] = [];
  for (const [subject, failureCount] of consecutiveFailures) {
    if (failureCount >= threshold) {
      signals.push({
        escalate: true,
        subject,
        failureCount,
        message:
          `${failureCount} consecutive failed attempts on ${subject} - STOP. ` +
          `Iron Law: investigate the root cause / question the architecture before another fix ` +
          `(systematic-debugging). Break the symptom-chasing spiral; route to Recovery/troubleshoot.`,
      });
    }
  }
  return signals.sort(
    (a, b) => b.failureCount - a.failureCount || a.subject.localeCompare(b.subject),
  );
}

/**
 * session 生ログ events から attempt 列を抽出する。
 *
 * tool_use イベントのうち target (対象 path / 検証 verb) と outcome (ok/error) を持つものを試行と
 * みなす。時系列順を保持するため events の順序をそのまま使う (連続失敗判定の前提)。
 *
 * **未分類 Bash (`target` が `(bash)` 終端) は除外** する。session-log は Bash の verb を
 * 分類して `"Bash (vitest)"` 等で残す (verb-classify) が、whitelist 外のコマンドは `"Bash (bash)"`
 * となる。これらを 1 subject にまとめると無関係コマンドの連続失敗を 1 ループ扱いして誤検知する
 * ため対象外にする (Codex cross-review: 未分類は強引に併合しない、PLAN-RECOVERY-05)。
 */
export function attemptsFromSessionEvents(events: SessionEvent[]): AttemptRecord[] {
  const records: AttemptRecord[] = [];
  for (const event of events) {
    if (event.event_type !== "tool_use") continue;
    if (!event.target) continue;
    if (event.outcome !== "ok" && event.outcome !== "error") continue;
    if (event.target.endsWith("(bash)")) continue; // 未分類 Bash は escalation 対象外
    records.push({ subject: event.target, outcome: event.outcome });
  }
  return records;
}

/** session ログファイルの選択用メタ (name = `<id>.jsonl`、mtimeMs = 更新時刻)。 */
export interface SessionFileMeta {
  name: string;
  mtimeMs: number;
}

/**
 * 引き継ぎ surface 用に **直前 session** のログファイルを 1 つだけ選ぶ純関数。
 *
 * Q2=b (Codex cross-review): durable な finding 化はせず、SessionStart で直前 session を都度
 * 再導出する。古い失敗の再浮上 (stale 累積) を避けるため **現セッションを除いた中で最新 (mtime 最大)
 * の 1 ファイルだけ** を返す。候補が無ければ null。
 */
export function selectPrecedingSessionFile(
  files: SessionFileMeta[],
  currentSessionFileName?: string,
): string | null {
  let best: SessionFileMeta | null = null;
  for (const f of files) {
    if (!f.name.endsWith(".jsonl")) continue;
    if (currentSessionFileName && f.name === currentSessionFileName) continue;
    if (!best || f.mtimeMs > best.mtimeMs) best = f;
  }
  return best?.name ?? null;
}

/**
 * escalation signals を引き継ぎ surface 向けテキストブロックに整形する。signal が無ければ空文字
 * (出力しない)。文面は「直すな」ではなく「STOP → root cause を疑え → 検証反復を止めろ」へ誘導する。
 */
export function renderEscalationSignals(signals: EscalationSignal[]): string {
  if (signals.length === 0) return "";
  const lines = [
    `attempt-escalation (Iron Law) warning - 直前 session で ${signals.length} 件の連続失敗ループを検出 (STOP / 根本原因を疑え):`,
  ];
  for (const s of signals) {
    lines.push(
      `  - ${s.subject}: ${s.failureCount} consecutive failures - STOP, question the root cause`,
    );
  }
  return `${lines.join("\n")}\n`;
}
