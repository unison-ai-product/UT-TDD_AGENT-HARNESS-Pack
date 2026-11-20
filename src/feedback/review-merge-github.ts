import { execFileSync } from "node:child_process";
import { GH_COMMAND_TIMEOUT_MS, ghCommandEnv } from "../github/gh-command.ts";
import type { PrObservation } from "./review-dispatch.ts";

export interface MergeGateFacts extends PrObservation {
  /** 評価対象として取得した HEAD。adapter 内の二重観測がずれたら fail-close する。 */
  evaluatedHeadSha: string;
}

export interface GhPrMergePorts {
  getPullRequest: (pr: number) => MergeGateFacts;
  mergePullRequest: (pr: number, headSha: string) => void;
  checkBaselineConflict?: (repoRoot: string, headSha: string) => string | null;
  readMergeCommitTree?: (pr: number) => string | null;
}

interface GhPrView {
  headRefOid?: unknown;
  state?: unknown;
  statusCheckRollup?: unknown;
}

type ExecFileSync = typeof execFileSync;

interface RollupEntry {
  __typename?: unknown;
  workflowName?: unknown;
  name?: unknown;
  context?: unknown;
  conclusion?: unknown;
  detailsUrl?: unknown;
  startedAt?: unknown;
}

function checkRunId(entry: RollupEntry): string | undefined {
  if (typeof entry.detailsUrl !== "string") return undefined;
  // L6 §2: GitHub Actions job URL だけを URL の構造として解析する。
  let url: URL;
  try {
    url = new URL(entry.detailsUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  if (entry.detailsUrl !== `https://github.com${url.pathname}` || url.pathname.includes("%")) {
    return undefined;
  }
  return /^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/\d+$/.exec(url.pathname)?.[1];
}

/** 同じ check 名の重複から最新 run だけを選ぶ。順序を決められなければ undefined。 */
function pickLatestRunEntry(group: RollupEntry[]): RollupEntry | undefined {
  const startedByRun = new Map<string, { time: number; entries: RollupEntry[] }>();
  for (const entry of group) {
    const runId = checkRunId(entry);
    const time = typeof entry.startedAt === "string" ? Date.parse(entry.startedAt) : Number.NaN;
    if (
      entry.__typename !== "CheckRun" ||
      typeof entry.workflowName !== "string" ||
      entry.workflowName === "" ||
      runId === undefined ||
      Number.isNaN(time)
    ) {
      return undefined;
    }
    const current = startedByRun.get(runId);
    if (current) {
      current.time = Math.min(current.time, time);
      current.entries.push(entry);
    } else {
      startedByRun.set(runId, { time, entries: [entry] });
    }
  }
  if (startedByRun.size < 2) return undefined;
  const runs = [...startedByRun.values()].sort((a, b) => b.time - a.time);
  const [latest, next] = runs;
  if (latest === undefined || next === undefined) return undefined;
  if (latest.time === next.time || latest.entries.length !== 1) return undefined;
  return latest.entries[0];
}

function evaluateChecksGreen(rollup: unknown[]): boolean {
  if (rollup.length === 0) return false;
  const groups = new Map<string, RollupEntry[]>();
  for (const raw of rollup) {
    if (raw === null || typeof raw !== "object") return false;
    const entry = raw as RollupEntry;
    const name = typeof entry.name === "string" ? entry.name : entry.context;
    const key = JSON.stringify([
      typeof entry.workflowName === "string" ? entry.workflowName : "",
      typeof name === "string" ? name : "",
    ]);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  for (const group of groups.values()) {
    const selected = group.length === 1 ? group[0] : pickLatestRunEntry(group);
    if (selected?.conclusion !== "SUCCESS") return false;
  }
  return true;
}

function readGhView(pr: number, runGh: ExecFileSync): Omit<MergeGateFacts, "evaluatedHeadSha"> {
  const raw = runGh(
    "gh",
    ["pr", "view", String(pr), "--json", "headRefOid,state,statusCheckRollup"],
    { encoding: "utf8", timeout: GH_COMMAND_TIMEOUT_MS, env: ghCommandEnv(process.env) },
  );
  const parsed = JSON.parse(raw) as GhPrView;
  if (
    typeof parsed.headRefOid !== "string" ||
    !["OPEN", "MERGED", "CLOSED"].includes(parsed.state as string) ||
    !Array.isArray(parsed.statusCheckRollup)
  ) {
    throw new Error("gh PR facts invalid");
  }
  return {
    pr,
    headSha: parsed.headRefOid,
    state: parsed.state as MergeGateFacts["state"],
    checksGreen: evaluateChecksGreen(parsed.statusCheckRollup),
  };
}

function readGhFacts(pr: number, runGh: ExecFileSync): MergeGateFacts {
  const observed = readGhView(pr, runGh);
  const evaluated = readGhView(pr, runGh);
  return {
    ...observed,
    state: evaluated.state,
    checksGreen: evaluated.checksGreen,
    evaluatedHeadSha: evaluated.headSha,
  };
}

function readGhMergeCommitTree(pr: number, runGh: ExecFileSync): string {
  const raw = runGh("gh", ["pr", "view", String(pr), "--json", "mergeCommit"], {
    encoding: "utf8",
    timeout: GH_COMMAND_TIMEOUT_MS,
    env: ghCommandEnv(process.env),
  });
  const parsed = JSON.parse(raw) as { mergeCommit?: { oid?: unknown } | null };
  const mergeCommitSha = parsed.mergeCommit?.oid;
  if (typeof mergeCommitSha !== "string" || !/^[0-9a-f]{40,64}$/i.test(mergeCommitSha)) {
    throw new Error("merge_commit_sha_unavailable");
  }
  runGh("git", ["fetch", "origin", mergeCommitSha], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const treeSha = String(
    runGh("git", ["rev-parse", `${mergeCommitSha}^{tree}`], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) throw new Error("merge_commit_tree_sha_invalid");
  return treeSha;
}

export function createGhPrMergePorts(
  dependencies: { execFileSync?: ExecFileSync } = {},
): GhPrMergePorts {
  const runGh = dependencies.execFileSync ?? execFileSync;
  return {
    getPullRequest: (pr) => readGhFacts(pr, runGh),
    mergePullRequest: (pr, headSha) => {
      runGh("gh", ["pr", "merge", String(pr), "--merge", "--match-head-commit", headSha], {
        stdio: "inherit",
        timeout: GH_COMMAND_TIMEOUT_MS,
        env: ghCommandEnv(process.env),
      });
    },
    readMergeCommitTree: (pr) => readGhMergeCommitTree(pr, runGh),
  };
}
