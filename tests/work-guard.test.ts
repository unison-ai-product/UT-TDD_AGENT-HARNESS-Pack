import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateWorkGuard,
  evaluateWorkGuardTargets,
  extractEditTargets,
  normalizeRepoRelative,
  resolveForeignEditOverride,
} from "../src/runtime/work-guard";

const hookRepoRoot = process.cwd();
const workGuardHook = join(hookRepoRoot, ".claude", "hooks", "work-guard.ts");

/** work-guard hook を temp repo の cwd で spawn する (win32 は System32 canonical な cmd 経由)。 */
function runWorkGuardHook(cwd: string, input: unknown) {
  const stdin = JSON.stringify(input);
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "bun", workGuardHook], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      input: stdin,
    });
  }
  return spawnSync("bun", [workGuardHook], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    input: stdin,
  });
}

describe("work guard (PLAN-L7-114) — 作業衝突ガードレール", () => {
  it("blocks editing an uncommitted file this session never touched (他ランタイムの in-flight)", () => {
    const result = evaluateWorkGuard({
      targetPath: "src/plan/lint.ts",
      uncommittedFiles: ["src/plan/lint.ts", "src/feedback/surface.ts"],
      sessionTouchedFiles: ["src/feedback/surface.ts"],
      bypass: false,
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toBe("foreign-uncommitted");
    expect(result.message).toContain("src/plan/lint.ts");
  });

  it("passes editing a file this session already touched (自分の作業の継続)", () => {
    const result = evaluateWorkGuard({
      targetPath: "src/feedback/surface.ts",
      uncommittedFiles: ["src/feedback/surface.ts"],
      sessionTouchedFiles: ["src/feedback/surface.ts"],
      bypass: false,
    });
    expect(result.decision).toBe("pass");
    expect(result.reason).toBe("clean-or-own");
  });

  it("passes editing a clean (committed) file not in the uncommitted set", () => {
    const result = evaluateWorkGuard({
      targetPath: "src/cli.ts",
      uncommittedFiles: ["src/plan/lint.ts"],
      sessionTouchedFiles: [],
      bypass: false,
    });
    expect(result.decision).toBe("pass");
  });

  it("passes a foreign uncommitted file only when override is set (+evidence)", () => {
    const base = {
      targetPath: "src/plan/lint.ts",
      uncommittedFiles: ["src/plan/lint.ts"],
      sessionTouchedFiles: [],
    };
    expect(evaluateWorkGuard({ ...base, bypass: false }).decision).toBe("block");
    expect(evaluateWorkGuard({ ...base, bypass: true }).decision).toBe("pass");
    expect(evaluateWorkGuard({ ...base, bypass: true }).reason).toBe("bypass");
  });

  it("passes when there is no target path (fail-open, not our concern)", () => {
    expect(
      evaluateWorkGuard({
        targetPath: "",
        uncommittedFiles: ["src/plan/lint.ts"],
        sessionTouchedFiles: [],
        bypass: false,
      }).decision,
    ).toBe("pass");
  });

  it("normalizes Windows absolute paths and backslashes to repo-relative", () => {
    const repoRoot = "C:\\Users\\dev\\UT-TDD-agent-harness";
    expect(
      normalizeRepoRelative("C:\\Users\\dev\\UT-TDD-agent-harness\\src\\plan\\lint.ts", repoRoot),
    ).toBe("src/plan/lint.ts");
    expect(normalizeRepoRelative("./src/feedback/surface.ts", repoRoot)).toBe(
      "src/feedback/surface.ts",
    );
    expect(normalizeRepoRelative("src/cli.ts", repoRoot)).toBe("src/cli.ts");
    // Regression: session-log target は "Write <abspath>" の tool 名プレフィックス付きで記録される。
    // repoRoot を部分一致で探さないと prefix で外れ、自分の touch を見落として全 uncommitted を誤 block する。
    expect(
      normalizeRepoRelative(
        "Write C:\\Users\\dev\\UT-TDD-agent-harness\\src\\runtime\\attempt-escalation.ts",
        repoRoot,
      ),
    ).toBe("src/runtime/attempt-escalation.ts");
  });

  it("blocks the real collision shape from this session (Codex's surface.ts vs my plan/lint.ts)", () => {
    // 実際に起きた衝突: Codex が触っていた src/plan/lint.ts を私が未 touch のまま編集しようとする。
    const repoRoot = "C:/repo";
    const target = normalizeRepoRelative("C:/repo/src/plan/lint.ts", repoRoot);
    const result = evaluateWorkGuard({
      targetPath: target,
      uncommittedFiles: ["src/plan/lint.ts", "tests/plan-lint.test.ts"],
      sessionTouchedFiles: ["CLAUDE.md", "AGENTS.md", "src/cli.ts"],
      bypass: false,
    });
    expect(result.decision).toBe("block");
  });

  it("blocks a multi-target preflight when any target is foreign-uncommitted", () => {
    const result = evaluateWorkGuardTargets({
      targetPaths: ["src/own.ts", "src/foreign.ts", "src/clean.ts"],
      uncommittedFiles: ["src/own.ts", "src/foreign.ts"],
      sessionTouchedFiles: ["src/own.ts"],
      bypass: false,
    });
    expect(result.decision).toBe("block");
    expect(result.blocked?.targetPath).toBe("src/foreign.ts");
  });

  it("passes a no-target preflight so hosted callers can dry-run safely", () => {
    const result = evaluateWorkGuardTargets({
      targetPaths: [],
      uncommittedFiles: ["src/foreign.ts"],
      sessionTouchedFiles: [],
      bypass: false,
    });
    expect(result.decision).toBe("pass");
    expect(result.reason).toBe("no-target");
  });
});

describe("extractEditTargets (PLAN-L7-139) — Codex apply_patch / Claude file_path 両対応", () => {
  it("Claude Edit/Write/MultiEdit の tool_input.file_path を返す", () => {
    expect(extractEditTargets({ file_path: "src/cli.ts" })).toEqual(["src/cli.ts"]);
  });

  it("tool_input.path (Codex write_file) を返す", () => {
    expect(extractEditTargets({ path: "src/x.ts" })).toEqual(["src/x.ts"]);
  });

  it("apply_patch の patch 本文から全ファイルパスを抽出する (複数ファイル: Update/Add/Delete)", () => {
    // 偽パリティ回帰: file_path を持たない apply_patch でガードが no-op しないことの substance test。
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ def x():",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+hello",
      "*** Delete File: src/c.ts",
      "*** End Patch",
    ].join("\n");
    expect([...extractEditTargets({ input: patch })].sort()).toEqual(
      ["src/a.ts", "src/b.ts", "src/c.ts"].sort(),
    );
  });

  it("apply_patch が command 配列形 ({command:['apply_patch', <patch>]}) でも抽出する", () => {
    const patch = "*** Begin Patch\n*** Update File: src/d.ts\n@@\n+x\n*** End Patch";
    expect(extractEditTargets({ command: ["apply_patch", patch] })).toEqual(["src/d.ts"]);
  });

  it("rename (Update File + Move to) の移動元・移動先を両方とも抽出する", () => {
    const patch =
      "*** Begin Patch\n*** Update File: old/x.ts\n*** Move to: new/x.ts\n*** End Patch";
    expect([...extractEditTargets({ input: patch })].sort()).toEqual(
      ["new/x.ts", "old/x.ts"].sort(),
    );
  });

  it("file_path がある時は content 本文の apply_patch 例文を誤抽出しない (false-block 防止)", () => {
    const docContent = "Example: *** Update File: docs/example.md\n+text";
    expect(extractEditTargets({ file_path: "docs/guide.md", content: docContent })).toEqual([
      "docs/guide.md",
    ]);
  });

  it("file_path も patch も無い入力は空配列 (no-target fail-open)", () => {
    expect(extractEditTargets({ command: "ls -la" })).toEqual([]);
    expect(extractEditTargets(null)).toEqual([]);
    expect(extractEditTargets("just a string")).toEqual([]);
    expect(extractEditTargets(undefined)).toEqual([]);
  });
});

describe("foreign-edit override resolution (PLAN-L7-114 correction)", () => {
  it("bypasses via env UT_TDD_ALLOW_FOREIGN_EDIT=1", () => {
    const r = resolveForeignEditOverride({ env: "1" });
    expect(r.bypass).toBe(true);
    expect(r.source).toBe("env");
  });

  it("bypasses via a marker file with a non-empty reason (agent-accessible)", () => {
    const r = resolveForeignEditOverride({
      markerReason: "completing Codex orphan-impl per review",
    });
    expect(r.bypass).toBe(true);
    expect(r.source).toBe("marker");
    expect(r.reason).toBe("completing Codex orphan-impl per review");
  });

  it("does NOT bypass on an empty/whitespace marker (no silent bypass without a reason)", () => {
    expect(resolveForeignEditOverride({ markerReason: "   \n" }).bypass).toBe(false);
    expect(resolveForeignEditOverride({ markerReason: null }).bypass).toBe(false);
    expect(resolveForeignEditOverride({}).source).toBe("none");
  });

  it("prefers env over marker as the source when both are present", () => {
    const r = resolveForeignEditOverride({ env: "1", markerReason: "marker reason" });
    expect(r.source).toBe("env");
  });
});

describe("work-guard hook marker is one-shot (stale marker は恒久バイパスしない)", () => {
  it("consumes the override marker after one foreign edit; the next identical edit re-blocks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-workguard-marker-"));
    try {
      // git repo + untracked foreign file = このセッションが触っていない uncommitted ファイル。
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      writeFileSync(join(cwd, "foreign.ts"), "export const x = 1;\n");
      const markerPath = join(cwd, ".ut-tdd", "state", "foreign-edit-override");
      mkdirSync(join(cwd, ".ut-tdd", "state"), { recursive: true });
      writeFileSync(markerPath, "completing Codex orphan-impl per review");

      const input = { session_id: "s-test", tool_input: { file_path: "foreign.ts" } };

      // 1回目: marker により foreign 編集を許可 (exit 0) し、marker を消費する。
      const first = runWorkGuardHook(cwd, input);
      expect(first.status).toBe(0);
      expect(existsSync(markerPath)).toBe(false); // one-shot 消費
      // audit 証跡は残す (silent bypass を許さない)。
      const audit = readFileSync(
        join(cwd, ".ut-tdd", "logs", "foreign-edit-overrides.jsonl"),
        "utf8",
      );
      expect(audit).toContain("completing Codex orphan-impl per review");

      // 2回目: marker は消費済み → bypass 無し → 同じ foreign 編集が block される (exit 2)。
      const second = runWorkGuardHook(cwd, input);
      expect(second.status).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
