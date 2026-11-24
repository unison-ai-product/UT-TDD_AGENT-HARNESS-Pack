import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  onPostToolUse,
  onSessionStart,
  onStop,
  parseSessionEvents,
  recordEvent,
  type SessionEvent,
  type SessionHookInput,
  type SessionLogDeps,
  sanitize,
  summarize,
} from "../src/runtime/session-log.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";
import { expectPlanFreeSessionProjection } from "./support/planret-s4-projection-oracles.ts";
import { removeTestTree } from "./support/temp-tree.ts";

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
    ...over,
  };
}

const sessionPath = (sid: string) => join("/repo", ".ut-tdd", "logs", "session", `${sid}.jsonl`);

describe("session-log event lifecycle (U-SLOG)", () => {
  it("U-SLOG-002: recordEvent は正常 append / 不正でも throw せず (fail-open)", () => {
    const deps = mockDeps();
    const ev: SessionEvent = {
      ts: "T1",
      session_id: "s1",
      plan_id: null,
      event_type: "tool_use",
      target: "src/a.ts",
    };
    recordEvent(ev, deps);
    expect(deps.files.get(sessionPath("s1"))).toContain('"plan_id":null');

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

  it("U-SLOG-005: onSessionStart は session_start を append し常に 0 (fail-open)", () => {
    const deps = mockDeps();
    expect(onSessionStart({ session_id: "s1" }, deps)).toBe(0);
    expect(deps.files.get(sessionPath("s1"))).toContain('"event_type":"session_start"');
    expect(deps.files.get(sessionPath("s1"))).toContain('"plan_id":null');

    const throwing = mockDeps({
      appendLine: () => {
        throw new Error("io");
      },
    });
    expect(onSessionStart({ session_id: "s1" }, throwing)).toBe(0); // fail-open
  });

  it("U-SLOG-006b: onPostToolUse の git commit は headCommit hash を commit event target に載せる (gap③)", () => {
    const deps = mockDeps({ headCommit: () => "deadbee" });
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
    onPostToolUse(input, deps2);
    const log2 = deps2.files.get(sessionPath("s1")) ?? "";
    expect(log2).toContain('"event_type":"commit"');
    expect(log2).not.toContain('"target"');

    const codex = mockDeps({ headCommit: () => "codex123" });
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

  // Windows PowerShell shell events are captured in the session JSONL.
  it("U-SLOG-013: PowerShell tool_use は session jsonl へ記録され、git commit は commit event になる", () => {
    const deps = mockDeps({ headCommit: () => "ps12345" });
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
        expect(expectPlanFreeSessionProjection(db, "ps-projection-session")).toEqual([null, null]);
      } finally {
        db.close();
      }
    } finally {
      removeTestTree(root);
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
      "docs/governance/harness/retirement/a-very-long-descriptive-filename-that-exceeds-the-legacy-120-char-summary-cap-on-its-own.md";
    expect(longPath.length).toBeGreaterThan(120);
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
