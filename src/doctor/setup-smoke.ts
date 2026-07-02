import { join } from "node:path";

export interface SetupSmokeDeps {
  repoRoot: string;
  readText: (path: string) => string | null;
}

interface SetupSmokeCheck {
  name: string;
  ok: boolean;
  message: string;
}

const SETUP_SMOKE_REQUIRED_FILES = [
  ".ut-tdd/bin/ut-tdd.mjs",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  ".claude/settings.json",
  ".codex/config.toml",
  ".codex/hooks.json",
] as const;

const SETUP_SMOKE_REQUIRED_COMMANDS = [
  "bun .ut-tdd/bin/ut-tdd.mjs hook agent-guard",
  "bun .ut-tdd/bin/ut-tdd.mjs hook work-guard",
  "bun .ut-tdd/bin/ut-tdd.mjs session start",
  "bun .ut-tdd/bin/ut-tdd.mjs hook post-tool-use",
  "bun .ut-tdd/bin/ut-tdd.mjs session summary",
] as const;

const SETUP_SMOKE_CLAUDE_ONLY_COMMANDS = ["bun .ut-tdd/bin/ut-tdd.mjs hook subagent-stop"] as const;

export function collectHookCommands(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
    };
    return Object.values(parsed.hooks ?? {}).flatMap((entries) =>
      (entries ?? []).flatMap((entry) =>
        (entry.hooks ?? []).map((hook) => hook.command ?? "").filter(Boolean),
      ),
    );
  } catch {
    return null;
  }
}

export function checkSetupSmoke(deps: SetupSmokeDeps): { ok: boolean; messages: string[] } {
  const checks: SetupSmokeCheck[] = [];
  for (const file of SETUP_SMOKE_REQUIRED_FILES) {
    checks.push({
      name: file,
      ok: deps.readText(join(deps.repoRoot, file)) !== null,
      message: file,
    });
  }

  const wrapper = deps.readText(join(deps.repoRoot, ".ut-tdd/bin/ut-tdd.mjs"));
  checks.push({
    name: "wrapper-placeholder-free",
    ok: wrapper !== null && !/UT_TDD_SOURCE_CLI_JSON|__UT_TDD|placeholder/i.test(wrapper),
    message: "project-local wrapper has no template placeholder residue",
  });

  const claudeCommands = collectHookCommands(
    deps.readText(join(deps.repoRoot, ".claude/settings.json")),
  );
  const codexCommands = collectHookCommands(
    deps.readText(join(deps.repoRoot, ".codex/hooks.json")),
  );
  checks.push({
    name: "claude-hooks-json",
    ok: claudeCommands !== null,
    message: "Claude adapter hook JSON parses",
  });
  checks.push({
    name: "codex-hooks-json",
    ok: codexCommands !== null,
    message: "Codex adapter hook JSON parses",
  });

  for (const command of SETUP_SMOKE_REQUIRED_COMMANDS) {
    checks.push({
      name: `claude-hook:${command}`,
      ok: (claudeCommands ?? []).includes(command),
      message: command,
    });
    checks.push({
      name: `codex-hook:${command}`,
      ok: (codexCommands ?? []).includes(command),
      message: command,
    });
  }
  for (const command of SETUP_SMOKE_CLAUDE_ONLY_COMMANDS) {
    checks.push({
      name: `claude-hook:${command}`,
      ok: (claudeCommands ?? []).includes(command),
      message: command,
    });
  }
  const combinedCommands = [...(claudeCommands ?? []), ...(codexCommands ?? [])];
  checks.push({
    name: "portable-hook-paths",
    ok:
      combinedCommands.length > 0 &&
      combinedCommands.every(
        (command) =>
          command.includes(".ut-tdd/bin/ut-tdd.mjs") &&
          !command.includes("$CLAUDE_PROJECT_DIR") &&
          !/[\\/]\\.codex[\\/]/i.test(command),
      ),
    message: "hooks use project-local wrapper and avoid runtime/global paths",
  });

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    messages: [
      `doctor: setup-smoke - ${failed.length === 0 ? "OK" : "violation"} (checked=${checks.length}, failed=${failed.length})`,
      ...failed
        .slice(0, 12)
        .map((check) => `doctor: setup-smoke - missing ${check.name}: ${check.message}`),
    ],
  };
}
