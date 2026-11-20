import type { SessionHookInput } from "./session-log.ts";

interface PostToolUseOptions {
  tool?: string;
  path?: string;
  command?: string;
  outcome?: "ok" | "error";
}

export function outcomeOf(input: SessionHookInput): "ok" | "error" | undefined {
  const r = input.tool_response as { outcome?: string } | undefined;
  if (r?.outcome === "error") return "error";
  if (r?.outcome === "ok") return "ok";
  return undefined;
}

export function createPostToolUseInput(
  input: SessionHookInput,
  options: PostToolUseOptions,
): SessionHookInput {
  return {
    ...input,
    hook_event_name: "PostToolUse",
    tool_name: options.tool ?? input.tool_name ?? (options.command ? "Bash" : "manual"),
    tool_input: {
      ...(input.tool_input ?? {}),
      ...(options.path ? { file_path: options.path } : {}),
      ...(options.command ? { command: options.command } : {}),
    },
    tool_response: options.outcome
      ? {
          ...(typeof input.tool_response === "object" ? input.tool_response : {}),
          outcome: options.outcome,
        }
      : input.tool_response,
  };
}
