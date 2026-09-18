import { basename } from "node:path";

const forbiddenExecutable = /^(?:bun|bunx|tsx|bash|sh|powershell|pwsh|cmd)$/i;
const forbiddenArgument = /^(?:bun|bunx|tsx)(?:\.(?:cmd|exe|bat))?$/i;

export const RUNTIME_IMAGE_SCOPES = [
  "status",
  "doctor",
  "test",
  "hook",
  "descendant",
  "download",
] as const;
export type RuntimeImageScope = (typeof RUNTIME_IMAGE_SCOPES)[number];

export function missingRuntimeImageScopes(
  observed: readonly RuntimeImageScope[],
): RuntimeImageScope[] {
  return RUNTIME_IMAGE_SCOPES.filter((scope) => !new Set(observed).has(scope));
}

export interface RuntimeImageProcessObservation {
  readonly scope: RuntimeImageScope;
  /** `absence` is an explicit port assertion that no fallback surface was invoked. */
  readonly mode: "invocation" | "absence";
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
  readonly outcome: "allowed" | "blocked";
  readonly spawned: boolean;
  readonly reason: string;
}

export interface RuntimeImageProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly shell: boolean; readonly windowsHide?: boolean };
}

export function classifyRuntimeImageProcess(
  command: string,
  args: readonly string[],
  shell: boolean,
): string {
  if (shell) return "shell-runtime";
  const executable = basename(command).replace(/\.(?:cmd|exe|bat)$/i, "");
  if (forbiddenExecutable.test(executable)) return `${executable.toLowerCase()}-runtime`;
  if (!/^node$/i.test(executable)) return "non-node-runtime";
  return args.some((arg) => forbiddenArgument.test(arg) || /\.(?:ts|tsx)$/i.test(arg))
    ? "source-or-bun-fallback"
    : "node-only";
}

export class NodeOnlyProcessObserver {
  #observations: RuntimeImageProcessObservation[] = [];

  inspect(
    input: RuntimeImageProcessInput,
    scope: RuntimeImageScope = "status",
  ): RuntimeImageProcessObservation {
    const reason = classifyRuntimeImageProcess(input.command, input.args, input.options.shell);
    const observation: RuntimeImageProcessObservation = {
      scope,
      mode: "invocation",
      command: input.command,
      args: [...input.args],
      shell: input.options.shell,
      outcome: reason === "node-only" ? "allowed" : "blocked",
      spawned: false,
      reason,
    };
    this.#observations.push(observation);
    return observation;
  }

  invoke(
    input: RuntimeImageProcessInput,
    run: () => void,
    scope: RuntimeImageScope = "status",
  ): RuntimeImageProcessObservation {
    const inspected = this.inspect(input, scope);
    if (inspected.outcome === "blocked") return inspected;
    run();
    const spawned = { ...inspected, spawned: true };
    this.#observations[this.#observations.length - 1] = spawned;
    return spawned;
  }

  /**
   * Record a scope whose forbidden operation is guarded by an explicit port.
   * This is intentionally not represented as a fake process invocation: an
   * absence proof must remain distinguishable from a child process observation.
   */
  proveNoFallback(
    scope: Exclude<RuntimeImageScope, "status" | "doctor" | "test" | "hook">,
    reason: string,
  ): RuntimeImageProcessObservation {
    const observation: RuntimeImageProcessObservation = {
      scope,
      mode: "absence",
      command: "<none>",
      args: [],
      shell: false,
      outcome: "allowed",
      spawned: false,
      reason,
    };
    this.#observations.push(observation);
    return observation;
  }

  snapshot(): readonly RuntimeImageProcessObservation[] {
    return this.#observations.map((item) => ({ ...item, args: [...item.args] }));
  }
}
