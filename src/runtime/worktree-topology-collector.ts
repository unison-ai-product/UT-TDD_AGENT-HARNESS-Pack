import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  normalizeTopologyPath,
  type TopologyFinding,
  type WorktreeAdminEntry,
  type WorktreeFact,
  type WorktreeTopologyInput,
} from "./worktree-topology.ts";

export interface GitCommand {
  cwd: string;
  args: readonly string[];
}

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (command: GitCommand) => GitCommandResult;

export interface RetainedTopologyRef {
  name: string;
  objectId: string;
  symbolicTarget?: string;
}

export interface ObservedTopologyPath {
  pathKey?: string;
  finding?: TopologyFinding;
}

export interface WorktreeTopologyCollection extends WorktreeTopologyInput {
  retainedRefs: RetainedTopologyRef[];
}

export interface WorktreeTopologyCollectorOptions {
  repoRoot: string;
  runGit?: GitCommandRunner;
}

interface PorcelainRecord {
  rawPath: string;
  headOid: string;
  branch?: string;
}

interface AdminRecord {
  pathKey: string;
  worktreePathKey?: string;
}

interface FindingInput {
  kind: TopologyFinding["kind"];
  operation: string;
  evidenceCode: string;
  worktreePathKey?: string;
  adminPathKey?: string;
}

interface ReachabilityInput {
  fact: WorktreeFact;
  refs: readonly RetainedTopologyRef[];
  runGit: GitCommandRunner;
  observations: TopologyFinding[];
}

interface MergedInput {
  fact: WorktreeFact;
  mainHead: string | undefined;
  runGit: GitCommandRunner;
  observations: TopologyFinding[];
}

const RETAINED_REF_PREFIXES = ["refs/heads/", "refs/remotes/origin/", "refs/tags/"];

function defaultRunGit(command: GitCommand): GitCommandResult {
  const result = spawnSync("git", ["-C", command.cwd, ...command.args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function finding(input: FindingInput): TopologyFinding {
  return {
    kind: input.kind,
    operation: input.operation,
    evidenceCode: input.evidenceCode,
    ...(input.worktreePathKey ? { worktreePathKey: input.worktreePathKey } : {}),
    ...(input.adminPathKey ? { adminPathKey: input.adminPathKey } : {}),
  };
}

function observePath(path: string, operation: string): ObservedTopologyPath {
  try {
    return { pathKey: normalizeTopologyPath(realpathSync.native(path)) };
  } catch {
    return {
      finding: finding({
        kind: "collector_parse_error",
        operation,
        evidenceCode: "realpath_unavailable",
      }),
    };
  }
}

export function observeTopologyPath(path: string): ObservedTopologyPath {
  return observePath(path, "realpath");
}

function isOutside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`);
}

function parsePorcelain(text: string): { records: PorcelainRecord[]; error: boolean } {
  const records: PorcelainRecord[] = [];
  let current: { rawPath?: string; headOid?: string; branch?: string } = {};
  let error = false;
  const finish = (): void => {
    if (!current.rawPath && !current.headOid && !current.branch) return;
    if (!current.rawPath || !current.headOid || !/^[0-9a-f]{40}$/i.test(current.headOid)) {
      error = true;
    } else {
      records.push({ rawPath: current.rawPath, headOid: current.headOid, branch: current.branch });
    }
    current = {};
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      finish();
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current.rawPath) finish();
      current.rawPath = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.headOid = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (line === "detached" || line === "bare" || line.startsWith("prunable ")) {
      // These are typed by the absence/presence of branch and by the path facts.
    } else {
      error = true;
    }
  }
  finish();
  return { records, error };
}

function commandFailed(result: GitCommandResult): boolean {
  return result.status !== 0;
}

function commandFinding(operation: string, worktreePathKey?: string): TopologyFinding {
  return finding({
    kind: "collector_command_error",
    operation,
    evidenceCode: "command_failed",
    worktreePathKey,
  });
}

function resolveObservedPath(repoRoot: string, rawPath: string): ObservedTopologyPath {
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(repoRoot, rawPath);
  if (!isAbsolute(rawPath) && isOutside(repoRoot, candidate)) {
    return {
      finding: finding({
        kind: "path_escape",
        operation: "resolve-path",
        evidenceCode: "root_escape",
      }),
    };
  }
  return observePath(candidate, "resolve-path");
}

function readGitdirPointer(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function readAdminGitdirPointer(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8").trim();
    return content && !content.includes("\n") ? content : undefined;
  } catch {
    return undefined;
  }
}

function loadAdminRecords(commonDir: string, observations: TopologyFinding[]): AdminRecord[] {
  const worktreesDir = join(commonDir, "worktrees");
  if (!existsSync(worktreesDir)) return [];
  const records: AdminRecord[] = [];
  let entries: string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    observations.push(
      finding({
        kind: "collector_parse_error",
        operation: "worktree-admin-scan",
        evidenceCode: "readdir_unavailable",
      }),
    );
    return records;
  }
  for (const entry of entries) {
    const adminPath = join(worktreesDir, entry);
    let directory: boolean;
    try {
      directory = statSync(adminPath).isDirectory();
    } catch {
      observations.push(
        finding({
          kind: "collector_parse_error",
          operation: "worktree-admin-scan",
          evidenceCode: "stat_unavailable",
        }),
      );
      continue;
    }
    if (!directory) continue;
    const observed = observePath(adminPath, "admin-realpath");
    if (!observed.pathKey) {
      if (observed.finding) observations.push(observed.finding);
      continue;
    }
    const pointer = readAdminGitdirPointer(join(adminPath, "gitdir"));
    if (!pointer) {
      observations.push(
        finding({
          kind: "collector_parse_error",
          operation: "admin-gitdir",
          evidenceCode: "gitdir_missing",
          adminPathKey: observed.pathKey,
        }),
      );
      records.push({ pathKey: observed.pathKey });
      continue;
    }
    const pointerPath = isAbsolute(pointer) ? pointer : resolve(adminPath, pointer);
    const worktreePath = observePath(dirname(pointerPath), "admin-worktree-realpath");
    if (!worktreePath.pathKey) {
      if (worktreePath.finding) {
        observations.push({ ...worktreePath.finding, adminPathKey: observed.pathKey });
      }
      records.push({ pathKey: observed.pathKey });
      continue;
    }
    records.push({ pathKey: observed.pathKey, worktreePathKey: worktreePath.pathKey });
  }
  return records.sort((left, right) => left.pathKey.localeCompare(right.pathKey));
}

function worktreeAdminMatches(worktreePath: string, adminPath: string): boolean {
  const gitPath = join(worktreePath, ".git");
  try {
    if (statSync(gitPath).isDirectory()) {
      return normalizeTopologyPath(realpathSync.native(gitPath)) === adminPath;
    }
  } catch {
    return false;
  }
  const pointer = readGitdirPointer(gitPath);
  if (!pointer) return false;
  const pointerPath = isAbsolute(pointer) ? pointer : resolve(dirname(gitPath), pointer);
  try {
    return normalizeTopologyPath(realpathSync.native(pointerPath)) === adminPath;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectRetainedRefs(
  repoRoot: string,
  runGit: GitCommandRunner,
  observations: TopologyFinding[],
): RetainedTopologyRef[] {
  const result = runGit({
    cwd: repoRoot,
    args: [
      "for-each-ref",
      "--format=%(refname)\t%(objectname)\t%(symref)",
      "refs/heads",
      "refs/remotes/origin",
      "refs/tags",
    ],
  });
  if (commandFailed(result)) {
    observations.push(
      finding({
        kind: "reachability_unavailable",
        operation: "retained-ref-enumeration",
        evidenceCode: "command_failed",
      }),
    );
    return [];
  }
  const refs: RetainedTopologyRef[] = [];
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, objectId, symbolicTarget] = line.split("\t");
    if (!name || !objectId || !RETAINED_REF_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      observations.push(
        finding({
          kind: "reachability_unavailable",
          operation: "retained-ref-enumeration",
          evidenceCode: "parse_error",
        }),
      );
      continue;
    }
    refs.push({ name, objectId, ...(symbolicTarget ? { symbolicTarget } : {}) });
  }
  return refs.sort((left, right) => left.name.localeCompare(right.name));
}

function detachedReachable(input: ReachabilityInput): boolean {
  let unavailable = false;
  for (const ref of input.refs) {
    const result = input.runGit({
      cwd: input.fact.worktreePathKey,
      args: ["merge-base", "--is-ancestor", input.fact.headOid, ref.objectId],
    });
    if (result.status === 0) return true;
    if (result.status !== 1) unavailable = true;
  }
  if (unavailable || input.refs.length === 0) {
    input.observations.push(
      finding({
        kind: "reachability_unavailable",
        operation: "reachability",
        evidenceCode: unavailable ? "command_failed" : "no_retained_ref",
        worktreePathKey: input.fact.worktreePathKey,
      }),
    );
  }
  return false;
}

function collectDirty(
  fact: WorktreeFact,
  runGit: GitCommandRunner,
  observations: TopologyFinding[],
): boolean {
  const result = runGit({
    cwd: fact.worktreePathKey,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  });
  if (commandFailed(result)) {
    observations.push(commandFinding("status", fact.worktreePathKey));
    return false;
  }
  return result.stdout.length > 0;
}

function collectMerged(input: MergedInput): boolean {
  if (input.fact.isMain || !input.fact.branch || !input.mainHead) return false;
  const result = input.runGit({
    cwd: input.fact.worktreePathKey,
    args: ["merge-base", "--is-ancestor", input.fact.headOid, input.mainHead],
  });
  if (result.status === 0) return true;
  if (result.status !== 1)
    input.observations.push(commandFinding("merge-base", input.fact.worktreePathKey));
  return false;
}

export function collectWorktreeTopology(
  options: WorktreeTopologyCollectorOptions,
): WorktreeTopologyCollection {
  const runGit = options.runGit ?? defaultRunGit;
  const observations: TopologyFinding[] = [];
  const root = observePath(options.repoRoot, "repo-root-realpath");
  if (!root.pathKey) {
    if (root.finding) observations.push(root.finding);
    return { facts: [], adminEntries: [], observations, retainedRefs: [] };
  }

  const porcelain = runGit({ cwd: options.repoRoot, args: ["worktree", "list", "--porcelain"] });
  if (commandFailed(porcelain)) {
    observations.push(commandFinding("worktree-list"));
    return { facts: [], adminEntries: [], observations, retainedRefs: [] };
  }
  const parsed = parsePorcelain(porcelain.stdout);
  if (parsed.error)
    observations.push(
      finding({
        kind: "collector_parse_error",
        operation: "worktree-porcelain",
        evidenceCode: "malformed",
      }),
    );

  const commonResult = runGit({ cwd: options.repoRoot, args: ["rev-parse", "--git-common-dir"] });
  if (commandFailed(commonResult)) {
    observations.push(commandFinding("git-common-dir"));
    return { facts: [], adminEntries: [], observations, retainedRefs: [] };
  }
  const commonRaw = commonResult.stdout.trim();
  if (!commonRaw) {
    observations.push(
      finding({
        kind: "collector_parse_error",
        operation: "git-common-dir",
        evidenceCode: "empty",
      }),
    );
    return { facts: [], adminEntries: [], observations, retainedRefs: [] };
  }
  const commonPath = resolveObservedPath(options.repoRoot, commonRaw);
  if (!commonPath.pathKey) {
    if (commonPath.finding) observations.push(commonPath.finding);
    return { facts: [], adminEntries: [], observations, retainedRefs: [] };
  }
  const adminRecords = loadAdminRecords(commonPath.pathKey, observations);
  const retainedRefs = parsed.records.some((record) => !record.branch)
    ? collectRetainedRefs(options.repoRoot, runGit, observations)
    : [];
  const mainRecord = parsed.records.find((record) => {
    const observed = resolveObservedPath(options.repoRoot, record.rawPath);
    return observed.pathKey === root.pathKey;
  });
  const facts: WorktreeFact[] = [];
  for (const record of parsed.records) {
    const observed = resolveObservedPath(options.repoRoot, record.rawPath);
    if (!observed.pathKey) {
      if (observed.finding) observations.push(observed.finding);
      continue;
    }
    const isMain = observed.pathKey === root.pathKey || record === mainRecord;
    const admin = isMain
      ? commonPath.pathKey
      : (adminRecords.find((candidate) => candidate.worktreePathKey === observed.pathKey)
          ?.pathKey ??
        normalizeTopologyPath(join(commonPath.pathKey, "worktrees", basename(observed.pathKey))));
    const fact: WorktreeFact = {
      worktreePathKey: observed.pathKey,
      adminPathKey: admin,
      headOid: record.headOid,
      isMain,
      directoryObserved: isDirectory(observed.pathKey),
      worktreeToAdminOk: isMain || worktreeAdminMatches(observed.pathKey, admin),
      adminToWorktreeOk:
        isMain ||
        adminRecords.some(
          (candidate) =>
            candidate.pathKey === admin && candidate.worktreePathKey === observed.pathKey,
        ),
      dirty: false,
      ...(record.branch ? { branch: record.branch } : {}),
      mergedIntoMain: false,
    };
    fact.dirty = collectDirty(fact, runGit, observations);
    fact.mergedIntoMain = collectMerged({
      fact,
      mainHead: mainRecord?.headOid,
      runGit,
      observations,
    });
    if (!fact.branch)
      fact.detachedRetained = detachedReachable({ fact, refs: retainedRefs, runGit, observations });
    facts.push(fact);
  }
  const registered = new Set(facts.map((fact) => fact.adminPathKey));
  const adminEntries: WorktreeAdminEntry[] = adminRecords.map((admin) => ({
    adminPathKey: admin.pathKey,
    registered: registered.has(admin.pathKey),
  }));
  return {
    facts: facts.sort((left, right) => left.worktreePathKey.localeCompare(right.worktreePathKey)),
    adminEntries: adminEntries.sort((left, right) =>
      left.adminPathKey.localeCompare(right.adminPathKey),
    ),
    observations,
    retainedRefs,
  };
}
