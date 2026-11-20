import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export type PathClaudeProbe = { kind: "not_found" } | { kind: "found"; version: string | null };

const WINDOWS_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const FOUND_UNREADABLE: PathClaudeProbe = { kind: "found", version: null };

// Windows の env は大小無視で引く (写した env は key の大小を保つ)。
function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function isAbsoluteEntry(entry: string, windows: boolean): boolean {
  return windows ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(entry) : posix.isAbsolute(entry);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return isRegularFile(path);
  } catch {
    return false;
  }
}

/** L6 claude-version-probe §3: PATH を自分で走査し、最初の候補の絶対 path を 1 つ返す。 */
function resolveCandidate(env: NodeJS.ProcessEnv, windows: boolean): string | null {
  const pathValue = envValue(env, "PATH", windows) ?? envValue(env, "Path", windows) ?? "";
  const entries = pathValue
    .split(windows ? ";" : ":")
    .filter((entry) => entry !== "" && isAbsoluteEntry(entry, windows));
  if (!windows) {
    for (const dir of entries) {
      const file = posix.join(dir, "claude");
      if (isExecutableFile(file)) return file;
    }
    return null;
  }
  const pathExt = (envValue(env, "PATHEXT", windows) ?? DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.toLowerCase())
    .filter((ext) => WINDOWS_EXTENSIONS.includes(ext));
  for (const dir of entries) {
    for (const ext of pathExt) {
      const file = win32.join(dir, `claude${ext}`);
      if (isRegularFile(file)) return file;
    }
  }
  return null;
}

function windowsCommandShell(env: NodeJS.ProcessEnv): string | null {
  const comSpec = envValue(env, "ComSpec", true);
  if (comSpec && isAbsoluteEntry(comSpec, true)) return comSpec;
  const systemRoot = envValue(env, "SystemRoot", true);
  if (systemRoot && isAbsoluteEntry(systemRoot, true)) {
    return win32.join(systemRoot, "System32", "cmd.exe");
  }
  return null;
}

function runVersion(file: string, env: NodeJS.ProcessEnv, windows: boolean): string | null {
  const dir = windows ? win32.dirname(file) : posix.dirname(file);
  const base = { cwd: dir, env, timeout: 5_000, windowsHide: true, encoding: "utf8" } as const;
  const ext = windows ? win32.extname(file).toLowerCase() : "";
  let result: SpawnSyncReturns<string>;
  if (ext === ".cmd" || ext === ".bat") {
    const shell = windowsCommandShell(env);
    // cmd は引用符の内側でも %VAR% を展開するので、% を含む path は実行しない。
    if (!shell || file.includes("%")) return null;
    result = spawnSync(shell, ["/d", "/v:off", "/s", "/c", `""${file}" --version"`], {
      ...base,
      shell: false,
      windowsVerbatimArguments: true,
    });
  } else {
    result = spawnSync(file, ["--version"], { ...base, shell: false });
  }
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
}

export function probePathClaude(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PathClaudeProbe {
  try {
    const windows = platform === "win32";
    const file = resolveCandidate(env, windows);
    if (!file) return { kind: "not_found" };
    return { kind: "found", version: runVersion(file, env, windows) };
  } catch {
    return FOUND_UNREADABLE;
  }
}
