import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENERATED_BY as SIDECAR_GENERATED_BY } from "../src/handover/handover-constants.ts";
import {
  buildPointer,
  checkHandoverBypass,
  GENERATED_BY,
  type HandoverDeps,
  type HandoverPointer,
  handoverStale,
  latestSessionId,
  readPointer,
  runHandover,
} from "../src/handover/index.ts";

const NOW = "2026-06-04T00:00:00.000Z";

/** in-memory file store の mock HandoverDeps (now 固定で決定論)。 */
function mockDeps(over: Partial<HandoverDeps> = {}): HandoverDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    repoRoot: "/repo",
    now: () => NOW,
    readText: (p) => files.get(p) ?? null,
    writeText: (p, c) => files.set(p, c),
    listDir: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${dir}/`) || k.startsWith(`${dir}\\`))
        .map((k) => k.slice(dir.length + 1)),
    ...over,
  };
}

const pointerPath = join("/repo", ".ut-tdd", "handover", "CURRENT.json");

describe("PLAN-L7-173 handover sidecars", () => {
  it("re-exported constant stays aligned", () => {
    expect(SIDECAR_GENERATED_BY).toBe(GENERATED_BY);
  });
});

describe("U-HOVER-001 runHandover ignores legacy PLAN digests", () => {
  it("legacy digest data does not populate new pointer PLAN fields", () => {
    const deps = mockDeps();
    deps.files.set(
      join("/repo", ".ut-tdd", "logs", "plan", "PLAN-L6-01.digest.json"),
      JSON.stringify({ plan_id: "PLAN-L6-01", sessions: ["s1"], commits: ["abc"] }),
    );

    const result = runHandover({ date: "2026-06-04" }, deps);
    expect(result.pointer.active_plan).toBeNull();
    expect(result.pointer.digest_summary).toBeNull();
  });
});

describe("U-HOVER-002 buildPointer", () => {
  it("keeps generic pointer status, timestamp, and null PLAN fields", () => {
    const pointer = buildPointer({
      status: "in_progress",
      now: NOW,
    });
    expect(pointer.status).toBe("in_progress");
    expect(pointer.updated_at).toBe(NOW);
    expect(pointer.active_plan).toBeNull();
    expect(pointer.digest_summary).toBeNull();
  });
});

describe("U-HOVER-005 handoverStale", () => {
  it("null → true / 24h 超 → true / 以内 → false / 境界(=24h) は stale でない", () => {
    expect(handoverStale(null, NOW)).toBe(true);
    expect(handoverStale("2026-06-02T00:00:00.000Z", NOW)).toBe(true); // 48h
    expect(handoverStale("2026-06-03T12:00:00.000Z", NOW)).toBe(false); // 12h
    expect(handoverStale("2026-06-03T00:00:00.000Z", NOW)).toBe(false); // ちょうど 24h → > 判定で false
    expect(handoverStale("not-a-date", NOW)).toBe(true); // parse 不能
  });
});

describe("U-HOVER-010 generic pointer parsing (IMP-047)", () => {
  function pointer(over: Partial<HandoverPointer> = {}): HandoverPointer {
    return {
      active_plan: null,
      status: "in_progress",
      digest_summary: null,
      updated_at: NOW,
      ...over,
    };
  }
  it("readPointer: missing and malformed input return null; valid generic pointer parses", () => {
    const deps = mockDeps();
    expect(readPointer(deps)).toBeNull();
    deps.files.set(pointerPath, "{not json");
    expect(readPointer(deps)).toBeNull();
    deps.files.set(pointerPath, JSON.stringify(pointer()));
    expect(readPointer(deps)).toMatchObject({
      active_plan: null,
      status: "in_progress",
      digest_summary: null,
      updated_at: NOW,
    });
  });
});
describe("U-HOVER-007 runHandover", () => {
  it("dryRun → 何も書かず pointer を返す (written=[]、非破壊)", () => {
    const deps = mockDeps();
    const before = new Map(deps.files);
    const r = runHandover({ date: "2026-06-04", dryRun: true }, deps);
    expect(r.written).toEqual([]);
    expect(r.pointer.active_plan).toBeNull();
    expect(deps.files).toEqual(before); // 非破壊
  });

  it("通常 → CURRENT.json だけを書く (docs/handover に散文を作らない)", () => {
    const deps = mockDeps();
    const r = runHandover({ date: "2026-06-04" }, deps);
    expect(r.written).toEqual([join(".ut-tdd", "handover", "CURRENT.json")]);
    expect([...deps.files.keys()].some((p) => p.includes(join("docs", "handover")))).toBe(false);
  });

  it("complete=true → CURRENT.json status=completed かつ active_plan=null", () => {
    const deps = mockDeps();
    runHandover({ date: "2026-06-04", complete: true }, deps);
    const pointer = JSON.parse(deps.files.get(pointerPath) ?? "{}");
    expect(pointer.status).toBe("completed");
    expect(pointer.active_plan).toBeNull();
  });

  // IMP-078 gap①: runHandover は generated_by 署名を刻む。
  it("gap①: runHandover が CURRENT.json に generated_by を刻み、散文用の項目は持たない", () => {
    const deps = mockDeps();
    const r = runHandover({ date: "2026-06-08", complete: true }, deps);
    expect(r.pointer.generated_by).toBe(GENERATED_BY);
    expect(r.pointer).not.toHaveProperty("latest_doc");
    expect(r.pointer).not.toHaveProperty("doc_entry_count");
  });
});

describe("U-HOVER-011 checkHandoverBypass 署名照合 (IMP-078 gap①、state-channel-consolidation §5.2)", () => {
  function pointerJson(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      active_plan: "P",
      status: "completed",
      digest_summary: null,
      updated_at: NOW,
      ...over,
    });
  }

  it("generated_by 無し pointer → 手書き bypass warn", () => {
    const deps = mockDeps();
    deps.files.set(pointerPath, pointerJson()); // generated_by 欠落
    const w = checkHandoverBypass(deps);
    expect(w.some((m) => m.includes("bypass"))).toBe(true);
  });

  it("generated_by 一致の pointer → 警告ゼロ", () => {
    const deps = mockDeps();
    deps.files.set(pointerPath, pointerJson({ generated_by: GENERATED_BY }));
    expect(checkHandoverBypass(deps)).toEqual([]);
  });

  it("pointer 不在 → bypass 警告ゼロ", () => {
    expect(checkHandoverBypass(mockDeps())).toEqual([]);
  });
});

describe("U-HOVER-012 latestSessionId (IMP-078 gap④)", () => {
  const sessionDir = join("/repo", ".ut-tdd", "logs", "session");

  it("latestSessionId: 最新 event ts の session を返す / 不在→null", () => {
    const deps = mockDeps();
    expect(latestSessionId(deps)).toBeNull();
    deps.files.set(
      join(sessionDir, "s1.jsonl"),
      '{"ts":"2026-06-08T01:00:00Z","session_id":"s1"}\n',
    );
    deps.files.set(
      join(sessionDir, "s2.jsonl"),
      '{"ts":"2026-06-08T05:00:00Z","session_id":"s2"}\n',
    );
    expect(latestSessionId(deps)).toBe("s2");
  });
});
