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
