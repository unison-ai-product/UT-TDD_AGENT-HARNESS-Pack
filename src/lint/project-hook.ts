import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONAL_ABSOLUTE_PATH_PATTERN } from "./personal-path";

export interface ProjectHookDoc {
  file: string;
  content: string;
}

export interface ProjectHookViolation {
  file: string;
  hook?: string;
  reason:
    | "missing_settings"
    | "malformed_json"
    | "missing_hook"
    | "missing_project_dir"
    | "missing_block_on_failure"
    | "tracked_permissions"
    | "forbidden_path";
}

export interface ProjectHookResult {
  checked: number;
  violations: ProjectHookViolation[];
  ok: boolean;
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

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  permissions?: unknown;
}

interface RequiredProjectHook {
  id: string;
  event: string;
  matcher?: string;
  commandParts: readonly string[];
  wrapperCommand: string;
  blockOnFailure?: boolean;
}

/**
 * setup が consumer へ生成する wrapper 配線の正規 entrypoint。source 配線
 * (`src/cli.ts` / `.claude/hooks/*.ts` + `$CLAUDE_PROJECT_DIR`) と並ぶ第 2 の受理形式
 * であり、setup templates は必ずこの定数から command を生成する (単一定義源、
 * PLAN-RECOVERY-06: gate 要求と setup 生成物の黙った再乖離を防ぐ)。
 */
export const WRAPPER_CLI = ".ut-tdd/bin/ut-tdd.mjs";

const wrapperCommand = (subcommand: string): string => `bun ${WRAPPER_CLI} ${subcommand}`;

export const REQUIRED = [
  {
    id: "agent-guard",
    event: "PreToolUse",
    matcher: "Agent|Task",
    commandParts: [".claude/hooks/agent-guard.ts"],
    wrapperCommand: wrapperCommand("hook agent-guard"),
    blockOnFailure: true,
  },
  {
    id: "work-guard",
    event: "PreToolUse",
    matcher: "Edit|Write|MultiEdit",
    commandParts: [".claude/hooks/work-guard.ts"],
    wrapperCommand: wrapperCommand("hook work-guard"),
    blockOnFailure: true,
  },
  {
    id: "session-start",
    event: "SessionStart",
    commandParts: ["src/cli.ts", "session start"],
    wrapperCommand: wrapperCommand("session start"),
  },
  {
    id: "post-tool-use",
    event: "PostToolUse",
    matcher: "Edit|Write|MultiEdit|Bash",
    commandParts: ["src/cli.ts", "hook post-tool-use"],
    wrapperCommand: wrapperCommand("hook post-tool-use"),
  },
  {
    id: "session-summary",
    event: "Stop",
    commandParts: ["src/cli.ts", "session summary"],
    wrapperCommand: wrapperCommand("session summary"),
  },
  {
    id: "subagent-stop",
    event: "SubagentStop",
    commandParts: ["src/cli.ts", "hook subagent-stop"],
    wrapperCommand: wrapperCommand("hook subagent-stop"),
  },
] satisfies readonly RequiredProjectHook[];

/** REQUIRED の id union。typo を compile error にする (module 評価時 throw の回避)。 */
export type RequiredProjectHookId = (typeof REQUIRED)[number]["id"];

/** setup templates 用: 必須 hook id → 正規 wrapper command (単一定義源)。 */
export function wrapperHookCommand(id: RequiredProjectHookId): string {
  const entry = REQUIRED.find((required) => required.id === id);
  if (!entry) throw new Error(`unknown required project hook id: ${id}`);
  return entry.wrapperCommand;
}

const LEGACY_RUNTIME_NAME = ["he", "lix"].join("");
const LEGACY_ENV_PREFIX = ["HE", "LIX_"].join("");
export const FORBIDDEN_PATH_RE = new RegExp(
  [
    "ai-dev-kit-vscode",
    `vendor/${LEGACY_RUNTIME_NAME}-source`,
    String.raw`\.${LEGACY_RUNTIME_NAME}`,
    PERSONAL_ABSOLUTE_PATH_PATTERN,
    `${LEGACY_ENV_PREFIX}[A-Z0-9_]*`,
    String.raw`\b${LEGACY_RUNTIME_NAME}\s+(?:codex|claude|plan|gate|handover)\b`,
    `pmo-${LEGACY_RUNTIME_NAME}-`,
  ].join("|"),
  "i",
);

function parseSettings(doc: ProjectHookDoc): ClaudeSettings | null {
  try {
    return JSON.parse(doc.content) as ClaudeSettings;
  } catch {
    return null;
  }
}

function matcherOk(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  return actual === expected;
}

function commandOk(command: string, parts: readonly string[]): boolean {
  return parts.every((part) => command.includes(part));
}

function isWrapperForm(command: string, required: RequiredProjectHook): boolean {
  return command.includes(required.wrapperCommand);
}

export function analyzeProjectHooks(docs: ProjectHookDoc[]): ProjectHookResult {
  const violations: ProjectHookViolation[] = [];
  for (const doc of docs) {
    const settings = parseSettings(doc);
    if (!settings) {
      violations.push({ file: doc.file, reason: "malformed_json" });
      continue;
    }
    const hooks = settings.hooks ?? {};
    if (settings.permissions !== undefined) {
      violations.push({ file: doc.file, reason: "tracked_permissions" });
    }
    for (const [event, entries] of Object.entries(hooks)) {
      for (const entry of entries ?? []) {
        for (const hook of entry.hooks ?? []) {
          if (FORBIDDEN_PATH_RE.test(hook.command ?? "")) {
            violations.push({ file: doc.file, hook: event, reason: "forbidden_path" });
          }
        }
      }
    }
    for (const required of REQUIRED) {
      const entries = hooks[required.event] ?? [];
      const found = entries.some(
        (entry) =>
          matcherOk(entry.matcher, required.matcher) &&
          (entry.hooks ?? []).some((hook) => {
            const command = hook.command ?? "";
            return commandOk(command, required.commandParts) || isWrapperForm(command, required);
          }),
      );
      if (!found) {
        violations.push({ file: doc.file, hook: required.event, reason: "missing_hook" });
        continue;
      }

      for (const entry of entries.filter((entry) => matcherOk(entry.matcher, required.matcher))) {
        for (const hook of entry.hooks ?? []) {
          const command = hook.command ?? "";
          const sourceForm = commandOk(command, required.commandParts);
          const wrapperForm = isWrapperForm(command, required);
          if (!sourceForm && !wrapperForm) continue;
          // wrapper 形式は repo-relative パスで完結するため $CLAUDE_PROJECT_DIR を要求しない
          // (setup 生成 settings.json の正規形、PLAN-RECOVERY-06)。
          if (sourceForm && !command.includes("$CLAUDE_PROJECT_DIR")) {
            violations.push({
              file: doc.file,
              hook: required.event,
              reason: "missing_project_dir",
            });
          }
          if (FORBIDDEN_PATH_RE.test(command)) {
            violations.push({ file: doc.file, hook: required.event, reason: "forbidden_path" });
          }
          if (required.blockOnFailure && hook.blockOnFailure !== true) {
            violations.push({
              file: doc.file,
              hook: required.event,
              reason: "missing_block_on_failure",
            });
          }
        }
      }
    }
  }
  if (docs.length === 0) {
    violations.push({ file: join(".claude", "settings.json"), reason: "missing_settings" });
  }
  return { checked: docs.length, violations, ok: violations.length === 0 };
}

export function loadProjectHookDocs(repoRoot: string = process.cwd()): ProjectHookDoc[] {
  const target = join(repoRoot, ".claude", "settings.json");
  if (!existsSync(target)) return [];
  return [{ file: join(".claude", "settings.json"), content: readFileSync(target, "utf8") }];
}

export function projectHookMessages(result: ProjectHookResult): string[] {
  if (result.violations.length > 0) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.file}${v.hook ? `:${v.hook}` : ""}:${v.reason}`)
      .join(", ");
    return [`project-hook - violation ${result.violations.length} (${sample})`];
  }
  return [`project-hook - OK (checked=${result.checked}, hooks=${REQUIRED.length})`];
}
