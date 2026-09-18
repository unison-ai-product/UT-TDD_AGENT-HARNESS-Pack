import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activePlanStale,
  activePlanUpdatedAt,
  compressPlanDigest,
  onPostToolUse,
  onSessionStart,
  onStop,
  type PlanDigest,
  parseSessionEvents,
  recordEvent,
  resolveActivePlan,
  type SessionEvent,
  type SessionHookInput,
  type SessionLogDeps,
  sanitize,
  setActivePlan,
  summarize,
} from "../src/runtime/session-log.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";

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
    ...over,
  };
}

const statePath = join("/repo", ".ut-tdd", "state", "current-plan");
const sessionPath = (sid: string) => join("/repo", ".ut-tdd", "logs", "session", `${sid}.jsonl`);

describe("session-log (PLAN-L7-01 add-impl / U-SLOG)", () => {
  it("U-SLOG-001: resolveActivePlan = state 優先 / branch fallback / 解決不能 null", () => {
    const withState = mockDeps({ currentBranch: () => "add/session-log" });
    withState.files.set(statePath, "PLAN-L7-01-session-log\n");
    expect(resolveActivePlan(withState)).toBe("PLAN-L7-01-session-log"); // state 優先

    const withBranch = mockDeps({ currentBranch: () => "add/session-log" });
    expect(resolveActivePlan(withBranch)).toBe("session-log"); // branch fallback

    const unresolved = mockDeps({ currentBranch: () => "main" });
    expect(resolveActivePlan(unresolved)).toBeNull(); // 解決不能
  });

  it("U-SLOG-002: recordEvent は正常 append / 不正でも throw せず (fail-open)", () => {
    const deps = mockDeps();
    const ev: SessionEvent = {
      ts: "T1",
      session_id: "s1",
      plan_id: "PLAN-A",
      event_type: "tool_use",
      target: "src/a.ts",
    };
    recordEvent(ev, deps);
    expect(deps.files.get(sessionPath("s1"))).toContain('"plan_id":"PLAN-A"');

    const throwing = mockDeps({
      appendLine: () => {
        throw new Error("disk full");
      },
    });
    expect(() => recordEvent(ev, throwing)).not.toThrow(); // fail-open
  });

  it("U-SLOG-002b: sanitize は secret をマスクし 120 文字へ truncate", () => {
    expect(sanitize("Bash token=abcdef123")).toBe("Bash token=***");
    expect(sanitize("x".repeat(200)).length).toBeLessThanOrEqual(120);
    expect(sanitize(undefined)).toBe("");
    expect(
      summarize({
        tool_name: "Bash",
        tool_input: { command: "bun run src/cli.ts skill suggest --plan PLAN-L7-201 --json" },
      }),
    ).toBe("Bash (skill)");
  });

  it("U-SLOG-003: compressPlanDigest 集計 + idempotent + updated_at 巻き戻りなし + failures ts dedupe", () => {
    const evs: SessionEvent[] = [
      {
        ts: "2026-06-02T00:00:01Z",
        session_id: "s1",
        plan_id: "P",
        event_type: "tool_use",
        target: "src/a.ts",
      },
      {
        ts: "2026-06-02T00:00:02Z",
        session_id: "s1",
        plan_id: "P",
        event_type: "commit",
        target: "abc123",
      },
      { ts: "2026-06-02T00:00:03Z", session_id: "s1", plan_id: "Q", event_type: "tool_use" }, // 別 plan (ts=03) は planId="P" 集計対象外
    ];
    const d1 = compressPlanDigest(evs, "P");
    expect(d1.event_counts.tool_use).toBe(1);

    // I-1: 同一バッチ・同一 session の複数 event を正しく集計 (prev なし → 3 件)
    const multi: SessionEvent[] = [0, 1, 2].map((i) => ({
      ts: `2026-06-02T00:00:0${i}Z`,
      session_id: "s1",
      plan_id: "P",
      event_type: "tool_use",
    }));
    expect(compressPlanDigest(multi, "P").event_counts.tool_use).toBe(3);
    expect(d1.event_counts.commit).toBe(1);
    expect(d1.files_touched).toEqual(["src/a.ts"]);
    expect(d1.commits).toEqual(["abc123"]);
    expect(d1.sessions).toEqual(["s1"]);
    expect(d1.updated_at).toBe("2026-06-02T00:00:02Z");

    // idempotent: 同一 events を prev=d1 で再適用 → 不変
    const d2 = compressPlanDigest(evs, "P", d1);
    expect(d2).toEqual(d1);

    // updated_at 巻き戻りなし (prev が新しい)
    const dRoll = compressPlanDigest(
      [{ ts: "2026-06-02T00:00:01Z", session_id: "s9", plan_id: "P", event_type: "tool_use" }],
      "P",
      { ...d1, updated_at: "2030-01-01T00:00:00Z" },
    );
    expect(dRoll.updated_at).toBe("2030-01-01T00:00:00Z");

    // failures ts dedupe (同一 ts → 1 件)
    const errs: SessionEvent[] = [
      {
        ts: "TE",
        session_id: "s2",
        plan_id: "P",
        event_type: "tool_use",
        outcome: "error",
        target: "x",
      },
      {
        ts: "TE",
        session_id: "s2",
        plan_id: "P",
        event_type: "tool_use",
        outcome: "error",
        target: "y",
      },
    ];
    expect(compressPlanDigest(errs, "P").failures.length).toBe(1);
  });

  it("U-SLOG-008: event 単位 high-watermark — 再 summarize された session の増分を計上 (PLAN-L7-80)", () => {
    const firstStop: SessionEvent[] = [
      {
        ts: "2026-06-19T00:00:01Z",
        session_id: "s1",
        plan_id: "P",
        event_type: "tool_use",
        target: "src/a.ts",
      },
      {
        ts: "2026-06-19T00:00:02Z",
        session_id: "s1",
        plan_id: "P",
        event_type: "tool_use",
        target: "src/b.ts",
      },
    ];
    const d1 = compressPlanDigest(firstStop, "P");
    expect(d1.event_counts.tool_use).toBe(2);
    expect(d1.session_watermarks).toEqual({ s1: 2 });

    // 同一 session が 2 件 append された状態で再び Stop (ログが伸びた)。
    const secondStop: SessionEvent[] = [
      ...firstStop,
      {
        ts: "2026-06-19T00:00:03Z",
        session_id: "s1",
        plan_id: "P",
        event_type: "tool_use",
        target: "src/c.ts",
      },
      {
        ts: "2026-06-19T00:00:04Z",
        session_id: "s1",
        plan_id: "P",
        event_type: "commit",
        target: "deadbeef",
      },
    ];
    const d2 = compressPlanDigest(secondStop, "P", d1);
    // 増分 (ts=03,04) を計上。旧 session-fold バグなら 2 のまま (過少計上)。
    expect(d2.event_counts.tool_use).toBe(3);
    expect(d2.event_counts.commit).toBe(1);
    expect(d2.session_watermarks).toEqual({ s1: 4 });
    expect(d2.files_touched).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(d2.commits).toEqual(["deadbeef"]);

    // 増分なしの 3 回目 = idempotent (二重計上しない)。
    const d3 = compressPlanDigest(secondStop, "P", d2);
    expect(d3.event_counts.tool_use).toBe(3);
    expect(d3.event_counts.commit).toBe(1);

    // migration: pre-L7-80 digest (session_watermarks 無し / session 単位 fold) は
    // 既計上分 (ts <= updated_at) を再計上せず、新規分のみ計上する。
    const legacy: PlanDigest = {
      plan_id: "P",
      sessions: ["s1"],
      event_counts: { tool_use: 2 },
      files_touched: ["src/a.ts", "src/b.ts"],
      commits: [],
      failures: [],
      updated_at: "2026-06-19T00:00:02Z",
    };
    const migrated = compressPlanDigest(secondStop, "P", legacy);
    expect(migrated.event_counts.tool_use).toBe(3); // 2 legacy + 1 new (ts=03)、4 でない
    expect(migrated.event_counts.commit).toBe(1); // new (ts=04)
    expect(migrated.session_watermarks).toEqual({ s1: 4 });
  });

  it("U-SLOG-004: onStop は plan 別 digest 生成 / plan_id=null のみは書かない / 常に 0", () => {
    const deps = mockDeps();
    deps.files.set(
      sessionPath("s1"),
      `${JSON.stringify({ ts: "T1", session_id: "s1", plan_id: "PLAN-A", event_type: "tool_use", target: "src/a.ts" })}\n`,
    );
    expect(onStop({ session_id: "s1" }, deps)).toBe(0);
    const digestKey = [...deps.files.keys()].find(
      (k) => k.includes("PLAN-A") && k.includes("digest"),
    );
    expect(digestKey).toBeDefined();
    expect(JSON.parse(deps.files.get(digestKey as string) as string).plan_id).toBe("PLAN-A");

    const depsExplicit = mockDeps();
    depsExplicit.files.set(
      sessionPath("s3"),
      `${JSON.stringify({ ts: "T1", session_id: "s3", plan_id: "PLAN-A", event_type: "tool_use" })}\n`,
    );
    expect(onStop({ session_id: "s3", plan_id: "PLAN-A" }, depsExplicit)).toBe(0);
    const explicitDigestKey = [...depsExplicit.files.keys()].find(
      (k) => k.includes("PLAN-A") && k.includes("digest"),
    );
    const explicitDigest = JSON.parse(depsExplicit.files.get(explicitDigestKey as string) ?? "{}");
    expect(explicitDigest.event_counts.session_end).toBe(1);

    // plan_id=null のみ → digest を書かない
    const depsNull = mockDeps();
    depsNull.files.set(
      sessionPath("s2"),
      `${JSON.stringify({ ts: "T1", session_id: "s2", plan_id: null, event_type: "tool_use" })}\n`,
    );
    onStop({ session_id: "s2" }, depsNull);
    expect([...depsNull.files.keys()].some((k) => k.includes("digest"))).toBe(false);
  });

  it("U-SLOG-005: onSessionStart は session_start を append し常に 0 (fail-open)", () => {
    const deps = mockDeps({ currentBranch: () => "add/session-log" });
    expect(onSessionStart({ session_id: "s1" }, deps)).toBe(0);
    expect(deps.files.get(sessionPath("s1"))).toContain('"event_type":"session_start"');
    expect(deps.files.get(sessionPath("s1"))).toContain('"plan_id":"session-log"');

    const throwing = mockDeps({
      appendLine: () => {
        throw new Error("io");
      },
    });
    expect(onSessionStart({ session_id: "s1" }, throwing)).toBe(0); // fail-open
  });

  // U-SLOG-006: IMP-078 gap② active-plan marker stale + gap③ commit hash 捕捉。
  it("U-SLOG-006: setActivePlan は updated_at を 2 行目に刻み activePlanStale が検知 (1 行目は不変)", () => {
    const deps = mockDeps();
    setActivePlan("PLAN-L7-16-module-drift", deps);
    // 1 行目 = plan_id (後方互換) / 2 行目 = updated_at
    expect(resolveActivePlan(deps)).toBe("PLAN-L7-16-module-drift");
    expect(activePlanUpdatedAt(deps)).toBe("2026-06-02T00:00:00.000Z");
    // now が marker と同時刻 → not stale / 大きく進める → stale
    expect(activePlanStale(deps, deps.now())).toBe(false);
    expect(activePlanStale(deps, "2030-01-01T00:00:00Z", 24)).toBe(true);
    // 旧形式 (timestamp 無し 1 行) → 判定不能 = false (後方互換、stale 扱いにしない)
    deps.files.set(statePath, "PLAN-OLD");
    expect(activePlanUpdatedAt(deps)).toBeNull();
    expect(activePlanStale(deps, "2030-01-01T00:00:00Z")).toBe(false);
  });

  it("U-SLOG-006b: onPostToolUse の git commit は headCommit hash を commit event target に載せる (gap③)", () => {
    const deps = mockDeps({ headCommit: () => "deadbee" });
    deps.files.set(statePath, "PLAN-L7-16-module-drift");
    const input: SessionHookInput = {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "git commit -m x" },
    };
    expect(onPostToolUse(input, deps)).toBe(0);
    const log = deps.files.get(sessionPath("s1")) ?? "";
    expect(log).toContain('"event_type":"commit"');
    expect(log).toContain('"target":"deadbee"');
    // headCommit 未提供なら target 無し (旧挙動、commits 汚染なし)
    const deps2 = mockDeps();
    deps2.files.set(statePath, "PLAN-L7-16-module-drift");
    onPostToolUse(input, deps2);
    const log2 = deps2.files.get(sessionPath("s1")) ?? "";
    expect(log2).toContain('"event_type":"commit"');
    expect(log2).not.toContain('"target"');

    const codex = mockDeps({ headCommit: () => "codex123" });
    codex.files.set(statePath, "PLAN-L6-68-memory-telemetry-lifecycle-contract");
    onPostToolUse(
      {
        session_id: "codex-session",
        tool_name: "exec_command",
        tool_input: { cmd: "git commit -m x" },
      },
      codex,
    );
    const codexLog = codex.files.get(sessionPath("codex-session")) ?? "";
    expect(codexLog).toContain('"event_type":"commit"');
    expect(codexLog).toContain('"outcome":"ok"');

    const localShell = mockDeps({ headCommit: () => "local123" });
    localShell.files.set(statePath, "PLAN-L6-68-memory-telemetry-lifecycle-contract");
    onPostToolUse(
      {
        session_id: "local-shell-session",
        tool_name: "local_shell",
        tool_input: { cmd: "git commit -m x" },
      },
      localShell,
    );
    expect(localShell.files.get(sessionPath("local-shell-session"))).toContain(
      '"event_type":"commit"',
    );
  });

  // PLAN-RECOVERY-13 / issue #86: Windows ネイティブの主シェルツール PowerShell を
  // shell tool として捕捉する (session jsonl に tool_use / commit が乗る)。
  it("U-SLOG-013: PowerShell tool_use は session jsonl へ記録され、git commit は commit event になる", () => {
    const deps = mockDeps({ headCommit: () => "ps12345" });
    deps.files.set(statePath, "PLAN-RECOVERY-13-powershell-session-log-visibility");
    onPostToolUse(
      {
        session_id: "ps-session",
        tool_name: "PowerShell",
        tool_input: { command: "bun run typecheck" },
      },
      deps,
    );
    const log = deps.files.get(sessionPath("ps-session")) ?? "";
    expect(log).toContain('"event_type":"tool_use"');
    expect(log).toContain('"tool":"PowerShell"');
    expect(log).toContain("PowerShell (tsc)");

    onPostToolUse(
      {
        session_id: "ps-session",
        tool_name: "PowerShell",
        tool_input: { command: "git commit -m x" },
      },
      deps,
    );
    const log2 = deps.files.get(sessionPath("ps-session")) ?? "";
    expect(log2).toContain('"event_type":"commit"');
    expect(log2).toContain('"target":"ps12345"');
  });

  it("U-SLOG-014: summarize は PowerShell を Bash と同様に verb 分類し、引数を残さない", () => {
    expect(
      summarize({ tool_name: "PowerShell", tool_input: { command: "bun x vitest run tests/x" } }),
    ).toBe("PowerShell (vitest)");
    expect(
      summarize({
        tool_name: "PowerShell",
        tool_input: { command: "Get-Process -Name secret-arg" },
      }),
    ).toBe("PowerShell (powershell)");
    expect(summarize({ tool_name: "PowerShell", tool_input: {} })).toBe("PowerShell (powershell)");
  });

  it("U-SLOG-015: PowerShell tool_use は session jsonl から hook_events と test_runs へ投影される", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-powershell-session-projection-"));
    try {
      const deps = mockDeps({ repoRoot: root });
      deps.files.set(
        join(root, ".ut-tdd", "state", "current-plan"),
        "PLAN-RECOVERY-13-powershell-session-log-visibility",
      );
      onPostToolUse(
        {
          session_id: "ps-projection-session",
          tool_name: "PowerShell",
          tool_input: { command: "bun run typecheck" },
        },
        deps,
      );

      const sessionDir = join(root, ".ut-tdd", "logs", "session");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "ps-projection-session.jsonl"),
        deps.files.get(join(sessionDir, "ps-projection-session.jsonl")) ?? "",
        "utf8",
      );

      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        rebuildHarnessDb({
          repoRoot: root,
          db,
          relationGraph: { nodes: [], edges: [], verificationProfiles: [], findings: [] },
          documentExports: {
            document_export_runs: [],
            document_export_datasets: [],
            document_export_artifacts: [],
            findings: [],
            actionsTaken: [],
            ok: true,
          },
        });
        expect(
          db
            .prepare("SELECT hook_name, event_type FROM hook_events WHERE session_id = ?")
            .get("ps-projection-session"),
        ).toMatchObject({ hook_name: "PostToolUse", event_type: "tool_use" });
        expect(
          db
            .prepare("SELECT command, shell, status FROM test_runs WHERE session_id = ?")
            .get("ps-projection-session"),
        ).toMatchObject({ command: "PowerShell (tsc)", shell: "powershell", status: "passed" });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PLAN-RECOVERY-05 item 2: Bash の検証 verb を target に分類して残す (引数は残さない)。
  it("U-SLOG-007: summarize classifies Bash into a verb token; unclassified stays (bash)", () => {
    expect(
      summarize({ tool_name: "Bash", tool_input: { command: "bun run vitest run tests/x" } }),
    ).toBe("Bash (vitest)");
    expect(summarize({ tool_name: "Bash", tool_input: { command: "bun run typecheck" } })).toBe(
      "Bash (tsc)",
    );
    expect(summarize({ tool_name: "Bash", tool_input: { command: "git status" } })).toBe(
      "Bash (bash)",
    );
    // file 系ツールは従来どおり path のみ。
    expect(summarize({ tool_name: "Write", tool_input: { file_path: "src/a.ts" } })).toBe(
      "Write src/a.ts",
    );
  });

  // PLAN-L7-398 (システム全体監査、2026-07-08 実発見): work-guard の sessionTouchedFiles は
  // この target 文字列をそのまま突合キーに使う。120 文字 truncate されると深い repo path +
  // 長い説明的ファイル名 (本 repo の PLAN 命名規約) で実 path と不一致になり、自分自身の
  // 正当な編集が foreign-uncommitted と誤検知される。path を伴う target は truncate しない。
  it("U-SLOG-009: summarize does not truncate long file-path targets (work-guard round-trip fence)", () => {
    const longPath =
      "docs/plans/PLAN-L7-999-a-very-long-descriptive-plan-filename-that-exceeds-the-legacy-120-char-summary-cap-on-its-own.md";
    const result = summarize({ tool_name: "Write", tool_input: { file_path: longPath } });
    expect(result).toBe(`Write ${longPath}`);
    expect(result).not.toContain("…");
    // secret-like 値が path に紛れ込んでも mask は維持する (truncate 無しでも漏洩防止は生きる)。
    const secretish = "docs/plans/token=abcdef123.md";
    expect(summarize({ tool_name: "Write", tool_input: { file_path: secretish } })).toBe(
      "Write docs/plans/token=***",
    );
  });

  it("U-SLOG-007b: onPostToolUse persists the classified verb (no argument leak)", () => {
    const deps = mockDeps();
    deps.files.set(statePath, "PLAN-RECOVERY-05");
    onPostToolUse(
      {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "bun run vitest run tests/secret.ts" },
      },
      deps,
    );
    const log = deps.files.get(sessionPath("s1")) ?? "";
    expect(log).toContain('"target":"Bash (vitest)"');
    expect(log).not.toContain("secret.ts"); // 引数は残さない
  });

  it("U-MEMORY-005 / IT-FLC-06: records Claude/Codex memory writes and emits one idempotent Stop nudge", () => {
    const deps = mockDeps();
    deps.files.set(statePath, "PLAN-L6-68-memory-telemetry-lifecycle-contract");
    onPostToolUse(
      {
        session_id: "memory-session",
        tool_name: "Write",
        tool_input: { file_path: ".ut-tdd/memory/project-example.md" },
        tool_response: { outcome: "ok" },
      },
      deps,
    );
    expect(deps.files.get(sessionPath("memory-session"))).toContain('"event_type":"memory_write"');

    const codexMemory = mockDeps();
    codexMemory.files.set(statePath, "PLAN-L6-68-memory-telemetry-lifecycle-contract");
    onPostToolUse(
      {
        session_id: "codex-memory-session",
        tool_name: "exec_command",
        tool_input: { cmd: "bun src/cli.ts memory add --title example --body-file example.md" },
      },
      codexMemory,
    );
    expect(codexMemory.files.get(sessionPath("codex-memory-session"))).toContain(
      '"event_type":"memory_write"',
    );

    const warnings: string[] = [];
    const missing = mockDeps({ warn: (message) => warnings.push(message) });
    missing.files.set(statePath, "PLAN-L6-68-memory-telemetry-lifecycle-contract");
    missing.files.set(
      sessionPath("missing-memory"),
      `${JSON.stringify({
        ts: "2026-07-10T00:00:00Z",
        session_id: "missing-memory",
        plan_id: "PLAN-L6-68-memory-telemetry-lifecycle-contract",
        event_type: "commit",
        outcome: "ok",
      })}\n`,
    );
    expect(onStop({ session_id: "missing-memory" }, missing)).toBe(0);
    expect(missing.files.get(sessionPath("missing-memory"))).toContain(
      '"event_type":"memory_promotion_missed"',
    );
    expect(warnings).toHaveLength(1);

    expect(onStop({ session_id: "missing-memory" }, missing)).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(
      (missing.files.get(sessionPath("missing-memory")) ?? "").match(
        /"event_type":"memory_promotion_missed"/g,
      ),
    ).toHaveLength(1);
  });

  it("parseSessionEvents parses jsonl and skips corrupted lines (fail-open)", () => {
    const raw = `${JSON.stringify({ ts: "1", session_id: "s", plan_id: null, event_type: "tool_use", target: "a" })}\n{bad json\n\n${JSON.stringify({ ts: "2", session_id: "s", plan_id: null, event_type: "tool_use", target: "b" })}\n`;
    const events = parseSessionEvents(raw);
    expect(events.map((e) => e.target)).toEqual(["a", "b"]);
  });
});
