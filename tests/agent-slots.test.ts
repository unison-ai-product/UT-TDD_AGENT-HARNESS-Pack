import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentSlotsDeps,
  DEFAULT_MAX_PARALLEL,
  exceedsParallelLimit,
  fireSlot,
  listActiveSlots,
  listStaleSlots,
  loadSlots,
  nodeAgentSlotsDeps,
  peakParallel,
  recordGuardFire,
  releaseOldestGuardSlot,
  releaseSlot,
  type Slot,
  sweepStaleGuardSlots,
} from "../src/runtime/agent-slots";
import { resolveRosterCapability } from "../src/runtime/agent-slots-roster";

const statePath = join("/repo", ".ut-tdd", "state", "agent-slots.json");

/** in-memory + 単調 clock の mock deps (決定論)。now は呼ぶたび 1 分進む。 */
function mockDeps(over: Partial<AgentSlotsDeps> = {}): AgentSlotsDeps & {
  files: Map<string, string>;
  setNow: (iso: string) => void;
} {
  const files = new Map<string, string>();
  let seq = 0;
  let nowIso = "2026-06-04T00:00:00.000Z";
  return {
    files,
    setNow: (iso) => {
      nowIso = iso;
    },
    repoRoot: "/repo",
    now: () => nowIso,
    readText: (p) => files.get(p) ?? null,
    writeText: (p, c) => files.set(p, c),
    newId: () => `slot-${seq++}`,
    ...over,
  };
}

describe("U-SLOT-001 loadSlots", () => {
  it("不在 → [] / 壊れ → [] / 非配列 → [] (never throw)", () => {
    const deps = mockDeps();
    expect(loadSlots(deps)).toEqual([]);
    deps.files.set(statePath, "{not json");
    expect(loadSlots(deps)).toEqual([]);
    deps.files.set(statePath, JSON.stringify({ not: "array" }));
    expect(loadSlots(deps)).toEqual([]);
  });

  it("invalid slot shapes fail closed through schema validation", () => {
    const deps = mockDeps();
    deps.files.set(
      statePath,
      JSON.stringify([
        {
          slot_id: "slot-1",
          agent_kind: "codex",
          role: null,
          slot_source: "unknown",
          fired_at: "2026-06-04T00:00:00.000Z",
          released_at: null,
          status: "running",
          exit_code: null,
        },
      ]),
    );

    expect(loadSlots(deps)).toEqual([]);
  });
});

describe("U-SLOT-002 fireSlot / releaseSlot", () => {
  it("fire → running slot 追記 + state 永続化", () => {
    const deps = mockDeps();
    const s = fireSlot({ agent_kind: "pmo-sonnet", role: "tl", slot_source: "agent_guard" }, deps);
    expect(s.status).toBe("running");
    expect(s.released_at).toBeNull();
    expect(s.role).toBe("tl");
    expect(loadSlots(deps)).toHaveLength(1);
  });

  it("release → terminal status + released_at 記録 / 返り true", () => {
    const deps = mockDeps();
    const s = fireSlot({ agent_kind: "codex-se", slot_source: "team_runner" }, deps);
    deps.setNow("2026-06-04T00:05:00.000Z");
    expect(releaseSlot({ slotId: s.slot_id, status: "completed", exitCode: 0 }, deps)).toBe(true);
    const after = loadSlots(deps)[0];
    expect(after.status).toBe("completed");
    expect(after.exit_code).toBe(0);
    expect(after.released_at).toBe("2026-06-04T00:05:00.000Z");
  });

  it("release: 対象なし / 既 release → false (idempotent)", () => {
    const deps = mockDeps();
    expect(releaseSlot({ slotId: "nope", status: "completed", exitCode: 0 }, deps)).toBe(false);
    const s = fireSlot({ agent_kind: "x", slot_source: "manual" }, deps);
    releaseSlot({ slotId: s.slot_id, status: "completed", exitCode: 0 }, deps);
    expect(releaseSlot({ slotId: s.slot_id, status: "failed", exitCode: 1 }, deps)).toBe(false); // 二重 release 不可
  });

  it("role 省略 → null", () => {
    const deps = mockDeps();
    const s = fireSlot({ agent_kind: "x", slot_source: "manual" }, deps);
    expect(s.role).toBeNull();
  });
});

describe("U-SLOT-003 listActiveSlots / listStaleSlots", () => {
  it("active = running かつ未 release のみ", () => {
    const deps = mockDeps();
    const a = fireSlot({ agent_kind: "a", slot_source: "manual" }, deps);
    fireSlot({ agent_kind: "b", slot_source: "manual" }, deps);
    releaseSlot({ slotId: a.slot_id, status: "completed", exitCode: 0 }, deps);
    const active = listActiveSlots(deps);
    expect(active).toHaveLength(1);
    expect(active[0].agent_kind).toBe("b");
  });

  it("stale = active かつ fired_at が閾値超のみ", () => {
    const deps = mockDeps();
    fireSlot({ agent_kind: "old", slot_source: "manual" }, deps); // fired 00:00
    deps.setNow("2026-06-04T00:03:00.000Z");
    fireSlot({ agent_kind: "fresh", slot_source: "manual" }, deps); // fired 00:03
    deps.setNow("2026-06-04T00:07:00.000Z"); // now: old=7分, fresh=4分
    const stale = listStaleSlots(deps, 5);
    expect(stale).toHaveLength(1);
    expect(stale[0].agent_kind).toBe("old");
  });
});

describe("U-SLOT-007 sweepStaleGuardSlots (SessionStart self-heal)", () => {
  it("セッション末尾の dangling guard slot (閾値超) を cancelled へ失効し件数を返す", () => {
    const deps = mockDeps();
    fireSlot({ agent_kind: "pmo-sonnet", slot_source: "agent_guard" }, deps); // fired 00:00, 未 release
    deps.setNow("2026-06-04T00:10:00.000Z"); // 10 分後の新セッション開始
    expect(sweepStaleGuardSlots(deps, 5)).toBe(1);
    const after = loadSlots(deps)[0];
    expect(after.status).toBe("cancelled");
    expect(after.released_at).toBe("2026-06-04T00:10:00.000Z");
    expect(listActiveSlots(deps)).toHaveLength(0); // doctor の stale warn が消える
  });

  it("閾値内の guard slot / 非 guard slot / 既 release は失効しない", () => {
    const deps = mockDeps();
    fireSlot({ agent_kind: "fresh", slot_source: "agent_guard" }, deps); // fired 00:00
    fireSlot({ agent_kind: "team", slot_source: "team_runner" }, deps); // 非 guard
    deps.setNow("2026-06-04T00:03:00.000Z"); // 3 分後 (閾値 5 未満)
    expect(sweepStaleGuardSlots(deps, 5)).toBe(0);
    expect(listActiveSlots(deps)).toHaveLength(2);
  });

  it("対象なし → 0 / 冪等 (二度目は 0)", () => {
    const deps = mockDeps();
    fireSlot({ agent_kind: "old", slot_source: "agent_guard" }, deps);
    deps.setNow("2026-06-04T00:10:00.000Z");
    expect(sweepStaleGuardSlots(deps, 5)).toBe(1);
    expect(sweepStaleGuardSlots(deps, 5)).toBe(0); // 既失効は再失効しない
  });
});

describe("U-SLOT-008 releaseOldestGuardSlot (SubagentStop 実時間 release)", () => {
  it("最古の running guard slot を completed で release し active 数を 1 減らす", () => {
    const deps = mockDeps();
    fireSlot({ agent_kind: "first", slot_source: "agent_guard" }, deps); // fired 00:00
    deps.setNow("2026-06-04T00:01:00.000Z");
    fireSlot({ agent_kind: "second", slot_source: "agent_guard" }, deps); // fired 00:01
    deps.setNow("2026-06-04T00:02:00.000Z");
    const released = releaseOldestGuardSlot(deps);
    expect(released?.agent_kind).toBe("first"); // 最古から閉じる (FIFO)
    expect(released?.status).toBe("completed"); // 正常終了 (cancelled でない)
    expect(released?.released_at).toBe("2026-06-04T00:02:00.000Z");
    const active = listActiveSlots(deps);
    expect(active).toHaveLength(1);
    expect(active[0].agent_kind).toBe("second");
  });

  it("agent_guard でない slot は対象外 / 対象なし → null (idempotent)", () => {
    const deps = mockDeps();
    fireSlot({ agent_kind: "team", slot_source: "team_runner" }, deps);
    expect(releaseOldestGuardSlot(deps)).toBeNull(); // guard slot 無し
    const g = fireSlot({ agent_kind: "g", slot_source: "agent_guard" }, deps);
    expect(releaseOldestGuardSlot(deps)?.slot_id).toBe(g.slot_id);
    expect(releaseOldestGuardSlot(deps)).toBeNull(); // 既に release 済 → null
  });

  it("SubagentStop n 回 = active を n 件閉じても count は厳密 (個体同定不要)", () => {
    const deps = mockDeps();
    for (let i = 0; i < 3; i++) fireSlot({ agent_kind: `g${i}`, slot_source: "agent_guard" }, deps);
    expect(listActiveSlots(deps)).toHaveLength(3);
    releaseOldestGuardSlot(deps);
    releaseOldestGuardSlot(deps);
    const active = listActiveSlots(deps);
    expect(active).toHaveLength(1); // 3 fire - 2 stop = 1 active (count 厳密)
    expect(active[0].agent_kind).toBe("g2"); // FIFO: 最古 g0/g1 が閉じ最若 g2 が残る (LIFO/random 排除)
  });
});

describe("U-SLOT-004 peakParallel", () => {
  function slot(over: Partial<Slot>): Slot {
    return {
      slot_id: "s",
      agent_kind: "x",
      role: null,
      slot_source: "manual",
      fired_at: "2026-06-04T00:00:00.000Z",
      released_at: null,
      status: "running",
      exit_code: null,
      ...over,
    };
  }

  it("重なる 3 slot → peak 3 / 重ならない → peak 1", () => {
    const overlap = [
      slot({ fired_at: "2026-06-04T00:00:00.000Z", released_at: "2026-06-04T00:10:00.000Z" }),
      slot({ fired_at: "2026-06-04T00:02:00.000Z", released_at: "2026-06-04T00:08:00.000Z" }),
      slot({ fired_at: "2026-06-04T00:04:00.000Z", released_at: "2026-06-04T00:06:00.000Z" }),
    ];
    expect(peakParallel(overlap)).toBe(3);
    const serial = [
      slot({ fired_at: "2026-06-04T00:00:00.000Z", released_at: "2026-06-04T00:01:00.000Z" }),
      slot({ fired_at: "2026-06-04T00:02:00.000Z", released_at: "2026-06-04T00:03:00.000Z" }),
    ];
    expect(peakParallel(serial)).toBe(1);
  });

  it("released_at=null は実行中として peak に算入", () => {
    const running = [
      slot({ fired_at: "2026-06-04T00:00:00.000Z", released_at: null }),
      slot({ fired_at: "2026-06-04T00:01:00.000Z", released_at: null }),
    ];
    expect(peakParallel(running)).toBe(2);
  });
});

describe("U-SLOT-005 exceedsParallelLimit", () => {
  it("active < max → false / active >= max → true", () => {
    const deps = mockDeps();
    for (let i = 0; i < DEFAULT_MAX_PARALLEL - 1; i++) {
      fireSlot({ agent_kind: `a${i}`, slot_source: "manual" }, deps);
    }
    expect(exceedsParallelLimit(deps)).toBe(false);
    fireSlot({ agent_kind: "last", slot_source: "manual" }, deps);
    expect(exceedsParallelLimit(deps)).toBe(true);
    expect(exceedsParallelLimit(deps, 100)).toBe(false); // max override
  });
});

describe("U-SLOT-006 recordGuardFire", () => {
  it("active < max → exceeded=false / active == max (上限到達) → exceeded=true (>= 統一)", () => {
    const deps = mockDeps();
    let last = { activeCount: 0, exceeded: false };
    for (let i = 0; i < DEFAULT_MAX_PARALLEL - 1; i++) {
      last = recordGuardFire({ agentKind: `pmo-sonnet-${i}` }, deps);
    }
    expect(last.exceeded).toBe(false); // active = max-1
    last = recordGuardFire({ agentKind: "at-limit" }, deps); // active = max
    expect(last.activeCount).toBe(DEFAULT_MAX_PARALLEL);
    expect(last.exceeded).toBe(true);
  });

  it("stale な agent_guard slot は自動失効し active から外れる (持続汚染防止)", () => {
    const deps = mockDeps();
    recordGuardFire({ agentKind: "old", max: DEFAULT_MAX_PARALLEL, staleMinutes: 5 }, deps); // fired 00:00
    deps.setNow("2026-06-04T00:10:00.000Z"); // 10 分後 = stale
    const r = recordGuardFire(
      { agentKind: "fresh", max: DEFAULT_MAX_PARALLEL, staleMinutes: 5 },
      deps,
    );
    // old は cancelled、fresh のみ active。
    expect(r.activeCount).toBe(1);
    const slots = loadSlots(deps);
    expect(slots.find((s) => s.agent_kind === "old")?.status).toBe("cancelled");
  });
});

describe("U-FR-L1-46 resolveRosterCapability", () => {
  it("role/capability の完全一致から model_class と evidence を返す", () => {
    const result = resolveRosterCapability({
      role: "TL",
      requested_capability: "gate-review",
      slot_source: "team_runner",
      roster_snapshot: [
        {
          role: "tl",
          capability: ["gate-review", "design-freeze"],
          model_class: "frontier",
          slot_source: "team_runner",
          evidence_path: ".claude/agents/pdm-tech-innovation.md",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.capability).toBe("gate-review");
    expect(result.model_class).toBe("frontier");
    expect(result.evidence_path).toBe(".claude/agents/pdm-tech-innovation.md");
  });

  it("未登録 capability は捏造せず missing-capability finding を返す", () => {
    const result = resolveRosterCapability({
      role: "qa",
      requested_capability: "payment-review",
      roster_snapshot: [{ role: "qa", capability: "test-design", model_class: "codex" }],
    });
    expect(result.ok).toBe(false);
    expect(result.capability).toBeUndefined();
    expect(result.findings).toEqual([
      {
        code: "missing-capability",
        severity: "error",
        message: "qa cannot resolve payment-review",
        evidence_path: "",
      },
    ]);
  });
});

describe("U-SLOT-009 nodeAgentSlotsDeps atomic write", () => {
  it("round-trips state through the real fs deps and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-slots-"));
    try {
      const deps = nodeAgentSlotsDeps(dir);
      const a = fireSlot({ agent_kind: "pmo-sonnet", slot_source: "agent_guard" }, deps);
      const b = fireSlot({ agent_kind: "codex-se", slot_source: "team_runner" }, deps);
      releaseSlot({ slotId: a.slot_id, status: "completed", exitCode: 0 }, deps);
      releaseSlot({ slotId: b.slot_id, status: "failed", exitCode: 1 }, deps);

      const stateDir = join(dir, ".ut-tdd", "state");
      const onDisk = JSON.parse(readFileSync(join(stateDir, "agent-slots.json"), "utf8")) as Slot[];
      expect(onDisk).toHaveLength(2);
      expect(onDisk.map((s) => s.status)).toEqual(["completed", "failed"]);
      // The atomic-write temp files (`*.tmp-<pid>-<seq>`) must be renamed/cleaned, never leaked.
      expect(readdirSync(stateDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
