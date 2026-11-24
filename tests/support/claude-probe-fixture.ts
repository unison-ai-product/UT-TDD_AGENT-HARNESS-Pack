import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** 空白と cmd の特殊文字を含まない一時 dir (L7 §2)。 */
export function makeFixtureDir(prefix = "utccver"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface FakeClaudeOptions {
  /** 拡張子を除いた名前。既定 `claude`。 */
  name?: string;
  /** Windows の拡張子。既定 `.cmd`。 */
  ext?: ".cmd" | ".bat";
  version: string;
  exitCode?: number;
  /** POSIX の mode。既定 0o755。 */
  mode?: number;
  /** 版を出す前に素の名前で呼ぶ helper (Windows)。 */
  callHelper?: string;
}

/** 偽の claude を置き、置いた file の絶対 path を返す。記録 file は同じ dir の `invocations.log`。 */
export function writeFakeClaude(dir: string, options: FakeClaudeOptions): string {
  mkdirSync(dir, { recursive: true });
  const name = options.name ?? "claude";
  const exitCode = options.exitCode ?? 0;
  if (IS_WINDOWS) {
    const file = join(dir, `${name}${options.ext ?? ".cmd"}`);
    const lines = [
      "@echo off",
      '>>"%~dp0invocations.log" echo "%~0"',
      ...(options.callHelper ? [`call ${options.callHelper}`] : []),
      `echo ${options.version}`,
      `exit /b ${exitCode}`,
    ];
    writeFileSync(file, `${lines.join("\r\n")}\r\n`, "utf8");
    return file;
  }
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\n' "$0" >> "\${0%/*}/invocations.log"\necho ${options.version}\nexit ${exitCode}\n`,
    "utf8",
  );
  chmodSync(file, options.mode ?? 0o755);
  return file;
}

/** 記録 file の行 (Windows は引用符を外す)。無ければ空。 */
export function readInvocations(dir: string): string[] {
  const log = join(dir, "invocations.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^"(.*)"$/, "$1"));
}

/** `process.env` を写し、PATH (Windows は PATH と Path の両方) と各ケースの値だけを差し替える。 */
export function makeProbeEnv(
  pathValue: string,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = pathValue;
  if (IS_WINDOWS) env.Path = pathValue;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function joinPath(...entries: string[]): string {
  return entries.join(delimiter);
}

export function samePath(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}
