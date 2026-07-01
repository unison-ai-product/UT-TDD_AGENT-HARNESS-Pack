import { describe, expect, it } from "vitest";
import {
  type AttemptRecord,
  attemptsFromSessionEvents,
  DEFAULT_ATTEMPT_THRESHOLD,
  evaluateAttemptEscalation,
  renderEscalationSignals,
  selectPrecedingSessionFile,
} from "../src/runtime/attempt-escalation";
import type { SessionEvent } from "../src/runtime/session-log";

function toolEvent(target: string, outcome: "ok" | "error", ts = "1"): SessionEvent {
  return {
    ts,
    session_id: "s",
    plan_id: null,
    event_type: "tool_use",
    tool: "Bash",
    target,
    outcome,
  };
}

describe("attempt escalation (PLAN-RECOVERY-05) — Iron Law 3-attempt stop", () => {
  it("escalates after 3 consecutive failures on the same subject", () => {
    const attempts: AttemptRecord[] = [
      { subject: "tests/x.test.ts", outcome: "error" },
      { subject: "tests/x.test.ts", outcome: "error" },
      { subject: "tests/x.test.ts", outcome: "error" },
    ];
    const signals = evaluateAttemptEscalation(attempts);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.subject).toBe("tests/x.test.ts");
    expect(signals[0]?.failureCount).toBe(3);
    expect(signals[0]?.message).toContain("STOP");
    expect(signals[0]?.message).toContain("root cause");
  });

  it("does not escalate below the threshold", () => {
    const signals = evaluateAttemptEscalation([
      { subject: "a", outcome: "error" },
      { subject: "a", outcome: "error" },
    ]);
    expect(signals).toEqual([]);
  });

  it("resets the streak when an attempt succeeds (ok breaks the spiral)", () => {
    const signals = evaluateAttemptEscalation([
      { subject: "a", outcome: "error" },
      { subject: "a", outcome: "error" },
      { subject: "a", outcome: "ok" },
      { subject: "a", outcome: "error" },
    ]);
    expect(signals).toEqual([]);
  });

  it("tracks consecutive failures per subject independently", () => {
    const signals = evaluateAttemptEscalation([
      { subject: "a", outcome: "error" },
      { subject: "b", outcome: "error" },
      { subject: "a", outcome: "error" },
      { subject: "b", outcome: "error" },
      { subject: "a", outcome: "error" },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.subject).toBe("a");
    expect(signals[0]?.failureCount).toBe(3);
  });

  it("honors a custom threshold", () => {
    const attempts: AttemptRecord[] = [
      { subject: "a", outcome: "error" },
      { subject: "a", outcome: "error" },
    ];
    expect(evaluateAttemptEscalation(attempts, { threshold: 2 })).toHaveLength(1);
    expect(DEFAULT_ATTEMPT_THRESHOLD).toBe(3);
  });

  it("orders multiple escalations by failure count desc then subject", () => {
    const attempts: AttemptRecord[] = [
      { subject: "b", outcome: "error" },
      { subject: "b", outcome: "error" },
      { subject: "b", outcome: "error" },
      { subject: "a", outcome: "error" },
      { subject: "a", outcome: "error" },
      { subject: "a", outcome: "error" },
      { subject: "a", outcome: "error" },
    ];
    const signals = evaluateAttemptEscalation(attempts);
    expect(signals.map((s) => s.subject)).toEqual(["a", "b"]);
  });

  it("extracts attempts from session tool_use events (ignores non-tool/no-target/no-outcome)", () => {
    const events: SessionEvent[] = [
      { ts: "1", session_id: "s", plan_id: null, event_type: "session_start" },
      {
        ts: "2",
        session_id: "s",
        plan_id: null,
        event_type: "tool_use",
        tool: "Bash",
        target: "tests/x.test.ts",
        outcome: "error",
      },
      {
        ts: "3",
        session_id: "s",
        plan_id: null,
        event_type: "tool_use",
        tool: "Bash",
        target: "tests/x.test.ts",
        // no outcome → ignored
      },
      {
        ts: "4",
        session_id: "s",
        plan_id: null,
        event_type: "tool_use",
        tool: "Read",
        // no target → ignored
        outcome: "ok",
      },
    ];
    const attempts = attemptsFromSessionEvents(events);
    expect(attempts).toEqual([{ subject: "tests/x.test.ts", outcome: "error" }]);
  });

  it("excludes unclassified Bash (target ending in '(bash)') from attempts", () => {
    // 未分類 Bash を 1 subject に併合しない (無関係コマンドの連続失敗を 1 ループ扱いしない)。
    const events: SessionEvent[] = [
      toolEvent("Bash (bash)", "error", "1"),
      toolEvent("Bash (bash)", "error", "2"),
      toolEvent("Bash (bash)", "error", "3"),
      toolEvent("Bash (vitest)", "error", "4"),
    ];
    const attempts = attemptsFromSessionEvents(events);
    expect(attempts).toEqual([{ subject: "Bash (vitest)", outcome: "error" }]);
  });

  it("escalates on classified-verb consecutive failures but not on unclassified bash", () => {
    const events: SessionEvent[] = [
      toolEvent("Bash (bash)", "error", "1"),
      toolEvent("Bash (vitest)", "error", "2"),
      toolEvent("Bash (vitest)", "error", "3"),
      toolEvent("Bash (vitest)", "error", "4"),
    ];
    const signals = evaluateAttemptEscalation(attemptsFromSessionEvents(events));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.subject).toBe("Bash (vitest)");
  });

  describe("selectPrecedingSessionFile (Q2=b: 直前 session のみ)", () => {
    it("picks the newest non-current jsonl by mtime", () => {
      const files = [
        { name: "old.jsonl", mtimeMs: 100 },
        { name: "newest.jsonl", mtimeMs: 300 },
        { name: "mid.jsonl", mtimeMs: 200 },
      ];
      expect(selectPrecedingSessionFile(files)).toBe("newest.jsonl");
    });

    it("excludes the current session so old failures do not resurface", () => {
      const files = [
        { name: "prev.jsonl", mtimeMs: 100 },
        { name: "current.jsonl", mtimeMs: 999 },
      ];
      expect(selectPrecedingSessionFile(files, "current.jsonl")).toBe("prev.jsonl");
    });

    it("returns null when there is no preceding session", () => {
      expect(selectPrecedingSessionFile([], "current.jsonl")).toBeNull();
      expect(
        selectPrecedingSessionFile([{ name: "current.jsonl", mtimeMs: 1 }], "current.jsonl"),
      ).toBeNull();
    });
  });

  describe("renderEscalationSignals (surface 文面)", () => {
    it("is empty when there are no signals", () => {
      expect(renderEscalationSignals([])).toBe("");
    });

    it("directs to STOP and questioning the root cause, not 'do not fix'", () => {
      const block = renderEscalationSignals([
        { escalate: true, subject: "Bash (vitest)", failureCount: 3, message: "x" },
      ]);
      expect(block).toContain("Iron Law");
      expect(block).toContain("STOP");
      expect(block).toContain("root cause");
      expect(block).toContain("Bash (vitest)");
    });
  });
});
