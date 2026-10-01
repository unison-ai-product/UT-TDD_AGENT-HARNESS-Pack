export interface RawHookInvocation {
  command?: unknown;
  args?: unknown;
}

export interface HookInvocation {
  executable: string;
  args: readonly string[];
  tokens: readonly string[];
  display: string;
  serialization: "shell" | "exec_args";
}

function shellTokens(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|\S+/g)].map(
    (match) => match[1] ?? match[2] ?? match[0],
  );
}

/** Claude/Codex hook JSONをsemantic executable+argvへ正規化する。 */
export function parseHookInvocation(raw: RawHookInvocation): HookInvocation | null {
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) return null;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string")) return null;
    const executable = raw.command.trim();
    const args = raw.args as string[];
    return {
      executable,
      args,
      tokens: [executable, ...args],
      display: [executable, ...args].join(" "),
      serialization: "exec_args",
    };
  }
  const tokens = shellTokens(raw.command.trim());
  if (tokens.length === 0) return null;
  return {
    executable: tokens[0],
    args: tokens.slice(1),
    tokens,
    display: raw.command.trim(),
    serialization: "shell",
  };
}

export function invocationEquals(
  actual: HookInvocation,
  expected: { executable: string; args: readonly string[] },
): boolean {
  return (
    actual.executable === expected.executable &&
    actual.args.length === expected.args.length &&
    actual.args.every((arg, index) => arg === expected.args[index])
  );
}

/**
 * PLAN-L7-668 §3: Codex の現行 hook schema には `args` が無い。command は
 * `node "$(git rev-parse --show-toplevel)/<repo 相対 script path>" [固定引数...]` の
 * 1 文字列に固定する (session cwd に依存せず repo root から script を解決するため)。
 * この定数はその固定前置部分の SSoT である。
 */
export const CODEX_GIT_ROOT_PREFIX = "$(git rev-parse --show-toplevel)/";

/**
 * 固定前置部分の外側 (script path / 固定引数) に許す文字の allowlist。英数字・`.`・`_`・`-`・`/`
 * のみを許し、空白・引用符・`$` を含む shell 展開文字 (`` ` ``・`|`・`&`・`;`・`<`・`>`・`(`・`)`・
 * `*`・`?`・`~`・`!`・`{`・`}`・`\`・`%`・`^`・改行 等) は全て拒否する denylist ではなく
 * allowlist にする (denylist の列挙漏れによる injection を避けるため、2026-09-24 是正)。
 */
const CODEX_SAFE_TOKEN_RE = /^[A-Za-z0-9._/-]+$/;

/** repo 相対 script path に `..` セグメントを許さない (repo root の外への脱出を防ぐ)。 */
function hasDotDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

export type CodexCommandStringReason =
  | "bare_interpreter_command"
  | "unrooted_command_path"
  | "unsafe_command_token";

export interface CodexCommandStringParse {
  ok: boolean;
  invocation: HookInvocation | null;
  reason?: CodexCommandStringReason;
}

/**
 * Codex hooks.json の `command` 文字列 (固定前置部分 + repo 相対 script path + 固定引数) を
 * 解析する。成功時は `serialization: "exec_args"` の `HookInvocation` を返し、`args[0]` が
 * repo 相対 script path、残りが固定引数になる — これは `sourceArgs` / `wrapperArgs` (SSoT:
 * `src/lint/project-hook.ts`) と同じ shape なので、既存の `invocationEquals` でそのまま照合できる。
 */
export function parseCodexCommandString(rawCommand: unknown): CodexCommandStringParse {
  if (typeof rawCommand !== "string") return { ok: false, invocation: null };
  const command = rawCommand.trim();
  if (command.length === 0 || command === "node") {
    return { ok: false, invocation: null, reason: "bare_interpreter_command" };
  }
  const match = /^node\s+"([^"]*)"((?:\s+\S+)*)\s*$/.exec(command);
  if (!match) {
    return { ok: false, invocation: null, reason: "unrooted_command_path" };
  }
  const quoted = match[1];
  const trailingArgs = match[2].trim().length > 0 ? match[2].trim().split(/\s+/) : [];
  if (!quoted.startsWith(CODEX_GIT_ROOT_PREFIX)) {
    return { ok: false, invocation: null, reason: "unrooted_command_path" };
  }
  const scriptPath = quoted.slice(CODEX_GIT_ROOT_PREFIX.length);
  if (
    scriptPath.length === 0 ||
    !CODEX_SAFE_TOKEN_RE.test(scriptPath) ||
    hasDotDotSegment(scriptPath) ||
    trailingArgs.some((arg) => !CODEX_SAFE_TOKEN_RE.test(arg))
  ) {
    return { ok: false, invocation: null, reason: "unsafe_command_token" };
  }
  const args = [scriptPath, ...trailingArgs];
  return {
    ok: true,
    invocation: {
      executable: "node",
      args,
      tokens: ["node", ...args],
      display: command,
      serialization: "exec_args",
    },
  };
}

/** テンプレート / 実 hooks.json 生成用: `[scriptPath, ...固定引数]` から固定 command 文字列を組み立てる。 */
export function codexCommandString(parts: readonly string[]): string {
  const [scriptPath, ...fixedArgs] = parts;
  const suffix = fixedArgs.length > 0 ? ` ${fixedArgs.join(" ")}` : "";
  return `node "${CODEX_GIT_ROOT_PREFIX}${scriptPath}"${suffix}`;
}
