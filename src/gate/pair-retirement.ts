import { spawnSync } from "node:child_process";
import { canonicalizeVModelPath, selectVModelRoots } from "../shared/design-root.ts";
import { analyzePairFreeze, isDesignSubDoc, type PairDoc, parsePairDoc } from "../vmodel/lint.ts";

export interface PairRetirementCheck {
  ok: boolean;
  messages: string[];
}

type TreeEntry = { path: string; oid: string; mode: string; type: string };
type GitResult = { ok: true; stdout: Buffer } | { ok: false; detail: string };

const RETIREMENT_DIRECTORY = "docs/governance/design-pair-retirements/";

function git(repoRoot: string, args: string[], input?: Buffer): GitResult {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    return { ok: false, detail: result.error?.message ?? (stderr || `exit ${result.status}`) };
  }
  return { ok: true, stdout: result.stdout as Buffer };
}

function text(result: GitResult): string {
  if (!result.ok) throw new Error(result.detail);
  return result.stdout.toString("utf8").trim();
}

function resolveCommit(repoRoot: string, rev: string): string {
  const result = text(
    git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]),
  );
  if (!/^[0-9a-f]{40}$/iu.test(result)) throw new Error(`not a full commit SHA: ${rev}`);
  return result.toLowerCase();
}

function tree(repoRoot: string, commit: string): Map<string, TreeEntry> {
  const result = git(repoRoot, [
    "ls-tree",
    "-r",
    "-t",
    "-z",
    "--full-tree",
    commit,
    "--",
    "docs/design",
    "docs/test-design",
    RETIREMENT_DIRECTORY,
  ]);
  if (!result.ok) throw new Error(`${commit}: ${result.detail}`);
  const entries = new Map<string, TreeEntry>();
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const path = record.slice(tab + 1);
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (tab < 0 || !path || !mode || !type || !oid) {
      throw new Error(`${commit}: unreadable Git tree entry`);
    }
    entries.set(path, { path, mode, type, oid });
  }
  return entries;
}

function readBlobs(repoRoot: string, commit: string, entries: TreeEntry[]): Map<string, string> {
  if (entries.length === 0) return new Map();
  const unsupported = entries.find(
    (entry) => entry.type !== "blob" || !/^100(?:644|755)$/u.test(entry.mode),
  );
  if (unsupported)
    throw new Error(`${unsupported.path} at ${commit}: expected a tracked regular file`);
  const input = Buffer.from(`${entries.map((entry) => entry.oid).join("\n")}\n`, "ascii");
  const result = git(repoRoot, ["cat-file", "--batch"], input);
  if (!result.ok) {
    throw new Error(
      `${entries.map((entry) => entry.path).join(", ")} at ${commit}: ${result.detail}`,
    );
  }
  const out = new Map<string, string>();
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = result.stdout.indexOf(10, offset);
    if (headerEnd < 0) throw new Error(`${entry.path} at ${commit}: missing Git blob header`);
    const header = result.stdout.toString("ascii", offset, headerEnd).split(" ");
    const size = Number(header[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (
      header[0] !== entry.oid ||
      header[1] !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      contentEnd >= result.stdout.length ||
      result.stdout[contentEnd] !== 10
    ) {
      throw new Error(`${entry.path} at ${commit}: unreadable Git blob`);
    }
    out.set(entry.path, result.stdout.toString("utf8", contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  return out;
}

function pairTuples(docs: PairDoc[]): Set<string> {
  const analysis = analyzePairFreeze(docs);
  const orphans = new Set(analysis.orphans.map((orphan) => orphan.path));
  const byPath = new Map(docs.map((doc) => [canonicalizeVModelPath(doc.path), doc]));
  const pairs = new Set<string>();
  for (const design of docs) {
    if (!isDesignSubDoc(design) || !design.pairArtifact || orphans.has(design.path)) continue;
    const test = byPath.get(canonicalizeVModelPath(design.pairArtifact));
    if (test) pairs.add(JSON.stringify([design.path, test.path]));
  }
  return pairs;
}

function parseDeclarations(input: {
  repoRoot: string;
  mergeBase: string;
  head: string;
  baseTree: Map<string, TreeEntry>;
  headTree: Map<string, TreeEntry>;
}): Set<string> {
  const { repoRoot, mergeBase, head, baseTree, headTree } = input;
  const added = [...headTree.values()].filter(
    ({ path }) =>
      path.startsWith(RETIREMENT_DIRECTORY) &&
      /\/issue-[^/]+\.json$/u.test(path) &&
      !baseTree.has(path),
  );
  const contents = readBlobs(repoRoot, head, added);
  const declared = new Set<string>();
  const declarationError = (entry: TreeEntry, message: string) =>
    new Error(`${entry.path} at ${head}: ${message} (compared ${mergeBase}..${head})`);
  for (const entry of added) {
    const issue = /^docs\/governance\/design-pair-retirements\/issue-([1-9]\d*)\.json$/u.exec(
      entry.path,
    );
    if (!issue) throw declarationError(entry, "invalid retirement declaration path");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.get(entry.path) ?? "");
    } catch {
      throw declarationError(entry, "invalid JSON");
    }
    const pairs =
      parsed && typeof parsed === "object" && "pairs" in parsed ? parsed.pairs : undefined;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw declarationError(entry, "pairs must be a non-empty array");
    }
    const declarations: unknown[] = pairs;
    for (const item of declarations) {
      if (!item || typeof item !== "object")
        throw declarationError(entry, "invalid pair declaration");
      if (
        !("design" in item) ||
        typeof item.design !== "string" ||
        !("testDesign" in item) ||
        typeof item.testDesign !== "string"
      ) {
        throw declarationError(entry, "design and testDesign paths are required");
      }
      const paths = [item.design, item.testDesign];
      if (
        paths.some(
          (path) =>
            path.includes("\\") ||
            path.startsWith("/") ||
            path.split("/").some((part) => !part || part === "." || part === ".."),
        )
      ) {
        throw declarationError(entry, "paths must be canonical repo-relative paths");
      }
      const key = JSON.stringify(paths);
      if (declared.has(key)) throw declarationError(entry, `duplicate pair ${key}`);
      declared.add(key);
    }
  }
  return declared;
}

export function checkPairRetirement(
  repoRoot: string,
  baseCommit: string,
  headCommit: string,
): PairRetirementCheck {
  let mergeBase = baseCommit;
  let head = headCommit;
  try {
    const resolvedBase = resolveCommit(repoRoot, baseCommit);
    head = resolveCommit(repoRoot, headCommit);
    mergeBase = text(git(repoRoot, ["merge-base", resolvedBase, head]));
    mergeBase = resolveCommit(repoRoot, mergeBase);
    const baseTree = tree(repoRoot, mergeBase);
    const headTree = tree(repoRoot, head);
    const markdown = (entries: Map<string, TreeEntry>) => {
      const roots = selectVModelRoots((path) => entries.get(path)?.type === "tree");
      return [...entries.values()].filter(
        ({ path, type }) =>
          type !== "tree" &&
          path.endsWith(".md") &&
          (path.startsWith(`${roots.designRoot}/`) || path.startsWith(`${roots.testDesignRoot}/`)),
      );
    };
    const baseBlobs = readBlobs(repoRoot, mergeBase, markdown(baseTree));
    const headBlobs = readBlobs(repoRoot, head, markdown(headTree));
    const toDocs = (blobs: Map<string, string>) =>
      [...blobs].map(([path, content]) => parsePairDoc(path, content));
    const baseline = pairTuples(toDocs(baseBlobs));
    const current = pairTuples(toDocs(headBlobs));
    const declared = parseDeclarations({ repoRoot, mergeBase, head, baseTree, headTree });
    const missing = [...baseline].filter((pair) => !current.has(pair)).sort();
    const unannounced = missing.filter((pair) => !declared.has(pair));
    const extra = [...declared].filter((pair) => !baseline.has(pair) || current.has(pair)).sort();
    const messages = [
      `pair-retirement - compared merge-base ${mergeBase} to head ${head}`,
      ...unannounced.map((pair) => `pair-retirement - undeclared lost pair ${pair}`),
      ...extra.map((pair) => `pair-retirement - extra or retained declaration ${pair}`),
    ];
    return { ok: unannounced.length === 0 && extra.length === 0, messages };
  } catch (error) {
    return {
      ok: false,
      messages: [
        `pair-retirement - violation: ${String(error)} (compared ${mergeBase} to ${head})`,
      ],
    };
  }
}

export function checkPairRetirementFromEnvironment(
  repoRoot: string,
  env: Record<string, string | undefined>,
): PairRetirementCheck {
  const inputs = [
    env.PAIR_RETIREMENT_EVENT_NAME,
    env.PAIR_RETIREMENT_BASE_SHA,
    env.PAIR_RETIREMENT_HEAD_SHA,
  ];
  const actionsPresent = env.GITHUB_ACTIONS !== undefined || env.GITHUB_EVENT_NAME !== undefined;
  if (!actionsPresent && inputs.every((value) => value === undefined)) {
    try {
      const base = resolveCommit(repoRoot, "origin/main");
      const head = resolveCommit(repoRoot, "HEAD");
      return checkPairRetirement(repoRoot, base, head);
    } catch (error) {
      return {
        ok: false,
        messages: [
          `pair-retirement - violation: local comparison could not resolve origin/main and HEAD: ${String(error)}`,
        ],
      };
    }
  }
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !env.GITHUB_EVENT_NAME ||
    !env.PAIR_RETIREMENT_EVENT_NAME ||
    env.PAIR_RETIREMENT_EVENT_NAME !== env.GITHUB_EVENT_NAME
  ) {
    return {
      ok: false,
      messages: [
        `pair-retirement - violation: CI event inputs are missing or inconsistent (event=${env.GITHUB_EVENT_NAME ?? ""}, pair-event=${env.PAIR_RETIREMENT_EVENT_NAME ?? ""})`,
      ],
    };
  }
  const base = env.PAIR_RETIREMENT_BASE_SHA ?? "";
  const head = env.PAIR_RETIREMENT_HEAD_SHA ?? "";
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    if (base || head)
      return {
        ok: false,
        messages: [
          `pair-retirement - violation: non-PR event ${env.GITHUB_EVENT_NAME} must not provide PR SHAs`,
        ],
      };
    return {
      ok: true,
      messages: [`pair-retirement - skipped for non-PR CI event ${env.GITHUB_EVENT_NAME}`],
    };
  }
  if (!/^[0-9a-f]{40}$/iu.test(base) || !/^[0-9a-f]{40}$/iu.test(head)) {
    return {
      ok: false,
      messages: [
        `pair-retirement - violation: pull_request requires full base/head commit SHAs (base=${base}, head=${head})`,
      ],
    };
  }
  return checkPairRetirement(repoRoot, base, head);
}
