import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, win32 } from "node:path";
import {
  ADAPTER_AVAILABLE_MESSAGE,
  ADAPTER_CONTEXT_HEADER,
  ADAPTER_DRY_RUN_MESSAGE,
  CLAUDE_EFFORT_ENV,
  CLAUDE_EFFORT_FLAG,
  CLAUDE_MODEL_FLAG,
  CLAUDE_STDIN_ARGS,
  CODEX_MODEL_FLAG,
  CODEX_STDIN_ARGS,
  OPTIONAL_SKILL_LABEL,
  REQUIRED_SKILL_LABEL,
  unavailableProviderMessage,
} from "./adapter-policy";
import type { ExecutionMode } from "./detect";

export type AdapterProvider = "claude" | "codex";

export interface AdapterIntent {
  provider: AdapterProvider;
  role: string;
  task: string;
  planId?: string;
  model?: string;
  effort?: string;
  execute?: boolean;
  contextInjection?: AdapterContextInjection;
}

export interface AdapterContextInjection {
  required_paths: string[];
  optional_paths: string[];
}

export interface AdapterPlan {
  provider: AdapterProvider;
  available: boolean;
  command: string;
  args: string[];
  /**
   * Provider prompts are carried by stdin. Windows `.cmd` provider shims are
   * launched via cmd.exe with Node `shell:false`; argv carries only fixed flags
   * plus validated model metadata, never the free-form task text.
   */
  stdin?: string;
  env?: Record<string, string>;
  dry_run: boolean;
  plan_id?: string;
  model?: string;
  effort?: string;
  context_injection?: AdapterContextInjection;
  messages: string[];
}

export type AdapterErrorClass = "provider_error" | "malformed_output";

export interface ProviderRunResult {
  status: number | null;
  signal?: string | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: unknown;
}

export type InvokeResult =
  | {
      ok: true;
      provider: AdapterProvider;
      plan_id?: string;
      command: string;
      args: string[];
      exit_code: number;
      output: string;
      stderr: string;
    }
  | {
      ok: false;
      provider: AdapterProvider;
      plan_id?: string;
      command: string;
      args: string[];
      exit_code: number | null;
      signal: string | null;
      error_class: AdapterErrorClass;
      message: string;
      stderr: string;
    };

export interface ProviderCommandResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ProviderInvocation {
  command: string;
  args: string[];
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
}

export interface ProviderInvocationInput {
  provider: AdapterProvider;
  command: string;
  args: string[];
  opts?: ProviderCommandResolutionOptions;
}

export interface ProviderProbeOptions extends ProviderCommandResolutionOptions {
  runProbe?: (command: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null };
}

export function providerAvailable(provider: AdapterProvider, mode: ExecutionMode): boolean {
  if (provider === "claude") return mode === "claude-only" || mode === "hybrid";
  return mode === "codex-only" || mode === "hybrid";
}

function newestExisting(paths: string[]): string | null {
  const existing = paths.filter((p) => existsSync(p));
  return existing.length > 0 ? (existing.sort().at(-1) ?? null) : null;
}

/** Native binary candidate with a source-specific extracted version (A-137 #6). */
interface VersionedCandidate {
  path: string;
  version: string;
}

/**
 * Extract numeric semver core parts (`1.10.0-win32-x64` -> `[1, 10, 0]`).
 * Pre-release/build/platform suffixes are ignored; unparsable parts become 0.
 */
function parseVersion(version: string): number[] {
  const core = version.split(/[-+]/, 1)[0] ?? version;
  return core.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

/** Numeric semver comparison; negative means `a` is older. Missing parts are 0. */
function compareVersion(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pick the semver-newest existing native binary (A-137 #6).
 * Lexicographic sort misorders `1.10.0` and `1.9.0`, and mixed-source paths
 * can otherwise dominate comparison. Equal versions keep the earlier source.
 */
function newestVersioned(candidates: VersionedCandidate[]): string | null {
  const existing = candidates.filter((candidate) => existsSync(candidate.path));
  if (existing.length === 0) return null;
  let best = existing[0];
  for (const candidate of existing.slice(1)) {
    if (compareVersion(candidate.version, best.version) > 0) best = candidate;
  }
  return best.path;
}

function firstOnPath(command: string, opts: ProviderCommandResolutionOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const finder =
    platform === "win32"
      ? win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
      : "which";
  try {
    const found = execFileSync(finder, [command], { encoding: "utf8", env })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return found[0] ?? null;
  } catch {
    return null;
  }
}

export function resolveClaudeNativeCommand(
  opts: ProviderCommandResolutionOptions = {},
): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const explicit = env.UT_TDD_CLAUDE_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  if (platform === "win32") {
    const appData =
      env.APPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Roaming") : null);
    const appDataRoot = appData ? join(appData, "Claude", "claude-code") : null;
    const appDataCandidates: VersionedCandidate[] =
      appDataRoot && existsSync(appDataRoot)
        ? readdirSync(appDataRoot).map((version) => ({
            path: join(appDataRoot, version, "claude.exe"),
            version,
          }))
        : [];

    const home = env.USERPROFILE ?? env.HOME;
    const vscodeRoot = home ? join(home, ".vscode", "extensions") : null;
    const vscodePrefix = "anthropic.claude-code-";
    const vscodeCandidates: VersionedCandidate[] =
      vscodeRoot && existsSync(vscodeRoot)
        ? readdirSync(vscodeRoot)
            .filter((name) => name.startsWith(vscodePrefix))
            .map((name) => ({
              path: join(vscodeRoot, name, "resources", "native-binary", "claude.exe"),
              version: name.slice(vscodePrefix.length),
            }))
        : [];

    const native = newestVersioned([...appDataCandidates, ...vscodeCandidates]);
    if (native) return native;
  }

  return firstOnPath("claude", opts);
}

export function resolveCodexNativeCommand(
  opts: ProviderCommandResolutionOptions = {},
): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const explicit = env.UT_TDD_CODEX_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  if (platform === "win32") {
    const appData =
      env.APPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Roaming") : null);
    const npmRoot = appData ? join(appData, "npm") : null;
    const appDataCandidates = npmRoot
      ? [join(npmRoot, "codex.exe"), join(npmRoot, "codex.cmd")]
      : [];
    const native = newestExisting(appDataCandidates);
    if (native) return native;
  }

  return firstOnPath("codex", opts);
}

export function resolveProviderCommand(
  provider: AdapterProvider,
  plannedCommand: string,
  opts: ProviderCommandResolutionOptions = {},
): string {
  if (provider === "claude") return resolveClaudeNativeCommand(opts) ?? plannedCommand;
  return resolveCodexNativeCommand(opts) ?? plannedCommand;
}

function isWindowsCommandScript(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

function windowsCommandProcessor(opts: ProviderCommandResolutionOptions = {}): string {
  const env = opts.env ?? process.env;
  return env.ComSpec ?? win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
}

function quoteCmdToken(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

export function buildProviderInvocation(input: ProviderInvocationInput): ProviderInvocation {
  const { provider, command, args, opts = {} } = input;
  const platform = opts.platform ?? process.platform;
  const resolved = resolveProviderCommand(provider, command, opts);
  if (platform === "win32" && isWindowsCommandScript(resolved)) {
    const innerCommand = [quoteCmdToken(resolved), ...args.map(quoteCmdToken)].join(" ");
    return {
      command: windowsCommandProcessor(opts),
      args: ["/d", "/s", "/c", `"${innerCommand}"`],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args, shell: false };
}

export function normalizeProviderEffort(
  provider: AdapterProvider,
  effort: string | undefined,
): string | undefined {
  if (provider !== "claude" || !effort) return effort;
  if (effort === "middle") return "medium";
  if (effort === "xhigh") return "high";
  return effort;
}

export function isProviderCommandSpawnable(
  provider: AdapterProvider,
  opts: ProviderProbeOptions = {},
): boolean {
  const env = opts.env ?? process.env;
  const invocation = buildProviderInvocation({
    provider,
    command: provider,
    args: ["--version"],
    opts,
  });
  const runProbe =
    opts.runProbe ??
    ((command: string, args: string[], probeEnv: NodeJS.ProcessEnv) =>
      spawnSync(command, args, {
        env: probeEnv,
        stdio: "ignore",
        shell: invocation.shell ?? false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
      }));
  try {
    return runProbe(invocation.command, invocation.args, env).status === 0;
  } catch {
    return false;
  }
}

export function buildAdapterPlan(intent: AdapterIntent, mode: ExecutionMode): AdapterPlan {
  const available = providerAvailable(intent.provider, mode);
  const isCodex = intent.provider === "codex";
  const providerEffort = normalizeProviderEffort(intent.provider, intent.effort);
  // Current contract: both providers receive task text via stdin. Args carry only
  // fixed flags, model/effort metadata, and provider-specific stdin sentinels.
  // Codex uses `codex exec -`; Claude uses `claude --print --input-format text`.
  // In both cases, the user task remains in stdin instead of argv.
  const args = isCodex
    ? [
        CODEX_STDIN_ARGS[0],
        ...(intent.model ? [CODEX_MODEL_FLAG, intent.model] : []),
        CODEX_STDIN_ARGS[1],
      ]
    : [
        ...CLAUDE_STDIN_ARGS,
        ...(intent.model ? [CLAUDE_MODEL_FLAG, intent.model] : []),
        ...(providerEffort ? [CLAUDE_EFFORT_FLAG, providerEffort] : []),
      ];
  return {
    provider: intent.provider,
    available,
    command: isCodex ? "codex" : "claude",
    args,
    stdin: formatAdapterPrompt(intent.task, intent.contextInjection),
    ...(intent.provider === "claude" && providerEffort
      ? { env: { [CLAUDE_EFFORT_ENV]: providerEffort } }
      : {}),
    dry_run: !intent.execute,
    plan_id: intent.planId,
    model: intent.model,
    effort: providerEffort,
    context_injection: intent.contextInjection,
    messages: available
      ? [intent.execute ? ADAPTER_AVAILABLE_MESSAGE : ADAPTER_DRY_RUN_MESSAGE]
      : [unavailableProviderMessage(intent.provider, mode)],
  };
}

function bufferToString(value: string | Buffer | null | undefined): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value ?? "";
}

export function normalizeInvokeResult(plan: AdapterPlan, run: ProviderRunResult): InvokeResult {
  const stderr = bufferToString(run.stderr);
  if (run.error) {
    return {
      ok: false,
      provider: plan.provider,
      plan_id: plan.plan_id,
      command: plan.command,
      args: plan.args,
      exit_code: run.status,
      signal: run.signal ?? null,
      error_class: "provider_error",
      message: String(run.error),
      stderr,
    };
  }
  if (run.status !== 0) {
    return {
      ok: false,
      provider: plan.provider,
      plan_id: plan.plan_id,
      command: plan.command,
      args: plan.args,
      exit_code: run.status,
      signal: run.signal ?? null,
      error_class: "provider_error",
      message: stderr.trim() || `${plan.provider} exited with status ${run.status ?? "null"}`,
      stderr,
    };
  }
  const output = bufferToString(run.stdout).trim();
  if (!output) {
    return {
      ok: false,
      provider: plan.provider,
      plan_id: plan.plan_id,
      command: plan.command,
      args: plan.args,
      exit_code: run.status,
      signal: run.signal ?? null,
      error_class: "malformed_output",
      message: "provider returned success without output",
      stderr,
    };
  }
  return {
    ok: true,
    provider: plan.provider,
    plan_id: plan.plan_id,
    command: plan.command,
    args: plan.args,
    exit_code: run.status,
    output,
    stderr,
  };
}

function formatAdapterPrompt(task: string, injection?: AdapterContextInjection): string {
  const required = injection?.required_paths ?? [];
  const optional = injection?.optional_paths ?? [];
  if (required.length === 0 && optional.length === 0) return task;
  return [
    task,
    "",
    ADAPTER_CONTEXT_HEADER,
    ...required.map((path) => `- ${REQUIRED_SKILL_LABEL}: ${path}`),
    ...optional.map((path) => `- ${OPTIONAL_SKILL_LABEL}: ${path}`),
  ].join("\n");
}
