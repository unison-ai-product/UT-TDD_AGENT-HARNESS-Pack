import type { AdapterProvider } from "./adapter";

export const CODEX_STDIN_ARGS = ["exec", "-"] as const;
export const CODEX_MODEL_FLAG = "-m";

export const CLAUDE_STDIN_ARGS = ["--print", "--input-format", "text"] as const;
export const CLAUDE_MODEL_FLAG = "--model";
export const CLAUDE_EFFORT_FLAG = "--effort";
export const CLAUDE_EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL";

export const ADAPTER_CONTEXT_HEADER = "UT-TDD context injection:";
export const REQUIRED_SKILL_LABEL = "required skill";
export const OPTIONAL_SKILL_LABEL = "optional skill";

export const ADAPTER_AVAILABLE_MESSAGE = "adapter execution allowed";
export const ADAPTER_DRY_RUN_MESSAGE = "adapter dry-run plan";

export type AdapterErrorKind = "absent" | "auth" | "rate-limit" | "timeout" | "unknown";

export interface AdapterError {
  kind: AdapterErrorKind;
  provider: AdapterProvider;
  retryable: boolean;
  message: string;
}

export type AdapterErrorAction = "degrade" | "fail-close" | "retry" | "skip";

export interface AdapterErrorPolicyOptions {
  degradationAllowed?: boolean;
  retryExhausted?: boolean;
}

export interface AdapterErrorPolicyDecision {
  ok: boolean;
  kind: AdapterErrorKind;
  provider: AdapterProvider;
  action: AdapterErrorAction;
  exit_code: number;
  severity: "warn" | "error";
  message: string;
  next_action: string;
}

export function unavailableProviderMessage(provider: AdapterProvider, mode: string): string {
  return `${provider} is not available in ${mode} mode`;
}

export function mapAdapterErrorPolicy(
  error: AdapterError,
  opts: AdapterErrorPolicyOptions = {},
): AdapterErrorPolicyDecision {
  const degradationAllowed = opts.degradationAllowed ?? true;
  const retryExhausted = opts.retryExhausted ?? false;

  switch (error.kind) {
    case "absent":
      if (degradationAllowed) {
        return {
          ok: true,
          kind: error.kind,
          provider: error.provider,
          action: "degrade",
          exit_code: 0,
          severity: "warn",
          message: error.message,
          next_action: `downgrade mode because ${error.provider} provider is absent`,
        };
      }
      return {
        ok: false,
        kind: error.kind,
        provider: error.provider,
        action: "fail-close",
        exit_code: 1,
        severity: "error",
        message: error.message,
        next_action: `install or enable ${error.provider} before running this gate`,
      };
    case "auth":
      return {
        ok: false,
        kind: error.kind,
        provider: error.provider,
        action: "fail-close",
        exit_code: 1,
        severity: "error",
        message: error.message,
        next_action:
          error.provider === "codex"
            ? "run codex login and retry"
            : "complete Claude Code authentication and retry",
      };
    case "rate-limit":
      if (error.retryable && !retryExhausted) {
        return {
          ok: false,
          kind: error.kind,
          provider: error.provider,
          action: "retry",
          exit_code: 75,
          severity: "warn",
          message: error.message,
          next_action: "retry with bounded backoff",
        };
      }
      return {
        ok: false,
        kind: error.kind,
        provider: error.provider,
        action: "fail-close",
        exit_code: 1,
        severity: "error",
        message: error.message,
        next_action: "stop after retry exhaustion and surface the plan limit",
      };
    case "timeout":
      if (error.retryable && !retryExhausted) {
        return {
          ok: false,
          kind: error.kind,
          provider: error.provider,
          action: "retry",
          exit_code: 75,
          severity: "warn",
          message: error.message,
          next_action: "retry until the bounded timeout budget is exhausted",
        };
      }
      return {
        ok: true,
        kind: error.kind,
        provider: error.provider,
        action: "skip",
        exit_code: 0,
        severity: "warn",
        message: error.message,
        next_action: "skip the affected item and continue with other results",
      };
    case "unknown":
      return {
        ok: false,
        kind: error.kind,
        provider: error.provider,
        action: "fail-close",
        exit_code: 1,
        severity: "error",
        message: error.message,
        next_action: "classify the external provider failure before continuing",
      };
  }
}
