/**
 * Runtime mode detection.
 *
 * Availability is based on spawnability, not only command-name presence on PATH.
 * This keeps `hybrid` from becoming a false-positive when a wrapper exists but
 * cannot actually launch the provider CLI.
 */
import { type AdapterProvider, isProviderCommandSpawnable } from "./adapter";

export type ExecutionMode = "standalone" | "claude-only" | "codex-only" | "hybrid";

export interface RuntimeDetection {
  mode: ExecutionMode;
  claude: boolean;
  codex: boolean;
  /** Runtime currently hosting this process, when an environment signal exists. */
  currentRuntime: "claude" | "codex" | null;
  availableRuntimes: string[];
  missingRuntimes: string[];
}

export interface RuntimeDetectionDeps {
  env?: NodeJS.ProcessEnv;
  isProviderSpawnable?: (provider: AdapterProvider, env: NodeJS.ProcessEnv) => boolean;
}

/**
 * `ut-tdd status --json` の judgment-gate guidance (`nextAction`)。runtime mode が判断ゲートの
 * 進め方を決める (concept §2.5 / requirements §6 / §7.8.7.1): standalone は AI レビュアー不在ゆえ
 * 判断ゲートは人間レビュー必須 (自動 pass 不可)、単一 runtime は intra_runtime_subagent 証跡、
 * hybrid は別 runtime/model 族でクロスレビュー。値は安定した公開機械契約文字列で、先頭 token
 * (`:` 手前) で機械 switch でき、後続が人間可読ガイダンス (A-138 ITEM-1、taxonomy=current)。
 */
export const NEXT_ACTION_BY_MODE: Record<ExecutionMode, string> = {
  standalone:
    "human-review-required: no AI reviewer is spawnable, so judgment gates cannot auto-pass",
  "claude-only":
    "single-runtime: record intra_runtime_subagent review evidence (no cross-runtime reviewer)",
  "codex-only":
    "single-runtime: record intra_runtime_subagent review evidence (no cross-runtime reviewer)",
  hybrid: "cross-review-ready: route judgment gates to a different runtime/model family",
};

/** mode → judgment-gate next action。純関数・副作用なし (FR-05 決定論)。 */
export function nextActionForMode(mode: ExecutionMode): string {
  return NEXT_ACTION_BY_MODE[mode];
}

function defaultProviderSpawnable(provider: AdapterProvider, env: NodeJS.ProcessEnv): boolean {
  return isProviderCommandSpawnable(provider, { env });
}

export function detectMode(deps: RuntimeDetectionDeps = {}): RuntimeDetection {
  const env = deps.env ?? process.env;
  const providerSpawnable = deps.isProviderSpawnable ?? defaultProviderSpawnable;
  const inClaude = env.CLAUDECODE === "1";
  const inCodex = Boolean(env.CODEX_SANDBOX ?? env.CODEX_HOME);

  const claude = providerSpawnable("claude", env);
  const codex = providerSpawnable("codex", env);

  let mode: ExecutionMode;
  if (claude && codex) mode = "hybrid";
  else if (claude) mode = "claude-only";
  else if (codex) mode = "codex-only";
  else mode = "standalone";

  const currentRuntime: RuntimeDetection["currentRuntime"] = inClaude
    ? "claude"
    : inCodex
      ? "codex"
      : null;

  const available: string[] = [];
  const missing: string[] = [];
  (claude ? available : missing).push("claude");
  (codex ? available : missing).push("codex");

  return {
    mode,
    claude,
    codex,
    currentRuntime,
    availableRuntimes: available,
    missingRuntimes: missing,
  };
}
