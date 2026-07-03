import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { loadChangedFiles } from "../lint/change-impact";
import {
  type AdapterContextInjection,
  type AdapterPlan,
  type AdapterProvider,
  buildAdapterPlan,
  buildProviderInvocation,
} from "../runtime/adapter";
import { detectMode } from "../runtime/detect";
import {
  assessReviewSession,
  isReadOnlyDelegationRole,
  reviewGuardMessages,
} from "../runtime/review-guard";
import { dispatch, nodeDeps, type SessionHookInput } from "../runtime/session-log";

export interface AdapterExecutionDeps {
  gitBranch: () => string | null;
  gitHead: () => string | null;
  runSessionStartSideEffects: (
    repoRoot: string,
    input: SessionHookInput,
    deps: ReturnType<typeof nodeDeps>,
  ) => void;
  writeHandoverWarnings: () => void;
}

export interface AdapterExecutionInput {
  sessionPrefix: string;
  toolName: string;
  planId?: string;
  jsonOut?: boolean;
  reviewRole?: string;
}

export interface AdapterExecutionResult {
  executed: true;
  exit_code: number | null;
  signal: string | null;
}

export interface DelegationCommandDeps extends AdapterExecutionDeps {
  resolveTaskText: (opts: { task?: string; taskFile?: string }) => string | null;
  resolveSkillContextInjection: (planId: string | undefined) => AdapterContextInjection | undefined;
  taskFileOptionDescription: string;
}

export function adapterExecutionEnv(
  provider: AdapterProvider,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const legacyPrefix = ["HE", "LIX"].join("");
  for (const key of [
    [legacyPrefix, "ALLOW", "RAW", "CLAUDE"].join("_"),
    [legacyPrefix, "RAW", "CLAUDE", "REASON"].join("_"),
    [legacyPrefix, "ALLOW", "RAW", "CODEX"].join("_"),
    [legacyPrefix, "RAW", "CODEX", "REASON"].join("_"),
    [legacyPrefix, "CLAUDE", "BIN"].join("_"),
    [legacyPrefix, "CODEX", "BIN"].join("_"),
  ]) {
    delete env[key];
  }
  if (provider !== "claude" && provider !== "codex") return env;
  return { ...env, ...extraEnv };
}

function safeLoadChangedFiles(repoRoot: string): string[] {
  try {
    return loadChangedFiles(repoRoot);
  } catch {
    return [];
  }
}

export function executeAdapterPlanForCli(
  plan: AdapterPlan,
  input: AdapterExecutionInput,
  depsInput: AdapterExecutionDeps,
): AdapterExecutionResult {
  const sessionId = `${input.sessionPrefix}-${Date.now()}`;
  const repoRoot = process.cwd();
  const deps = nodeDeps(repoRoot, depsInput.gitBranch, depsInput.gitHead);
  const startInput: SessionHookInput = {
    hook_event_name: "SessionStart",
    session_id: sessionId,
    ...(input.planId ? { plan_id: input.planId } : {}),
  };
  depsInput.runSessionStartSideEffects(repoRoot, startInput, deps);
  dispatch(startInput, deps, "SessionStart");

  const guardActive = input.reviewRole !== undefined && isReadOnlyDelegationRole(input.reviewRole);
  const treeBefore = guardActive ? safeLoadChangedFiles(repoRoot) : [];
  const invocation = buildProviderInvocation({
    provider: plan.provider,
    command: plan.command,
    args: plan.args,
  });
  const child = spawnSync(invocation.command, invocation.args, {
    input: plan.stdin,
    stdio:
      plan.stdin === undefined
        ? ["inherit", input.jsonOut ? 2 : "inherit", "inherit"]
        : ["pipe", input.jsonOut ? 2 : "inherit", "inherit"],
    env: adapterExecutionEnv(plan.provider, plan.env),
    shell: invocation.shell ?? false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
  });
  if (child.error) {
    process.stderr.write(`${plan.provider}: failed to launch (${String(child.error)})\n`);
  }
  if (guardActive && input.reviewRole) {
    const assessment = assessReviewSession({
      role: input.reviewRole,
      before: treeBefore,
      after: safeLoadChangedFiles(repoRoot),
    });
    for (const message of reviewGuardMessages(assessment)) process.stderr.write(`${message}\n`);
  }
  dispatch(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      ...(input.planId ? { plan_id: input.planId } : {}),
      tool_name: input.toolName,
      tool_input: { command: `${plan.command} ${plan.args.join(" ")}` },
      tool_response: { outcome: child.status === 0 ? "ok" : "error" },
    },
    deps,
    "PostToolUse",
  );
  dispatch(
    {
      hook_event_name: "Stop",
      session_id: sessionId,
      ...(input.planId ? { plan_id: input.planId } : {}),
    },
    deps,
    "Stop",
  );
  depsInput.writeHandoverWarnings();
  return { executed: true, exit_code: child.status ?? null, signal: child.signal ?? null };
}

function runtimeCommand(
  program: Command,
  provider: AdapterProvider,
  deps: DelegationCommandDeps,
): Command {
  return program
    .command(provider)
    .description(`${provider} runtime adapter command`)
    .requiredOption("--role <role>", "delegation role")
    .option("--task <text>", "task text")
    .option("--task-file <path>", deps.taskFileOptionDescription)
    .option("--plan <id>", "PLAN id")
    .option("--model <model>", "provider model override for this call")
    .option("--effort <level>", "provider reasoning effort override for this call")
    .option("--execute", "execute provider CLI instead of dry-run")
    .option("--json", "JSON output")
    .action(
      (opts: {
        role: string;
        task?: string;
        taskFile?: string;
        plan?: string;
        model?: string;
        effort?: string;
        execute?: boolean;
        json?: boolean;
      }) => {
        const task = deps.resolveTaskText(opts);
        if (!task) {
          process.stderr.write("adapter requires exactly one of --task or --task-file\n");
          process.exitCode = 1;
          return;
        }
        const mode = detectMode().mode;
        const contextInjection = deps.resolveSkillContextInjection(opts.plan);
        const plan = buildAdapterPlan(
          {
            provider,
            role: opts.role,
            task,
            planId: opts.plan,
            model: opts.model,
            effort: opts.effort,
            execute: Boolean(opts.execute),
            contextInjection,
          },
          mode,
        );
        if (!plan.available) {
          process.stderr.write(`${plan.messages.join("\n")}\n`);
          process.exitCode = 1;
          return;
        }
        if (!opts.execute) {
          process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
          return;
        }
        const jsonOut = Boolean(opts.json);
        const execution = executeAdapterPlanForCli(
          plan,
          {
            sessionPrefix: provider,
            toolName: provider,
            planId: opts.plan,
            jsonOut,
            reviewRole: opts.role,
          },
          deps,
        );
        if (jsonOut) {
          process.stdout.write(`${JSON.stringify({ ...plan, ...execution }, null, 2)}\n`);
        }
        process.exitCode = execution.exit_code ?? 1;
      },
    );
}

export function registerDelegationCommands(program: Command, deps: DelegationCommandDeps): void {
  runtimeCommand(program, "codex", deps);
  runtimeCommand(program, "claude", deps);
}
