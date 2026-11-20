import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

type ChildProcessFunction = (this: unknown, ...args: unknown[]) => unknown;
type WrappedFunction = ChildProcessFunction & { [key: symbol]: unknown };

const WRAPPED = Symbol.for("ut-tdd.windowsHide.wrapped");
const childProcessMethods = [
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
  "fork",
] as const;

type ChildProcessMethod = (typeof childProcessMethods)[number];
type MutableChildProcessModule = Record<ChildProcessMethod, ChildProcessFunction>;

function isOptions(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addWindowsHide(options: unknown): Record<string, unknown> {
  const copy = isOptions(options) ? { ...options } : {};
  if (copy.windowsHide === undefined) copy.windowsHide = true;
  return copy;
}

function normalizeOptionsAndCallback(args: unknown[]): unknown[] {
  const [command, optionsOrCallback] = args;
  if (typeof optionsOrCallback === "function") {
    return [command, addWindowsHide(undefined), ...args.slice(1)];
  }
  return [command, addWindowsHide(optionsOrCallback), ...args.slice(2)];
}

function normalizeExecFile(args: unknown[]): unknown[] {
  const [file, argsOrOptionsOrCallback, optionsOrCallback] = args;
  const rest = args.slice(3);
  if (args.length === 1) return [file, [], addWindowsHide(undefined)];
  if (typeof argsOrOptionsOrCallback === "function") {
    return [file, addWindowsHide(undefined), argsOrOptionsOrCallback, ...args.slice(2)];
  }
  if (Array.isArray(argsOrOptionsOrCallback)) {
    if (args.length === 2) return [file, argsOrOptionsOrCallback, addWindowsHide(undefined)];
    if (typeof optionsOrCallback === "function") {
      return [file, argsOrOptionsOrCallback, addWindowsHide(undefined), optionsOrCallback, ...rest];
    }
    return [file, argsOrOptionsOrCallback, addWindowsHide(optionsOrCallback), ...args.slice(3)];
  }
  if (isOptions(argsOrOptionsOrCallback)) {
    return [file, addWindowsHide(argsOrOptionsOrCallback), ...args.slice(2)];
  }
  if (argsOrOptionsOrCallback == null) {
    if (args.length === 2) return [file, [], addWindowsHide(undefined)];
    if (typeof optionsOrCallback === "function") {
      return [file, [], addWindowsHide(undefined), optionsOrCallback, ...rest];
    }
    return [file, argsOrOptionsOrCallback, addWindowsHide(optionsOrCallback), ...args.slice(3)];
  }
  return [file, argsOrOptionsOrCallback, addWindowsHide(optionsOrCallback), ...args.slice(3)];
}

function normalizeArgs(method: ChildProcessMethod, args: unknown[]): unknown[] {
  if (method === "exec") return normalizeOptionsAndCallback(args);
  if (method === "execSync") {
    const [command, options, ...rest] = args;
    return [command, addWindowsHide(options), ...rest];
  }
  if (method === "execFile") return normalizeExecFile(args);

  const [command, argsOrOptions, options, ...rest] = args;
  if (args.length === 1) return [command, [], addWindowsHide(undefined)];
  if (Array.isArray(argsOrOptions)) {
    if (args.length === 2) return [command, argsOrOptions, addWindowsHide(undefined)];
    return [command, argsOrOptions, addWindowsHide(options), ...rest];
  }
  if (isOptions(argsOrOptions)) return [command, addWindowsHide(argsOrOptions), ...args.slice(2)];
  if (argsOrOptions == null) {
    if (args.length === 2) return [command, [], addWindowsHide(undefined)];
    return [command, argsOrOptions, addWindowsHide(options), ...rest];
  }
  return [command, argsOrOptions, addWindowsHide(options), ...rest];
}

function wrapChildProcessMethod(
  method: ChildProcessMethod,
  original: ChildProcessFunction,
): WrappedFunction {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    return Reflect.apply(original, this, normalizeArgs(method, args));
  } as WrappedFunction;
  Object.defineProperty(wrapped, WRAPPED, { value: original });
  return wrapped;
}

export function applyWindowsHideDefault(module: Record<string, ChildProcessFunction>): void {
  const childProcessModule = module as MutableChildProcessModule;
  for (const method of childProcessMethods) {
    const current = childProcessModule[method] as WrappedFunction;
    if (typeof current !== "function" || typeof current[WRAPPED] === "function") continue;
    childProcessModule[method] = wrapChildProcessMethod(method, current);
  }
  syncBuiltinESMExports();
}

applyWindowsHideDefault(childProcess as unknown as Record<string, ChildProcessFunction>);
