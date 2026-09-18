import { createHash } from "node:crypto";

export type TopologyFindingKind =
  | "link_broken"
  | "dir_missing"
  | "orphan_admin"
  | "collector_parse_error"
  | "collector_command_error"
  | "path_escape"
  | "reachability_unavailable";

export interface TopologyFinding {
  kind: TopologyFindingKind;
  operation: string;
  evidenceCode: string;
  worktreePathKey?: string;
  adminPathKey?: string;
}

export interface TopologyIdentity {
  worktreePathKey: string;
  adminPathKey: string;
  headOid: string;
  isMain: boolean;
}

export interface WorktreeFact extends TopologyIdentity {
  directoryObserved: boolean;
  worktreeToAdminOk: boolean;
  adminToWorktreeOk: boolean;
  dirty: boolean;
  branch?: string;
  mergedIntoMain: boolean;
  /** PF2 が保持 ref の到達可能性を収集して供給するまで false/undefined は安全側に倒す。 */
  detachedRetained?: boolean;
}

export interface WorktreeAdminEntry {
  adminPathKey: string;
  registered: boolean;
}

export interface WorktreeTopologyInput {
  facts: readonly WorktreeFact[];
  adminEntries: readonly WorktreeAdminEntry[];
  observations?: readonly TopologyFinding[];
}

export interface WorktreeTopologyCounts {
  total: number;
  main: number;
  dirty: number;
  detached: number;
  merged: number;
  active: number;
}

export interface WorktreeTopologyReport {
  ok: boolean;
  findings: TopologyFinding[];
  counts: WorktreeTopologyCounts;
  retirable: string[];
  healthy: number;
  identities: TopologyIdentity[];
  digest: string;
}

export interface AllowedPathRemap {
  fromPrefix: string;
  toPrefix: string;
}

export function normalizeTopologyPath(value: string): string {
  const path = value.replace(/\\/g, "/");
  const drive = /^[a-zA-Z]:\//.test(path) ? `${path[0].toUpperCase()}${path.slice(1)}` : path;
  if (drive === "/" || /^[A-Z]:\/$/.test(drive)) return drive;
  return drive.replace(/\/+$/, "");
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalIdentity(identity: TopologyIdentity): TopologyIdentity {
  return {
    ...identity,
    worktreePathKey: normalizeTopologyPath(identity.worktreePathKey),
    adminPathKey: normalizeTopologyPath(identity.adminPathKey),
  };
}

function compareIdentity(left: TopologyIdentity, right: TopologyIdentity): number {
  for (const [a, b] of [
    [left.worktreePathKey, right.worktreePathKey],
    [left.adminPathKey, right.adminPathKey],
    [left.headOid, right.headOid],
    [left.isMain ? "1" : "0", right.isMain ? "1" : "0"],
  ]) {
    const result = compareText(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

export function canonicalIdentities(identities: readonly TopologyIdentity[]): TopologyIdentity[] {
  return identities.map(canonicalIdentity).sort(compareIdentity);
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}

export function topologyDigest(identities: readonly TopologyIdentity[]): string {
  const fields = canonicalIdentities(identities).flatMap((identity) => [
    identity.worktreePathKey,
    identity.adminPathKey,
    identity.headOid,
    identity.isMain ? "1" : "0",
  ]);
  return createHash("sha256")
    .update("topology-v1:")
    .update(Buffer.concat(fields.map(frame)))
    .digest("hex");
}

function findingKey(finding: TopologyFinding): string {
  return [
    finding.kind,
    finding.operation,
    finding.evidenceCode,
    finding.worktreePathKey ?? "",
    finding.adminPathKey ?? "",
  ].join("\u0000");
}

function liveness(fact: WorktreeFact): keyof Omit<WorktreeTopologyCounts, "total" | "main"> {
  if (fact.dirty) return "dirty";
  if (!fact.branch) return "detached";
  return fact.mergedIntoMain ? "merged" : "active";
}

export function analyzeWorktreeTopology(input: WorktreeTopologyInput): WorktreeTopologyReport {
  const facts = input.facts.map((fact) => canonicalIdentity(fact) as WorktreeFact);
  const findings = new Map<string, TopologyFinding>();
  const add = (finding: TopologyFinding): void => {
    const canonical = {
      ...finding,
      ...(finding.worktreePathKey && {
        worktreePathKey: normalizeTopologyPath(finding.worktreePathKey),
      }),
      ...(finding.adminPathKey && { adminPathKey: normalizeTopologyPath(finding.adminPathKey) }),
    };
    findings.set(findingKey(canonical), canonical);
  };
  for (const observation of input.observations ?? []) add(observation);
  for (const fact of facts) {
    if (!fact.directoryObserved)
      add({
        kind: "dir_missing",
        operation: "stat-worktree",
        evidenceCode: "directory_missing",
        ...fact,
      });
    if (!fact.isMain && !fact.worktreeToAdminOk)
      add({
        kind: "link_broken",
        operation: "worktree-gitdir",
        evidenceCode: "gitdir_mismatch",
        ...fact,
      });
    if (!fact.isMain && !fact.adminToWorktreeOk)
      add({
        kind: "link_broken",
        operation: "admin-gitdir",
        evidenceCode: "back_pointer_mismatch",
        ...fact,
      });
  }
  for (const entry of input.adminEntries) {
    if (!entry.registered)
      add({
        kind: "orphan_admin",
        operation: "admin-enumeration",
        evidenceCode: "unregistered",
        adminPathKey: entry.adminPathKey,
      });
  }
  const findingList = [...findings.values()].sort((a, b) =>
    compareText(findingKey(a), findingKey(b)),
  );
  const unsafe = new Set(
    findingList.flatMap((finding) => (finding.worktreePathKey ? [finding.worktreePathKey] : [])),
  );
  const counts: WorktreeTopologyCounts = {
    total: facts.length,
    main: 0,
    dirty: 0,
    detached: 0,
    merged: 0,
    active: 0,
  };
  const retirable: string[] = [];
  for (const fact of facts) {
    if (fact.isMain) {
      counts.main += 1;
      continue;
    }
    const state = liveness(fact);
    counts[state] += 1;
    if (
      !unsafe.has(fact.worktreePathKey) &&
      (state === "merged" || (state === "detached" && fact.detachedRetained === true))
    )
      retirable.push(fact.worktreePathKey);
  }
  retirable.sort(compareText);
  const identities = canonicalIdentities(facts.filter((fact) => !unsafe.has(fact.worktreePathKey)));
  return {
    ok: findingList.length === 0,
    findings: findingList,
    counts,
    retirable,
    healthy: identities.length,
    identities,
    digest: topologyDigest(identities),
  };
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Z]:\//.test(path);
}

function prefixMatches(path: string, prefix: string): boolean {
  return prefix === "/" ? path.startsWith("/") : path === prefix || path.startsWith(`${prefix}/`);
}

function hasEscape(path: string): boolean {
  return path.split("/").includes("..");
}

export function remapTopologyIdentities(
  identities: readonly TopologyIdentity[],
  remaps: readonly AllowedPathRemap[],
): TopologyIdentity[] {
  const normalized = remaps.map((remap) => ({
    fromPrefix: normalizeTopologyPath(remap.fromPrefix),
    toPrefix: normalizeTopologyPath(remap.toPrefix),
  }));
  if (
    normalized.some(
      (remap) =>
        !isAbsolute(remap.fromPrefix) ||
        !isAbsolute(remap.toPrefix) ||
        hasEscape(remap.fromPrefix) ||
        hasEscape(remap.toPrefix),
    )
  )
    throw new Error("remap path escape");
  if (new Set(normalized.map((remap) => remap.fromPrefix)).size !== normalized.length)
    throw new Error("duplicate remap prefix");
  const apply = (path: string): string => {
    const candidates = normalized
      .filter((remap) => prefixMatches(path, remap.fromPrefix))
      .sort((a, b) => b.fromPrefix.length - a.fromPrefix.length);
    const match = candidates[0];
    if (!match) return path;
    const suffix = path.slice(match.fromPrefix.length).replace(/^\/+/, "");
    if (hasEscape(suffix)) throw new Error("remap path escape");
    return normalizeTopologyPath(
      match.toPrefix === "/"
        ? `/${suffix}`
        : suffix
          ? `${match.toPrefix}/${suffix}`
          : match.toPrefix,
    );
  };
  const result = canonicalIdentities(identities).map((identity) => ({
    ...identity,
    worktreePathKey: apply(identity.worktreePathKey),
    adminPathKey: apply(identity.adminPathKey),
  }));
  const pathKeys = result.flatMap((identity) => [identity.worktreePathKey, identity.adminPathKey]);
  if (
    new Set(pathKeys).size !== pathKeys.length ||
    new Set(result.map((identity) => JSON.stringify(identity))).size !== result.length
  )
    throw new Error("remap path collision");
  return canonicalIdentities(result);
}
