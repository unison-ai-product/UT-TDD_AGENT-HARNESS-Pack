/**
 * doc-split gate の I/O adapter (issue #1032)。
 * 契約: docs/design/harness/L6-function-design/doc-split-gate.md §5 / §7 / §8.1。
 * 読み取りだけを行い、harness.db にも `.ut-tdd/` にも書かない。読めない入力は fail-close の finding にする。
 */

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeDocSplit,
  classifyDoc,
  compareDocSplitFindings,
  type DocRename,
  type DocSplitBaseline,
  type DocSplitFinding,
  type DocSplitSource,
  docSplitFinding,
  measureDoc,
  parseDocSplitBaseline,
} from "./doc-split.ts";

const SOURCE_ROOTS = ["docs/design/harness", "docs/test-design/harness"] as const;
export const DOC_SPLIT_BASELINE_PATH = "docs/governance/doc-split-baseline.json";

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

export function loadDocSplitSources(repoRoot: string): {
  sources: DocSplitSource[];
  unreadable: string[];
} {
  if (!existsSync(repoRoot)) return { sources: [], unreadable: [repoRoot] };
  const sources: DocSplitSource[] = [];
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
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && classifyDoc(path) !== null) {
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

export function loadPreviousDocSplitBaseline(
  repoRoot: string,
): { kind: "found"; baseline: DocSplitBaseline } | { kind: "absent" } | { kind: "unreadable" } {
  const commit = mergeBaseCommit(repoRoot);
  if (commit === null) return { kind: "unreadable" };
  const text = showAtCommit(repoRoot, commit, DOC_SPLIT_BASELINE_PATH);
  if (text === "absent") return { kind: "absent" };
  const baseline = text === null ? null : parseDocSplitBaseline(text);
  return baseline === null ? { kind: "unreadable" } : { kind: "found", baseline };
}

export function loadMergeBaseMeasures(
  repoRoot: string,
  paths: readonly string[],
): { kind: "found"; measures: DocSplitBaseline } | { kind: "unreadable" } {
  const commit = mergeBaseCommit(repoRoot);
  if (commit === null) return { kind: "unreadable" };
  const measures: Record<string, { lines: number; responsibilities: number | null }> = {};
  for (const path of paths) {
    const text = showAtCommit(repoRoot, commit, path);
    if (text === null) return { kind: "unreadable" };
    if (text === "absent") continue;
    const { lines, responsibilities } = measureDoc({ path, text });
    measures[path] = { lines, responsibilities };
  }
  return { kind: "found", measures };
}

export function loadRenamedDocs(
  repoRoot: string,
): { kind: "found"; renames: DocRename[] } | { kind: "unreadable" } {
  const commit = mergeBaseCommit(repoRoot);
  if (commit === null) return { kind: "unreadable" };
  const output = git(repoRoot, ["diff", "-M", "--name-status", "-z", commit]);
  if (output === null) return { kind: "unreadable" };
  const fields = output.split("\0");
  const renames: DocRename[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    if (status === "") break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const [from, to] = [fields[index + 1], fields[index + 2]];
      const related = classifyDoc(from) !== null || classifyDoc(to) !== null;
      if (status.startsWith("R") && related) renames.push({ from, to });
      index += 3;
    } else {
      index += 2;
    }
  }
  return { kind: "found", renames };
}

const baseUnreadable = (reason: string): DocSplitFinding =>
  docSplitFinding(DOC_SPLIT_BASELINE_PATH, "doc-split-baseline-base-unreadable", reason);

/** 作業木の baseline。ファイルが無ければ空、読めない・解釈できなければ null。 */
function loadCurrentBaseline(repoRoot: string): DocSplitBaseline | null {
  const path = join(repoRoot, DOC_SPLIT_BASELINE_PATH);
  if (!existsSync(path)) return {};
  try {
    return parseDocSplitBaseline(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function checkDocSplit(repoRoot: string): {
  messages: string[];
  ok: boolean;
  findings: DocSplitFinding[];
} {
  const adapterFindings: DocSplitFinding[] = [];
  const loaded = loadDocSplitSources(repoRoot);
  for (const path of loaded.unreadable) {
    adapterFindings.push(docSplitFinding(path, "doc-split-input-unreadable", "unreadable"));
  }
  const current = loadCurrentBaseline(repoRoot);
  if (current === null) {
    adapterFindings.push(
      docSplitFinding(DOC_SPLIT_BASELINE_PATH, "doc-split-input-unreadable", "baseline"),
    );
  }
  const baseline = current ?? {};
  const previous = loadPreviousDocSplitBaseline(repoRoot);
  if (previous.kind === "unreadable") adapterFindings.push(baseUnreadable("previous-baseline"));
  let mergeBaseMeasures: DocSplitBaseline | null = null;
  if (previous.kind === "absent") {
    const measured = loadMergeBaseMeasures(repoRoot, Object.keys(baseline));
    if (measured.kind === "found") mergeBaseMeasures = measured.measures;
    else adapterFindings.push(baseUnreadable("merge-base-measures"));
  }
  const renamed = loadRenamedDocs(repoRoot);
  if (renamed.kind === "unreadable") adapterFindings.push(baseUnreadable("renames"));

  const result = analyzeDocSplit({
    sources: loaded.sources,
    baseline,
    previousBaseline: previous.kind === "found" ? previous.baseline : null,
    mergeBaseMeasures,
    renames: renamed.kind === "found" ? renamed.renames : [],
  });
  const findings = [...result.findings, ...adapterFindings].sort(compareDocSplitFindings);
  const { checked, over, stale } = result.summary;
  return {
    messages: [
      ...findings.map((item) => item.message),
      `checked=${checked} over=${over} stale=${stale} baseline=${result.summary.baseline}`,
    ],
    ok: findings.length === 0,
    findings,
  };
}
