/**
 * Privacy scan adapters (issue #1391): git, Pack artifact, and denylist-file reading.
 * Contract: docs/design/harness/L6-function-design/privacy-scan.md §2, §4, §6, §10.
 * Unreadable inputs never collapse into "no hits" (fail-close). The denylist is read only
 * from `<home>/.ut-tdd/privacy-denylist.txt`; its contents never leave the parsed regexes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  analyzePrivacyScan,
  PRIVACY_SCAN_BASELINE_PATH,
  type PreviousPrivacyBaseline,
  type PrivacyBaseline,
  type PrivacyDenylistState,
  type PrivacyScanResult,
  type PrivacyUnit,
  parsePrivacyBaseline,
  parsePrivacyDenylist,
  privacyScanMessages,
} from "./privacy-scan.ts";

export const PRIVACY_DENYLIST_RELATIVE_PATH = [".ut-tdd", "privacy-denylist.txt"] as const;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const decoder = new TextDecoder("utf-8");

function gitBytes(repoRoot: string, args: readonly string[], input?: string): Buffer {
  return execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", ...args], {
    encoding: "buffer",
    input: input === undefined ? undefined : Buffer.from(input, "utf8"),
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

const gitText = (repoRoot: string, args: readonly string[]) =>
  decoder.decode(gitBytes(repoRoot, args)).trim();

const toLines = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }));

function pathUnit(source: PrivacyUnit["source"], path: string, commit: string | null): PrivacyUnit {
  return { source, path, commit, field: "path", lines: [{ line: 0, text: path }] };
}

/** Reads every blob of `rev` with one `git cat-file --batch` call. */
function readBlobs(repoRoot: string, ids: readonly string[]): Buffer[] {
  if (ids.length === 0) return [];
  const out = gitBytes(repoRoot, ["cat-file", "--batch"], `${ids.join("\n")}\n`);
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const _ of ids) {
    const headerEnd = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (header[1] !== "blob") throw new Error("blob unavailable");
    const size = Number(header[2]);
    blobs.push(out.subarray(headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return blobs;
}

export function loadTreePrivacyUnits(
  repoRoot: string,
  rev: string,
): { kind: "found"; units: PrivacyUnit[]; skipped: number } | { kind: "unreadable" } {
  try {
    const entries = decoder
      .decode(gitBytes(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", rev]))
      .split("\0")
      .filter(Boolean)
      .map((record) => /^\d+ (\w+) ([0-9a-f]+)\t(.+)$/s.exec(record))
      .filter((match): match is RegExpExecArray => match !== null && match[1] === "blob");
    const blobs = readBlobs(
      repoRoot,
      entries.map((match) => match[2]),
    );
    const units: PrivacyUnit[] = [];
    let skipped = 0;
    entries.forEach((match, index) => {
      const path = match[3];
      units.push(pathUnit("tree", path, null));
      if (blobs[index].includes(0)) {
        skipped += 1;
        return;
      }
      const lines = toLines(decoder.decode(blobs[index]));
      units.push({ source: "tree", path, commit: null, field: "content", lines });
    });
    return { kind: "found", units, skipped };
  } catch {
    return { kind: "unreadable" };
  }
}

function unquote(path: string): string {
  return path.startsWith('"') ? JSON.parse(path) : path;
}

type DiffHunk = { oldRemaining: number; newRemaining: number };
type DiffState = {
  current: { line: number; text: string }[] | null;
  next: number;
  hunk: DiffHunk | null;
};

function parseDiffHunkHeader(line: string, state: DiffState): void {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  state.next = Number(match?.[3] ?? 0);
  state.hunk = {
    oldRemaining: Number(match?.[2] ?? 1),
    newRemaining: Number(match?.[4] ?? 1),
  };
  if (state.hunk.oldRemaining === 0 && state.hunk.newRemaining === 0) state.hunk = null;
}

function consumeDiffHunkLine(line: string, state: DiffState): void {
  const hunk = state.hunk;
  if (hunk === null || line.startsWith("\\ No newline at end of file")) return;
  if (line.startsWith(" ")) {
    hunk.oldRemaining -= 1;
    hunk.newRemaining -= 1;
    state.next += 1;
  } else if (line.startsWith("-")) {
    hunk.oldRemaining -= 1;
  } else if (line.startsWith("+")) {
    state.current?.push({ line: state.next, text: line.slice(1) });
    hunk.newRemaining -= 1;
    state.next += 1;
  }
  if (hunk.oldRemaining === 0 && hunk.newRemaining === 0) state.hunk = null;
}

/** Parses a `git diff -U0` patch into added-line units (paths are read by `addedPathUnits`). */
function diffUnits(patch: string, commit: string): PrivacyUnit[] {
  const units: PrivacyUnit[] = [];
  const state: DiffState = { current: null, next: 0, hunk: null };
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      state.current = null;
      state.hunk = null;
    } else if (state.hunk !== null) {
      consumeDiffHunkLine(line, state);
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target === "/dev/null") continue;
      const path = unquote(target).replace(/^b\//, "");
      state.current = [];
      units.push({ source: "diff", path, commit, field: "content", lines: state.current });
    } else if (line.startsWith("@@ ")) {
      parseDiffHunkHeader(line, state);
    }
  }
  return units;
}

/**
 * L6 §2: the path of every added or renamed file, read from `--name-status` so a rename without a
 * content change (no `+++` header in the patch) still yields its destination path.
 */
function addedPathUnits(repoRoot: string, parent: string, commit: string): PrivacyUnit[] {
  const fields = decoder
    .decode(
      gitBytes(repoRoot, [
        "diff",
        "--no-ext-diff",
        "-z",
        "--name-status",
        "-M",
        "--diff-filter=AR",
        parent,
        commit,
      ]),
    )
    .split("\0");
  const units: PrivacyUnit[] = [];
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index];
    const path = status.startsWith("R") ? fields[index + 2] : fields[index + 1];
    index += status.startsWith("R") ? 3 : 2;
    units.push(pathUnit("diff", path, commit));
  }
  return units;
}

function metaUnits(repoRoot: string, commit: string): PrivacyUnit[] {
  const [author, committer, message] = decoder
    .decode(gitBytes(repoRoot, ["show", "-s", "--format=%ae%x00%ce%x00%B", commit]))
    .split("\0");
  const meta = (field: PrivacyUnit["field"], lines: PrivacyUnit["lines"]): PrivacyUnit => ({
    source: "commit-meta",
    path: null,
    commit,
    field,
    lines,
  });
  return [
    meta("author", [{ line: 1, text: author ?? "" }]),
    meta("committer", [{ line: 1, text: committer ?? "" }]),
    meta("message", toLines((message ?? "").replace(/\n+$/, ""))),
  ];
}

export function loadDiffPrivacyUnits(
  repoRoot: string,
  range: { base: string; head: string },
): { kind: "found"; units: PrivacyUnit[] } | { kind: "unreadable" } {
  try {
    const mergeBase = gitText(repoRoot, ["merge-base", range.base, range.head]);
    const commits = gitText(repoRoot, ["rev-list", `${mergeBase}..${range.head}`])
      .split(/\r?\n/)
      .filter(Boolean);
    const units: PrivacyUnit[] = [];
    for (const commit of commits) {
      const parents = gitText(repoRoot, ["rev-list", "--parents", "-n", "1", commit]).split(" ");
      const firstParent = parents[1] ?? EMPTY_TREE;
      const patch = gitBytes(repoRoot, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-U0",
        "-M",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        firstParent,
        commit,
      ]);
      units.push(
        ...diffUnits(decoder.decode(patch), commit),
        ...addedPathUnits(repoRoot, firstParent, commit),
        ...metaUnits(repoRoot, commit),
      );
    }
    return { kind: "found", units };
  } catch {
    return { kind: "unreadable" };
  }
}

function readBaselineAt(repoRoot: string, rev: string): PreviousPrivacyBaseline {
  const listing = gitText(repoRoot, ["ls-tree", rev, "--", PRIVACY_SCAN_BASELINE_PATH]);
  if (listing === "") return { kind: "absent" };
  const parsed = parsePrivacyBaseline(
    decoder.decode(gitBytes(repoRoot, ["show", `${rev}:${PRIVACY_SCAN_BASELINE_PATH}`])),
  );
  return parsed === null ? { kind: "unreadable" } : { kind: "found", baseline: parsed };
}

export function loadPreviousPrivacyBaseline(repoRoot: string): PreviousPrivacyBaseline {
  try {
    return readBaselineAt(repoRoot, gitText(repoRoot, ["merge-base", "HEAD", "origin/main"]));
  } catch {
    return { kind: "unreadable" };
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function readPrivacyDenylistFile(input: {
  homeDirectory: string;
  repoRoot: string;
}): PrivacyDenylistState {
  const path = join(input.homeDirectory, ...PRIVACY_DENYLIST_RELATIVE_PATH);
  if (isWithin(input.repoRoot, path)) return { kind: "in-repo" };
  if (!existsSync(path)) return { kind: "absent" };
  try {
    // A junction or symlink can place the file inside the repo; compare the real paths too.
    if (isWithin(realpathSync.native(input.repoRoot), realpathSync.native(path)))
      return { kind: "in-repo" };
    if (!statSync(path).isFile()) return { kind: "unreadable" };
    return parsePrivacyDenylist(readFileSync(path, "utf8"));
  } catch {
    return { kind: "unreadable" };
  }
}

function treeInput(repoRoot: string, rev: string) {
  const loaded = loadTreePrivacyUnits(repoRoot, rev);
  let baseline: PrivacyBaseline = [];
  let baselineUnreadable = false;
  try {
    const current = readBaselineAt(repoRoot, rev);
    if (current.kind === "found") baseline = current.baseline;
    baselineUnreadable = current.kind === "unreadable";
  } catch {
    baselineUnreadable = true;
  }
  return {
    mode: "tree" as const,
    units: loaded.kind === "found" ? loaded.units : [],
    skipped: loaded.kind === "found" ? loaded.skipped : 0,
    denylist: null,
    baseline,
    baselineUnreadable,
    previousBaseline: loadPreviousPrivacyBaseline(repoRoot),
  };
}

export function checkPrivacyScan(options: {
  repoRoot: string;
  mode: "tree" | "diff";
  rev?: string;
  range?: { base: string; head: string };
}): { messages: string[]; ok: boolean } {
  let result: PrivacyScanResult;
  if (options.mode === "tree") {
    result = analyzePrivacyScan(treeInput(options.repoRoot, options.rev ?? "HEAD"));
  } else {
    const loaded = options.range
      ? loadDiffPrivacyUnits(options.repoRoot, options.range)
      : { kind: "unreadable" as const };
    result = analyzePrivacyScan({
      mode: "diff",
      units: loaded.kind === "found" ? loaded.units : [],
      skipped: 0,
      denylist: null,
      baseline: null,
      baselineUnreadable: false,
      previousBaseline: null,
    });
  }
  return { messages: privacyScanMessages(result), ok: result.ok };
}

export function scanPackPrivacy(input: {
  artifacts: readonly { path: string; text: string }[];
  repoRoot: string;
  homeDirectory: string;
}): PrivacyScanResult {
  const units: PrivacyUnit[] = [];
  let skipped = 0;
  for (const artifact of input.artifacts) {
    units.push(pathUnit("pack", artifact.path, null));
    if (artifact.text.includes("\u0000")) skipped += 1;
    else
      units.push({
        source: "pack",
        path: artifact.path,
        commit: null,
        field: "content",
        lines: toLines(artifact.text),
      });
  }
  return analyzePrivacyScan({
    mode: "pack",
    units,
    skipped,
    denylist: readPrivacyDenylistFile(input),
    baseline: null,
    baselineUnreadable: false,
    previousBaseline: null,
  });
}
