import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ClassifyResult,
  classifyFeedback,
  detectDanglingTurn,
  emitClassifyRequest,
  type FeedbackEntry,
  pendingRecoveryProposals,
  recordFeedback,
  recordForcedStop,
  scanDanglingStops,
} from "../src/runtime/forced-stop";
import type { SessionEvent, SessionLogDeps } from "../src/runtime/session-log";

/** in-memory file store の mock deps (now 固定で決定論)。 */
function mockDeps(
  over: Partial<SessionLogDeps> = {},
): SessionLogDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    repoRoot: "/repo",
    now: () => "2026-06-02T00:00:00.000Z",
    appendLine: (p, l) => files.set(p, `${files.get(p) ?? ""}${l}\n`),
    readText: (p) => files.get(p) ?? null,
    writeText: (p, c) => files.set(p, c),
    currentBranch: () => null,
    listDir: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(dir) && k.length > dir.length)
        .map((k) => k.slice(dir.length + 1))
        .filter((name) => name.length > 0 && !name.includes("/") && !name.includes("\\")),
    ...over,
  };
}

const ev = (
  ts: string,
  event_type: SessionEvent["event_type"],
  over: Partial<SessionEvent> = {},
): SessionEvent => ({ ts, session_id: "s1", plan_id: "PLAN-A", event_type, ...over });

const sessionPath = (sid: string) => join("/repo", ".ut-tdd", "logs", "session", `${sid}.jsonl`);
const feedbackPath = (plan: string) =>
  join("/repo", ".ut-tdd", "logs", "feedback", `${plan}.jsonl`);

describe("forced-stop (PLAN-L7-02 add-impl / U-FSF)", () => {
  it("U-FSF-001: detectDanglingTurn 純粋性 / dangling 判定 / from 規則", () => {
    // 空 events
    expect(detectDanglingTurn([])).toEqual({ dangling: false, from: null });

    // session_end で閉じている → false
    expect(detectDanglingTurn([ev("T1", "tool_use"), ev("T2", "session_end")])).toEqual({
      dangling: false,
      from: null,
    });

    // session_end あり + その後 tool_use → from = 直後イベント ts
    expect(
      detectDanglingTurn([ev("T1", "session_end"), ev("T2", "tool_use"), ev("T3", "tool_use")]),
    ).toEqual({ dangling: true, from: "T2" });

    // session_end 皆無 + tool_use → from = events[0].ts
    expect(detectDanglingTurn([ev("T1", "tool_use"), ev("T2", "tool_use")])).toEqual({
      dangling: true,
      from: "T1",
    });

    // user_prompt のみ trailing (session_end なし) → dangling
    expect(detectDanglingTurn([ev("T1", "user_prompt")])).toEqual({
      dangling: true,
      from: "T1",
    });
  });

  it("U-FSF-002: recordForcedStop は append / fail-open / 本文非掲載・参照のみ", () => {
    const deps = mockDeps();
    recordForcedStop(
      { session_id: "s1", plan_id: "PLAN-A", dangling_from: "T1", next_message_ref: "s1.jsonl#3" },
      deps,
    );
    const line = deps.files.get(sessionPath("s1")) as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.event_type).toBe("forced_stop");
    expect(parsed.next_message_ref).toBe("s1.jsonl#3");
    expect(typeof parsed.next_message_ref).toBe("string");
    // 本文フィールドを持たない (秘匿)
    expect(parsed.message).toBeUndefined();
    expect(parsed.text).toBeUndefined();
    expect(parsed.content).toBeUndefined();

    // fail-open
    const throwing = mockDeps({
      appendLine: () => {
        throw new Error("disk full");
      },
    });
    expect(() => recordForcedStop({ dangling_from: "T1" }, throwing)).not.toThrow();
  });

  it("U-FSF-003: classifyFeedback は mock 反映 / 失敗時 feedback+low+unclassified に倒す", async () => {
    const ok = await classifyFeedback("だめだろこれ", async () => ({
      category: "feedback",
      attention: "high",
      reason: "強否定",
    }));
    expect(ok).toEqual({ category: "feedback", attention: "high", reason: "強否定" });

    const mistake = await classifyFeedback("あ、間違えた", async () => ({
      category: "mistake",
      attention: "low",
      reason: "誤操作",
    }));
    expect(mistake.category).toBe("mistake");

    // classifier が reject → 取りこぼし回避で feedback+low+unclassified
    const rejected = await classifyFeedback("x", async () => {
      throw new Error("haiku down");
    });
    expect(rejected).toEqual({ category: "feedback", attention: "low", reason: "unclassified" });

    // 不正出力 → 同様に倒す
    const garbage = await classifyFeedback(
      "x",
      async () => ({ foo: "bar" }) as unknown as ClassifyResult,
    );
    expect(garbage).toEqual({ category: "feedback", attention: "low", reason: "unclassified" });
  });

  it("U-FSF-004: recordFeedback は feedback のみ / mistake no-op / plan_id=null skip / idempotent / sanitize", () => {
    const deps = mockDeps();
    // feedback + high → recovery_proposed true、記録
    recordFeedback(
      { category: "feedback", attention: "high", reason: "token=abc123 漏洩指摘" },
      { session_id: "s1", plan_id: "PLAN-A", summary: "password=secret を docs に書いた" },
      deps,
    );
    const stored = deps.files.get(feedbackPath("PLAN-A")) as string;
    const entry = JSON.parse(stored.trim()) as FeedbackEntry;
    expect(entry.category).toBe("feedback");
    expect(entry.recovery_proposed).toBe(true);
    // sanitize: secret がマスクされ生文が残らない
    expect(entry.summary).toContain("***");
    expect(entry.summary).not.toContain("secret");
    expect(entry.reason).toContain("***");

    // idempotent: 同一内容 (now が変わっても) 再適用 → 増えない (内容キー dedup)
    const movedNow = mockDeps({ now: () => "2099-12-31T23:59:59.000Z" });
    movedNow.files.set(feedbackPath("PLAN-A"), deps.files.get(feedbackPath("PLAN-A")) as string);
    recordFeedback(
      { category: "feedback", attention: "high", reason: "token=abc123 漏洩指摘" },
      { session_id: "s1", plan_id: "PLAN-A", summary: "password=secret を docs に書いた" },
      movedNow,
    );
    expect((movedNow.files.get(feedbackPath("PLAN-A")) as string).trim().split("\n").length).toBe(
      1,
    );

    // mistake は no-op
    const d2 = mockDeps();
    recordFeedback(
      { category: "mistake", attention: "low", reason: "誤操作" },
      { session_id: "s1", plan_id: "PLAN-A", summary: "x" },
      d2,
    );
    expect(d2.files.get(feedbackPath("PLAN-A"))).toBeUndefined();

    // plan_id=null は書かない
    const d3 = mockDeps();
    recordFeedback(
      { category: "feedback", attention: "high", reason: "y" },
      { session_id: "s1", plan_id: null, summary: "y" },
      d3,
    );
    expect([...d3.files.keys()].some((k) => k.includes("feedback"))).toBe(false);
  });

  it("U-FSF-005: pendingRecoveryProposals は proposed && 未対応のみ / 不正行スキップ / 空時 []", () => {
    const deps = mockDeps();
    const fp = feedbackPath("PLAN-A");
    const mk = (over: Partial<FeedbackEntry>): string =>
      JSON.stringify({
        ts: over.ts ?? "T",
        session_id: "s1",
        plan_id: "PLAN-A",
        category: "feedback",
        attention: "high",
        summary: "s",
        recovery_proposed: true,
        reason: "r",
        ...over,
      });
    deps.files.set(
      fp,
      [
        mk({ ts: "T1", recovery_proposed: true }), // 未対応 proposed → 含む
        mk({ ts: "T2", recovery_proposed: false }), // 非 proposed → 除外
        mk({ ts: "T3", recovery_proposed: true, resolved_at: "2026-06-02T01:00:00Z" }), // 対応済 → 除外
        "{ broken json", // 不正行 → スキップ
        mk({ ts: "T4", recovery_proposed: true }), // 未対応 proposed → 含む
      ].join("\n"),
    );
    const pending = pendingRecoveryProposals(deps);
    expect(pending.map((e) => e.ts).sort()).toEqual(["T1", "T4"]);

    // 空時 []
    expect(pendingRecoveryProposals(mockDeps())).toEqual([]);
  });

  it("U-FSF-006: emitClassifyRequest は pmo-haiku 契約 (role/text/output_schema) を含む", () => {
    const req = JSON.parse(emitClassifyRequest("やめろ"));
    expect(req.role).toBe("pmo-haiku");
    expect(req.text).toBe("やめろ");
    expect(req.output_schema.category).toContain("mistake");
    expect(req.output_schema.attention).toContain("high");
  });

  it("U-FSF-007: scanDanglingStops は dangling session のみ forced_stop 記録 / idempotent / current 除外 / fail-open", () => {
    const deps = mockDeps();
    // s1 = dangling (tool_use 後 session_end 無し) / s2 = 正常終了 / cur = 起動中
    deps.files.set(
      sessionPath("s1"),
      `${JSON.stringify(ev("T1", "tool_use"))}\n${JSON.stringify(ev("T2", "tool_use"))}\n`,
    );
    deps.files.set(
      sessionPath("s2"),
      `${JSON.stringify(ev("T1", "tool_use", { session_id: "s2" }))}\n${JSON.stringify(ev("T2", "session_end", { session_id: "s2" }))}\n`,
    );
    deps.files.set(
      sessionPath("cur"),
      `${JSON.stringify(ev("T1", "session_start", { session_id: "cur" }))}\n`,
    );

    expect(scanDanglingStops(deps, "cur")).toBe(1); // s1 のみ
    expect(deps.files.get(sessionPath("s1"))).toContain('"event_type":"forced_stop"');
    expect(deps.files.get(sessionPath("s2"))).not.toContain("forced_stop"); // 正常終了は対象外

    // idempotent: 再走査で forced_stop 既存 → 記録しない
    expect(scanDanglingStops(deps, "cur")).toBe(0);

    // fail-open: listDir が throw しても落ちない
    const throwing = mockDeps({
      listDir: () => {
        throw new Error("io");
      },
    });
    expect(() => scanDanglingStops(throwing)).not.toThrow();
  });
});
