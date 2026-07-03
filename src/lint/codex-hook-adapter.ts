/**
 * codex-hook-adapter — repo-root `hooks.json` (Codex CLI orchestrator) が Claude
 * `.claude/settings.json` のガード hook と **同一 entrypoint** を、Codex の実 tool 名で配線して
 * いることを fail-close 検査する (PLAN-L7-139, orchestrator-rule parity)。
 *
 * 背景: Codex 0.128.0 は Claude 互換の hook 機構を持つ (`hooks.json`,
 * `PreToolUse`/`PostToolUse`/`SessionStart`/`Stop`, payload `tool_name`/`tool_input`/`file_path`,
 * `blockOnFailure`, `permissionDecision: deny`)。ただし **tool 名が Claude と異なる**ため、matcher の
 * 字面コピーは「hooks.json はあるが一度も発火しない偽パリティ」を生む (coverage≠substance)。実機
 * `codex.exe` 文字列で確定した写像:
 *   - 編集系: Claude `Edit|Write|MultiEdit` → Codex `apply_patch|write_file`
 *     (`apply_patch` は freeform で file_path を持たず、パスは patch 本文に埋まる。work-guard 側で抽出)
 *   - shell : Claude `Bash`               → Codex `exec_command|local_shell`
 *   - Codex に `SubagentStop` event は無い          → subagent-stop は Codex で真の N/A
 *   - `spawn_agent` 等の sub-agent ツール族は実在    → agent-guard 相当は「未ガードの deferred surface」
 *     (N/A ではない。cross-runtime review で是正)
 *
 * SSoT: 各ガードの entrypoint (どの TS スクリプトを呼ぶか) は project-hook.ts の `REQUIRED`
 * (Claude 側) と共有する。本 lint は Codex 側が「Claude と同じ entrypoint を、Codex の matcher で」
 * 宣言しているかを突合し、entrypoint がどちらかにしか無ければ `entrypoint_drift` として fail-close
 * する (Claude/Codex adapter が黙って分岐しない双方向健全性)。純関数 (analyze) + I/O loader 分離。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_REQUIRED } from "./codex-hook-adapter-policy";
import { REQUIRED as CLAUDE_REQUIRED, FORBIDDEN_PATH_RE } from "./project-hook";

export { CODEX_REQUIRED };

/** Codex で発火面を持つガードのパリティ要件。entrypoint は Claude `REQUIRED` と共有 (SSoT)。 */

/**
 * Claude のガード entrypoint のうち、Codex に **対応 event/面が存在しない** もの (真の N/A)。
 * codex.exe 0.128.0 実機の hook event は PreToolUse/PostToolUse/SessionStart/Stop/UserPromptSubmit のみで、
 * SubagentStop event は無い (バイナリ文字列で確認)。
 */
export const CODEX_NOT_APPLICABLE = [
  {
    entrypoint: "src/cli.ts hook subagent-stop",
    reason:
      "Codex に SubagentStop event が無い (codex.exe 0.128.0 の hook event は PreToolUse/PostToolUse/SessionStart/Stop/UserPromptSubmit のみ)",
  },
] as const;

/**
 * Codex に **面は実在するが本 PLAN ではまだガードしていない** surface (documented follow-up、N/A ではない)。
 *
 * 当初 agent-guard を「Codex に subagent 面が無い → N/A」と記していたが誤り。codex.exe 0.128.0 には
 * `spawn_agent` / `wait_agent` / `list_agents` / `close_agent` / `spawn_agents_on_csv` の sub-agent
 * ツール族が実在し ("This spawn_agent tool provides you access to sub-agents")、PreToolUse の tool_name
 * として観測できる (cross-runtime review Important で是正、バイナリ実機で確認)。Claude agent-guard
 * (subagent_type allowlist + model family 一致) の Codex 版は spawn_agent の意味論 (model 継承 /
 * agent_role / canonical task_name) が異なり別設計を要するため、本 PLAN scope 外の follow-up とする。
 * 「面が無い」ではなく「面は在るが未ガード」であることを契約として残す。
 */
export const CODEX_DEFERRED_SURFACE: readonly {
  surface: string;
  claude_analog: string;
  reason: string;
}[] = [];

/** `~/.codex/` 等 global Codex 設定への参照 (repo-relative 原則違反) を検出。 */
const CODEX_GLOBAL_RE = /(?:^|[\s"'=])(?:~|\$HOME|%USERPROFILE%)?[\\/]?\.codex[\\/]/i;

export type CodexHookViolationReason =
  | "missing_hooks_json"
  | "malformed_json"
  | "missing_hook"
  | "missing_block_on_failure"
  | "claude_project_dir_in_codex"
  | "global_codex_path"
  | "forbidden_path"
  | "entrypoint_drift";

export interface CodexHookViolation {
  hook?: string;
  reason: CodexHookViolationReason;
}

export interface CodexHookResult {
  checked: number;
  violations: CodexHookViolation[];
  ok: boolean;
  apiToolPathEnforced: false;
}

interface HookCommand {
  type?: string;
  command?: string;
  blockOnFailure?: boolean;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

interface CodexHooksFile {
  hooks?: Record<string, HookEntry[]>;
}

function matcherEq(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  return actual === expected;
}

/**
 * command が必須 entrypoint を本当に呼んでいるかを照合する。素朴な substring 一致は
 * `echo src/cli.ts ...` のような無関係文字列を誤って guard 充足と判定しうる (cross-runtime
 * review Important)。そこで script path 部 (空白を含まない part) は **token 完全一致**、複数語の
 * subcommand 部 (`session start` 等) は部分一致で照合する。
 */
function commandHas(command: string, parts: readonly string[]): boolean {
  const tokens = command.trim().split(/\s+/);
  return parts.every((part) =>
    part.includes(" ") ? command.includes(part) : tokens.includes(part),
  );
}

export function analyzeCodexHookAdapter(input: { codexHooksJson: string | null }): CodexHookResult {
  if (input.codexHooksJson === null) {
    return {
      checked: 0,
      violations: [{ reason: "missing_hooks_json" }],
      ok: false,
      apiToolPathEnforced: false,
    };
  }
  let parsed: CodexHooksFile;
  try {
    parsed = JSON.parse(input.codexHooksJson) as CodexHooksFile;
  } catch {
    return {
      checked: 0,
      violations: [{ reason: "malformed_json" }],
      ok: false,
      apiToolPathEnforced: false,
    };
  }

  const violations: CodexHookViolation[] = [];
  const hooks = parsed.hooks ?? {};

  // 双方向健全性: Codex の各 entrypoint は Claude `REQUIRED` にも存在しなければならない
  // (片方の adapter にしか無い = 黙った分岐)。
  const claudeEntrypoints = new Set(CLAUDE_REQUIRED.map((r) => r.commandParts.join(" ")));
  for (const guard of CODEX_REQUIRED) {
    if (!claudeEntrypoints.has(guard.commandParts.join(" "))) {
      violations.push({ hook: guard.id, reason: "entrypoint_drift" });
    }
  }

  // 全 command を走査して repo-relative 原則違反 / legacy / global codex 参照を検出。
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        const command = hook.command ?? "";
        if (command.includes("$CLAUDE_PROJECT_DIR")) {
          violations.push({ hook: event, reason: "claude_project_dir_in_codex" });
        }
        if (CODEX_GLOBAL_RE.test(command)) {
          violations.push({ hook: event, reason: "global_codex_path" });
        }
        if (FORBIDDEN_PATH_RE.test(command)) {
          violations.push({ hook: event, reason: "forbidden_path" });
        }
      }
    }
  }

  // 各 Codex 必須ガードが宣言され、guard は blockOnFailure を持つこと。
  for (const required of CODEX_REQUIRED) {
    const entries = (hooks[required.event] ?? []).filter((entry) =>
      matcherEq(entry.matcher, required.matcher),
    );
    const matchingCommands = entries
      .flatMap((entry) => entry.hooks ?? [])
      // type==="command" の hook のみが guard を充足しうる (非 command エントリで偽充足させない)。
      // source 配線 (commandParts) と setup 生成 wrapper 配線 (wrapperCommand、PLAN-RECOVERY-06)
      // の両形式を受理する。
      .filter(
        (hook) =>
          hook.type === "command" &&
          (commandHas(hook.command ?? "", required.commandParts) ||
            (hook.command ?? "").includes(required.wrapperCommand)),
      );
    if (matchingCommands.length === 0) {
      violations.push({ hook: required.id, reason: "missing_hook" });
      continue;
    }
    if (required.blockOnFailure && !matchingCommands.some((hook) => hook.blockOnFailure === true)) {
      violations.push({ hook: required.id, reason: "missing_block_on_failure" });
    }
  }

  return {
    checked: CODEX_REQUIRED.length,
    violations,
    ok: violations.length === 0,
    apiToolPathEnforced: false,
  };
}

export function loadCodexHookAdapterInput(repoRoot: string): { codexHooksJson: string | null } {
  const target = join(repoRoot, ".codex", "hooks.json");
  return {
    codexHooksJson: existsSync(target) ? readFileSync(target, "utf8") : null,
  };
}

export function codexHookAdapterMessages(result: CodexHookResult): string[] {
  if (result.ok) {
    return [
      `codex-hook-adapter - OK (checked=${result.checked}, .codex/hooks.json shares Claude guard entrypoints; matcher=spawn_agent|spawn_agents_on_csv + apply_patch|write_file, subagent-stop=N/A)`,
      "codex-hook-adapter - note: .codex/hooks.json covers direct Codex CLI/IDE sessions only; hosted API/developer apply_patch tools do not execute through the Codex hook engine and are not repo-enforceable",
    ];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.hook ? `${v.hook}:` : ""}${v.reason}`)
    .join(", ");
  return [`codex-hook-adapter - violation ${result.violations.length} (${sample})`];
}
