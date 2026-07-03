import { spawnSync } from "node:child_process";
import { loadChangedFiles } from "../lint/change-impact";
import {
  type AdapterPlan,
  type AdapterProvider,
  buildProviderInvocation,
} from "../runtime/adapter";
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
