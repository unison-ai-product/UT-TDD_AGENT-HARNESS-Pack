/**
 * code-size gate の I/O adapter (issue #1310)。
 * 契約: docs/design/harness/L6-function-design/code-size-gate.md §5 / §6 / §8。
 * 読み取りだけを行い、harness.db にも `.ut-tdd/` にも書かない。読めない入力は fail-close の finding にする。
 */

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeCodeSize,
  CODE_SIZE_BASELINE_PATH,
  type CodeRename,
  type CodeSizeBaseline,
  type CodeSizeFinding,
  type CodeSizeSource,
  classifyCodeFile,
  codeSizeMessages,
  measureCodeFile,
  parseCodeSizeBaseline,
  recordForm,
} from "./code-size.ts";

const SOURCE_ROOTS = ["src", "tests"] as const;

function git(repoRoot: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** `git merge-base HEAD origin/main` の commit id。解決できなければ null。 */
function mergeBaseCommit(repoRoot: string): string | null {
  return git(repoRoot, ["merge-base", "HEAD", "origin/main"])?.trim() || null;
}

/** merge-base の commit にある path の内容。無ければ "absent"、git が失敗したら null。 */
function showAtCommit(repoRoot: string, commit: string, path: string): string | "absent" | null {
  const listed = git(repoRoot, ["ls-tree", "--name-only", commit, "--", path]);
  if (listed === null) return null;
  if (listed.trim() === "") return "absent";
  return git(repoRoot, ["show", `${commit}:${path}`]);
}

export function loadCodeSizeSources(repoRoot: string): {
  sources: CodeSizeSource[];
  unreadable: string[];
} {
  if (!existsSync(repoRoot)) return { sources: [], unreadable: [repoRoot] };
  const sources: CodeSizeSource[] = [];
  const unreadable: string[] = [];
  const visit = (relative: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(repoRoot, relative), { withFileTypes: true });
    } catch {
      unreadable.push(relative);
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") visit(path);
      } else if (entry.isFile() && classifyCodeFile(path) !== null) {
        try {
          sources.push({ path, text: readFileSync(join(repoRoot, path), "utf8") });
        } catch {
          unreadable.push(path);
        }
      }
    }
  };
  for (const root of SOURCE_ROOTS) {
    if (existsSync(join(repoRoot, root))) visit(root);
  }
  return { sources, unreadable };
}

export function loadPreviousCodeSizeBaseline(
  repoRoot: string,
): { kind: "found"; baseline: CodeSizeBaseline } | { kind: "absent" } | { kind: "unreadable" } {
  const commit = mergeBaseCommit(repoRoot);
  if (commit === null) return { kind: "unreadable" };
  const text = showAtCommit(repoRoot, commit, CODE_SIZE_BASELINE_PATH);
  if (text === "absent") return { kind: "absent" };
  const baseline = text === null ? null : parseCodeSizeBaseline(text);
  return baseline === null ? { kind: "unreadable" } : { kind: "found", baseline };
}

export function loadCodeSizeMergeBaseMeasures(
  repoRoot: string,
  paths: readonly string[],
): { kind: "found"; measures: CodeSizeBaseline } | { kind: "unreadable" } {
  const commit = mergeBaseCommit(repoRoot);
  if (commit === null) return { kind: "unreadable" };
  const measures: Record<string, { lines: number | null; functionExcess: number | null }> = {};
  for (const path of paths) {
    if (classifyCodeFile(path) === null) continue;
    const text = showAtCommit(repoRoot, commit, path);
    if (text === null) return { kind: "unreadable" };
    if (text === "absent") continue;
    const record = recordForm(measureCodeFile({ path, text }));
    if (record.lines !== null || record.functionExcess !== null) measures[path] = record;
  }
  return { kind: "found", measures };
}

export function loadRenamedCodeFiles(
  repoRoot: string,
): { kind: "found"; renames: CodeRename[] } | { kind: "unreadable" } {
  const commit = mergeBaseCommit(repoRoot);
  if (commit === null) return { kind: "unreadable" };
  const output = git(repoRoot, ["diff", "-M", "--name-status", "-z", commit]);
  if (output === null) return { kind: "unreadable" };
  const fields = output.split("\0");
  const renames: CodeRename[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    if (status === "" || status === undefined) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const [from, to] = [fields[index + 1] ?? "", fields[index + 2] ?? ""];
      const related = classifyCodeFile(from) !== null || classifyCodeFile(to) !== null;
      if (status.startsWith("R") && related) renames.push({ from, to });
      index += 3;
    } else {
      index += 2;
    }
  }
  return { kind: "found", renames };
}

/** 作業木の baseline。ファイルが無ければ空、読めない・解釈できなければ null。 */
function loadCurrentBaseline(repoRoot: string): CodeSizeBaseline | null {
  const path = join(repoRoot, CODE_SIZE_BASELINE_PATH);
  if (!existsSync(path)) return {};
  try {
    return parseCodeSizeBaseline(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** code-size gate の判定。ok と、人が読む行 (finding と分割先の指示と summary) を返す。 */
export function checkCodeSize(repoRoot: string): {
  messages: string[];
  ok: boolean;
  findings: CodeSizeFinding[];
} {
  const messages: string[] = [];
  const adapterFindings: CodeSizeFinding[] = [];
  let ok = true;
  const loaded = loadCodeSizeSources(repoRoot);
  for (const path of loaded.unreadable) {
    messages.push(`${path}:code-size-input-unreadable:read-failed`);
    adapterFindings.push({ path, kind: "code-size-input-unreadable", reason: "read-failed" });
    ok = false;
  }
  const current = loadCurrentBaseline(repoRoot);
  if (current === null) {
    messages.push(`${CODE_SIZE_BASELINE_PATH}:code-size-baseline-base-unreadable:working-tree`);
    adapterFindings.push({
      path: CODE_SIZE_BASELINE_PATH,
      kind: "code-size-baseline-base-unreadable",
      reason: "working-tree",
    });
    ok = false;
  }
  const previous = loadPreviousCodeSizeBaseline(repoRoot);
  let previousBaseline: CodeSizeBaseline | null = null;
  let mergeBaseMeasures: CodeSizeBaseline | null = null;
  if (previous.kind === "found") {
    previousBaseline = previous.baseline;
  } else if (previous.kind === "unreadable") {
    messages.push(`${CODE_SIZE_BASELINE_PATH}:code-size-baseline-base-unreadable:merge-base`);
    adapterFindings.push({
      path: CODE_SIZE_BASELINE_PATH,
      kind: "code-size-baseline-base-unreadable",
      reason: "merge-base",
    });
    ok = false;
  } else {
    const measured = loadCodeSizeMergeBaseMeasures(repoRoot, Object.keys(current ?? {}));
    mergeBaseMeasures = measured.kind === "found" ? measured.measures : null;
  }
  const renamed = loadRenamedCodeFiles(repoRoot);
  if (renamed.kind === "unreadable") {
    messages.push(`${CODE_SIZE_BASELINE_PATH}:code-size-baseline-base-unreadable:rename-input`);
    adapterFindings.push({
      path: CODE_SIZE_BASELINE_PATH,
      kind: "code-size-baseline-base-unreadable",
      reason: "rename-input",
    });
    ok = false;
  }
  const input = {
    sources: loaded.sources,
    baseline: current ?? {},
    previousBaseline,
    mergeBaseMeasures,
    renames: renamed.kind === "found" ? renamed.renames : [],
  };
  const result = analyzeCodeSize(input);
  messages.push(...codeSizeMessages(input, result));
  return { messages, ok: ok && result.ok, findings: [...result.findings, ...adapterFindings] };
}
