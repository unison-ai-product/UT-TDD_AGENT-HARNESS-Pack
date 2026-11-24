import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type RuntimeSignals = Partial<Record<"CLAUDECODE" | "CODEX_SANDBOX" | "CODEX_HOME", string>>;

export function writeTranscript(root: string, ...versions: string[]): string {
  return writeTranscriptRows(
    root,
    versions.map((version) => ({ type: "user", version })),
  );
}

export function writeTranscriptRows(root: string, rows: Record<string, unknown>[]): string {
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return path;
}

export function invokePostToolUse(
  cliPath: string,
  root: string,
  input: Record<string, unknown>,
  runtimeSignals: RuntimeSignals = { CLAUDECODE: "1" },
): HookResult {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete env.CLAUDECODE;
  delete env.CODEX_SANDBOX;
  delete env.CODEX_HOME;
  Object.assign(env, runtimeSignals);
  const result = spawnSync(process.execPath, [cliPath, "hook", "post-tool-use"], {
    cwd: root,
    env,
    encoding: "utf8",
    input: JSON.stringify(input),
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

export function systemMessage(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { systemMessage?: unknown };
    return typeof parsed.systemMessage === "string" ? parsed.systemMessage : undefined;
  } catch {
    return undefined;
  }
}

export function sourceTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

export function createMarkerFailureFixture(root: string): {
  transcriptPath: string;
  setupErrorCode?: string;
} {
  mkdirSync(join(root, ".ut-tdd"), { recursive: true });
  const statePath = join(root, ".ut-tdd", "state");
  writeFileSync(statePath, "not a directory", "utf8");
  let setupErrorCode: string | undefined;
  try {
    mkdirSync(join(statePath, "claude-version-warning"), { recursive: true });
  } catch (error) {
    setupErrorCode = (error as NodeJS.ErrnoException).code;
  }
  return { transcriptPath: writeTranscript(root, "2.1.293"), setupErrorCode };
}
