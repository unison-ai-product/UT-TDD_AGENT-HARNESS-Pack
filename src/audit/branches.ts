import { execFileSync } from "node:child_process";

export type BranchAuditStatus = "keep" | "delete-candidate" | "review";
export type BranchAuditReason = "current" | "protected" | "gone" | "merged" | "stale" | "active";

export interface BranchAuditRow {
  name: string;
  current: boolean;
  upstream: string;
  upstreamTrack: string;
  merged: boolean;
  commitDate: string;
  ageDays: number;
  status: BranchAuditStatus;
  reason: BranchAuditReason;
}

export interface BranchAuditResult {
  ok: boolean;
  total: number;
  byStatus: Record<BranchAuditStatus, number>;
  rows: BranchAuditRow[];
}

export interface RawBranchRef {
  name: string;
  upstream: string;
  upstreamTrack: string;
  commitDate: string;
}

const PROTECTED_BRANCHES = [/^main$/, /^master$/, /^develop$/, /^dev$/, /^release\//, /^staging$/];

function parseDate(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageDays(commitDate: string, now: Date): number {
  const ts = parseDate(commitDate);
  if (ts === 0) return 0;
  return Math.max(0, Math.floor((now.getTime() - ts) / 86_400_000));
}

function isProtected(name: string): boolean {
  return PROTECTED_BRANCHES.some((pattern) => pattern.test(name));
}

export function analyzeBranches(input: {
  currentBranch: string;
  branches: RawBranchRef[];
  mergedBranchNames: string[];
  staleDays?: number;
  now?: Date;
}): BranchAuditResult {
  const staleDays = input.staleDays ?? 60;
  const now = input.now ?? new Date();
  const merged = new Set(input.mergedBranchNames);
  const rows = input.branches.map((branch): BranchAuditRow => {
    const current = branch.name === input.currentBranch;
    const branchAge = ageDays(branch.commitDate, now);
    const branchMerged = merged.has(branch.name);
    let status: BranchAuditStatus = "keep";
    let reason: BranchAuditReason = "active";
    if (current) {
      status = "keep";
      reason = "current";
    } else if (isProtected(branch.name)) {
      status = "keep";
      reason = "protected";
    } else if (branch.upstreamTrack.includes("gone")) {
      status = "delete-candidate";
      reason = "gone";
    } else if (branchMerged) {
      status = "delete-candidate";
      reason = "merged";
    } else if (branchAge >= staleDays) {
      status = "review";
      reason = "stale";
    }
    return {
      name: branch.name,
      current,
      upstream: branch.upstream,
      upstreamTrack: branch.upstreamTrack,
      merged: branchMerged,
      commitDate: branch.commitDate,
      ageDays: branchAge,
      status,
      reason,
    };
  });
  const byStatus: Record<BranchAuditStatus, number> = {
    keep: 0,
    "delete-candidate": 0,
    review: 0,
  };
  for (const row of rows) byStatus[row.status] += 1;
  return {
    ok: true,
    total: rows.length,
    byStatus,
    rows: rows.sort(
      (a, b) =>
        a.status.localeCompare(b.status) ||
        a.reason.localeCompare(b.reason) ||
        b.ageDays - a.ageDays ||
        a.name.localeCompare(b.name),
    ),
  };
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function parseBranchRefs(output: string): RawBranchRef[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name = "", upstream = "", upstreamTrack = "", commitDate = ""] = line.split("\t");
      return { name, upstream, upstreamTrack, commitDate };
    })
    .filter((row) => row.name.length > 0);
}

export function loadBranchAudit(
  repoRoot: string,
  opts: { staleDays?: number; now?: Date } = {},
): BranchAuditResult {
  const currentBranch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const refs = parseBranchRefs(
    git(repoRoot, [
      "for-each-ref",
      "refs/heads",
      "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:iso8601-strict)",
    ]),
  );
  const mergedBranchNames = git(repoRoot, ["branch", "--merged", "HEAD"])
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter(Boolean);
  return analyzeBranches({
    currentBranch,
    branches: refs,
    mergedBranchNames,
    staleDays: opts.staleDays,
    now: opts.now,
  });
}

export function renderBranchAudit(result: BranchAuditResult, limit = 50): string {
  const lines = [
    `branch audit: total=${result.total} keep=${result.byStatus.keep} delete-candidate=${result.byStatus["delete-candidate"]} review=${result.byStatus.review}`,
  ];
  for (const row of result.rows.slice(0, limit)) {
    lines.push(
      `  - ${row.status} ${row.reason} ${row.name} age=${row.ageDays}d upstream=${row.upstream || "-"} ${row.upstreamTrack || ""}`.trimEnd(),
    );
  }
  if (result.rows.length > limit) {
    lines.push(`  - (+${result.rows.length - limit} more; use --json for full rows)`);
  }
  return `${lines.join("\n")}\n`;
}
