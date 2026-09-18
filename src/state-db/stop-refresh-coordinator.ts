import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const UNVERIFIABLE_OWNER_TTL_MS = 15 * 60 * 1000;
const SELF_PROCESS_BIRTH = `${process.pid}:${Date.now() - Math.floor(process.uptime() * 1000)}`;

export interface StopRefreshOwner {
  generation: string;
  pid: number;
  pids?: number[];
  process_births?: Record<string, string>;
  host: string;
  started_at: string;
  process_birth: string;
  digest: string;
}

export type StopRefreshLease =
  | { acquired: true; owner: StopRefreshOwner }
  | { acquired: false; owner?: StopRefreshOwner; reason: "active" | "unavailable" };

export interface StopRefreshCoordinatorDeps {
  pid?: number;
  host?: string;
  now?: () => number;
  generation?: () => string;
  isPidAlive?: (pid: number) => boolean;
  processBirth?: (pid: number) => string | undefined;
  ttlMs?: number;
}

interface OwnerPayload {
  generation: string;
  pid: number;
  host: string;
  started_at: string;
  process_birth: string;
}

function secureRoot(repoRoot: string): string {
  const canonicalRepo = realpathSync.native(resolve(repoRoot));
  let current = canonicalRepo;
  for (const part of [".ut-tdd", "state", "stop-refresh"]) {
    const next = join(current, part);
    try {
      mkdirSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(next);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("stop-refresh-state-path-invalid");
    const canonical = realpathSync.native(next);
    const rel = relative(canonicalRepo, canonical);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("stop-refresh-state-path-escape");
    current = canonical;
  }
  return current;
}

function generationsDir(repoRoot: string): string {
  const path = join(secureRoot(repoRoot), "generations");
  mkdirSync(path, { recursive: true });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("stop-refresh-generations-invalid");
  return path;
}

function generationDir(repoRoot: string, generation: string): string {
  validateComponent(generation);
  return join(generationsDir(repoRoot), generation);
}

function anchorPath(repoRoot: string, generation: string): string {
  return join(generationDir(repoRoot, generation), "anchor.json");
}

function activePath(repoRoot: string): string {
  return join(secureRoot(repoRoot), "active");
}

function claimedPath(repoRoot: string, generation: string): string {
  validateComponent(generation);
  return join(secureRoot(repoRoot), `claimed-${generation}`);
}

export function stopRefreshDirtyPath(repoRoot: string): string {
  return join(secureRoot(repoRoot), "dirty");
}

function validateComponent(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("stop-refresh-generation-invalid");
}

function digestPayload(payload: OwnerPayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        payload.generation,
        payload.pid,
        payload.host,
        payload.started_at,
        payload.process_birth,
      ]),
    )
    .digest("hex");
}

function parseOwner(path: string, expectedGeneration?: string): StopRefreshOwner | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StopRefreshOwner>;
    if (
      typeof raw.generation !== "string" ||
      typeof raw.pid !== "number" ||
      !Number.isSafeInteger(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.host !== "string" ||
      raw.host.length === 0 ||
      typeof raw.started_at !== "string" ||
      !Number.isFinite(Date.parse(raw.started_at)) ||
      typeof raw.process_birth !== "string" ||
      raw.process_birth.length === 0 ||
      typeof raw.digest !== "string" ||
      (expectedGeneration !== undefined && raw.generation !== expectedGeneration)
    )
      return undefined;
    const payload: OwnerPayload = {
      generation: raw.generation,
      pid: raw.pid,
      host: raw.host,
      started_at: raw.started_at,
      process_birth: raw.process_birth,
    };
    if (raw.digest !== digestPayload(payload)) return undefined;
    return { ...payload, digest: raw.digest };
  } catch {
    return undefined;
  }
}

function readActiveOwner(repoRoot: string): StopRefreshOwner | undefined {
  try {
    const active = activePath(repoRoot);
    const owner = parseOwner(active);
    if (!owner || !sameFile(active, anchorPath(repoRoot, owner.generation))) return undefined;
    const claims = readdirSync(generationDir(repoRoot, owner.generation))
      .filter((name) => /^(claim|ack)-[1-9][0-9]*\.json$/.test(name))
      .map((name) => {
        const kind = name.startsWith("ack-") ? "ack" : "claim";
        const pid = Number(name.slice(name.indexOf("-") + 1, -5));
        const claim = parseOwner(
          join(generationDir(repoRoot, owner.generation), name),
          owner.generation,
        );
        return claim?.pid === pid ? { kind, owner: claim } : undefined;
      });
    if (claims.some((claim) => !claim)) return undefined;
    const parsed = claims.filter(
      (claim): claim is { kind: "claim" | "ack"; owner: StopRefreshOwner } => claim !== undefined,
    );
    const records = new Map<number, { kind: "claim" | "ack"; owner: StopRefreshOwner }>();
    for (const record of parsed) {
      const previous = records.get(record.owner.pid);
      if (previous && previous.owner.digest !== record.owner.digest) {
        const claim = previous.kind === "claim" ? previous : record;
        const ack = previous.kind === "ack" ? previous : record;
        if (!isIdentityPromotion(claim, ack)) return undefined;
        records.set(record.owner.pid, ack);
        continue;
      }
      // An acknowledged record is canonical when an idempotent claim also remains.
      if (!previous || record.kind === "ack") records.set(record.owner.pid, record);
    }
    const canonical = [...records.values()].map((record) => record.owner);
    return {
      ...owner,
      pids: canonical.map((claim) => claim.pid),
      process_births: Object.fromEntries(
        canonical.map((claim) => [String(claim.pid), claim.process_birth]),
      ),
    };
  } catch {
    return undefined;
  }
}

function isIdentityPromotion(
  claim: { kind: "claim" | "ack"; owner: StopRefreshOwner },
  ack: { kind: "claim" | "ack"; owner: StopRefreshOwner },
): boolean {
  return (
    claim.kind === "claim" &&
    ack.kind === "ack" &&
    claim.owner.generation === ack.owner.generation &&
    claim.owner.pid === ack.owner.pid &&
    claim.owner.host === ack.owner.host &&
    claim.owner.started_at === ack.owner.started_at &&
    isUnverifiedBirth(claim.owner.process_birth, claim.owner.generation) &&
    !isUnverifiedBirth(ack.owner.process_birth, ack.owner.generation)
  );
}

function isUnverifiedBirth(value: string, generation: string): boolean {
  return value === `unverified-${generation}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function markStopRefreshDirty(repoRoot: string): boolean {
  try {
    writeFileSync(stopRefreshDirtyPath(repoRoot), "dirty\n", { flag: "wx" });
    return true;
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      markerValid(stopRefreshDirtyPath(repoRoot))
    );
  }
}

export function acquireStopRefreshLease(
  repoRoot: string,
  deps: StopRefreshCoordinatorDeps = {},
): StopRefreshLease {
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? hostname();
  const generation = (deps.generation ?? randomUUID)();
  const now = (deps.now ?? Date.now)();
  const birth = (deps.processBirth ?? probeProcessBirth)(pid) ?? `unverified-${generation}`;
  const payload: OwnerPayload = {
    generation,
    pid,
    host,
    started_at: new Date(now).toISOString(),
    process_birth: birth,
  };
  const owner: StopRefreshOwner = { ...payload, digest: digestPayload(payload) };
  try {
    validateComponent(generation);
    mkdirSync(generationDir(repoRoot, generation));
    writeOwner(anchorPath(repoRoot, generation), owner);
    writeOwner(claimPath(repoRoot, generation, pid), owner);
    try {
      linkSync(anchorPath(repoRoot, generation), activePath(repoRoot));
      return { acquired: true, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = readActiveOwner(repoRoot);
    if (!current || ownerStillActive(current, deps, now)) {
      removeGeneration(repoRoot, generation);
      return { acquired: false, owner: current, reason: "active" };
    }
    // Demand is restored while the old generation still owns `active`; no ownerless window exists.
    if (!restoreClaimedDemand(repoRoot, current.generation)) {
      removeGeneration(repoRoot, generation);
      return { acquired: false, reason: "unavailable" };
    }
    if (!moveActiveGeneration(repoRoot, current.generation, `quarantined-${current.generation}`)) {
      removeGeneration(repoRoot, generation);
      return { acquired: false, reason: "active" };
    }
    removeGeneration(repoRoot, current.generation);
    linkSync(anchorPath(repoRoot, generation), activePath(repoRoot));
    return { acquired: true, owner };
  } catch {
    removeGeneration(repoRoot, generation);
    return { acquired: false, reason: "unavailable" };
  }
}

export function ownsStopRefreshLease(repoRoot: string, generation: string): boolean {
  const owner = readActiveOwner(repoRoot);
  return owner?.generation === generation;
}

export interface TransferStopRefreshLeaseOptions {
  repoRoot: string;
  generation: string;
  fromPid: number;
  toPid: number;
}

export function transferStopRefreshLease(
  ...args:
    | [options: TransferStopRefreshLeaseOptions]
    | [repoRoot: string, generation: string, fromPid: number, toPid: number]
): boolean {
  const options =
    args.length === 1
      ? args[0]
      : { repoRoot: args[0], generation: args[1], fromPid: args[2], toPid: args[3] };
  const { repoRoot, generation, fromPid, toPid } = options;
  const owner = readActiveOwner(repoRoot);
  if (!owner || owner.generation !== generation || !owner.pids?.includes(fromPid)) return false;
  const child = ownerForPid(owner, toPid, probeProcessBirth(toPid) ?? `unverified-${generation}`);
  if (!writeOwnerExclusiveOrVerify(claimPath(repoRoot, generation, toPid), child)) return false;
  // Parent claim remains until the worker writes its ack. This closes the spawn→join gap.
  return true;
}

export interface JoinStopRefreshLeaseOptions {
  repoRoot: string;
  generation: string;
  pid?: number;
  processBirth?: (pid: number) => string | undefined;
}

export function joinStopRefreshLease(
  ...args:
    | [options: JoinStopRefreshLeaseOptions]
    | [repoRoot: string, generation: string, pid?: number]
): boolean {
  const options =
    args.length === 1 ? args[0] : { repoRoot: args[0], generation: args[1], pid: args[2] };
  const { repoRoot, generation } = options;
  const pid = options.pid ?? process.pid;
  const owner = readActiveOwner(repoRoot);
  if (!owner || owner.generation !== generation || !owner.pids?.includes(pid)) return false;
  try {
    const claimedBirth = owner.process_births?.[String(pid)];
    const observedBirth = (options.processBirth ?? probeProcessBirth)(pid);
    if (
      claimedBirth !== undefined &&
      !isUnverifiedBirth(claimedBirth, generation) &&
      observedBirth !== undefined &&
      claimedBirth !== observedBirth
    )
      return false;
    // The child self-observation is stronger than the parent's unverifiable handoff claim.
    // Verified claims may only be repeated identically; identity never moves backwards to
    // `unverified-*` after a real process birth has been observed.
    const joined = ownerForPid(
      owner,
      pid,
      observedBirth ?? claimedBirth ?? `unverified-${generation}`,
    );
    if (!writeOwnerExclusiveOrVerify(ackPath(repoRoot, generation, pid), joined)) return false;
    if (
      claimedBirth !== undefined &&
      !retireOwnerRecord(
        claimPath(repoRoot, generation, pid),
        ownerForPid(owner, pid, claimedBirth),
      )
    )
      return false;
  } catch {
    return false;
  }
  if (
    owner.pid !== pid &&
    !retireOwnerRecord(
      claimPath(repoRoot, generation, owner.pid),
      ownerForPid(owner, owner.pid, owner.process_birth),
    )
  )
    return false;
  return ownsStopRefreshLease(repoRoot, generation);
}

export function claimStopRefreshDemand(repoRoot: string, generation: string): boolean {
  if (!ownsStopRefreshLease(repoRoot, generation)) return false;
  try {
    if (existsSync(claimedPath(repoRoot, generation))) return false;
    if (!markerValid(stopRefreshDirtyPath(repoRoot))) return false;
    renameSync(stopRefreshDirtyPath(repoRoot), claimedPath(repoRoot, generation));
    return (
      markerValid(claimedPath(repoRoot, generation)) && ownsStopRefreshLease(repoRoot, generation)
    );
  } catch {
    return false;
  }
}

export function completeStopRefreshDemand(repoRoot: string, generation: string): void {
  if (!ownsStopRefreshLease(repoRoot, generation)) return;
  if (!markerValid(claimedPath(repoRoot, generation))) return;
  rmSync(claimedPath(repoRoot, generation), { force: true });
}

export function retryStopRefreshDemand(repoRoot: string, generation: string): boolean {
  if (!ownsStopRefreshLease(repoRoot, generation)) return false;
  if (!markerValid(claimedPath(repoRoot, generation))) return false;
  if (!markStopRefreshDirty(repoRoot)) return false;
  rmSync(claimedPath(repoRoot, generation), { force: true });
  return true;
}

export function recordStopRefreshFailure(
  repoRoot: string,
  generation: string,
  reason: string,
): boolean {
  try {
    validateComponent(generation);
    const failures = secureSubdirectory(repoRoot, "failures");
    const id = randomUUID();
    const receipt = {
      generation,
      occurred_at: new Date().toISOString(),
      reason: safeFailureReason(reason),
      id,
    };
    const digest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    writeFileSync(
      join(failures, `${generation}-${id}.json`),
      `${JSON.stringify({ ...receipt, digest })}\n`,
      {
        flag: "wx",
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function recordStopRefreshFailureOnce(options: {
  repoRoot: string;
  generation: string;
  reason: string;
  key: string;
}): boolean {
  try {
    validateComponent(options.generation);
    validateComponent(options.key);
    const failures = secureSubdirectory(options.repoRoot, "failures");
    const id = `once-${options.key}`;
    const receipt = {
      generation: options.generation,
      occurred_at: new Date().toISOString(),
      reason: safeFailureReason(options.reason),
      id,
    };
    const digest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const path = join(failures, `${id}.json`);
    try {
      writeFileSync(path, `${JSON.stringify({ ...receipt, digest })}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
      const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const { digest: existingDigest, ...payload } = existing;
      return (
        existing.id === id &&
        existing.reason === receipt.reason &&
        existingDigest === createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      );
    }
  } catch {
    return false;
  }
}

function safeFailureReason(reason: string): string {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(reason) ? reason : "redacted";
}

export function releaseStopRefreshLease(repoRoot: string, generation: string): void {
  if (!ownsStopRefreshLease(repoRoot, generation)) return;
  if (!moveActiveGeneration(repoRoot, generation, `released-${generation}`)) return;
  removeGeneration(repoRoot, generation);
}

function probeProcessBirth(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `${pid}:proc:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (pid === process.pid) return SELF_PROCESS_BIRTH;
  return undefined;
}

function ownerStillActive(
  owner: StopRefreshOwner,
  deps: StopRefreshCoordinatorDeps,
  now: number,
): boolean {
  const ttl = deps.ttlMs ?? UNVERIFIABLE_OWNER_TTL_MS;
  const sameHost = owner.host === (deps.host ?? hostname());
  if (!sameHost) return now - Date.parse(owner.started_at) < ttl;
  const pids = owner.pids ?? [owner.pid];
  const alivePids = pids.filter((pid) => (deps.isPidAlive ?? alive)(pid));
  if (alivePids.length === 0) return false;
  if (deps.isPidAlive && !deps.processBirth) return true;
  const birth = deps.processBirth ?? probeProcessBirth;
  for (const pid of alivePids) {
    const observed = birth(pid);
    const expected = owner.process_births?.[String(pid)];
    if (observed === undefined || expected === undefined) return true;
    if (isUnverifiedBirth(expected, owner.generation)) return true;
    if (observed === expected) return true;
  }
  // Every live PID belongs to a different process incarnation: the recorded owner is dead.
  return false;
}

function claimPath(repoRoot: string, generation: string, pid: number): string {
  return join(generationDir(repoRoot, generation), `claim-${pid}.json`);
}

function ackPath(repoRoot: string, generation: string, pid: number): string {
  return join(generationDir(repoRoot, generation), `ack-${pid}.json`);
}

function ownerForPid(owner: StopRefreshOwner, pid: number, processBirth: string): StopRefreshOwner {
  const payload: OwnerPayload = {
    generation: owner.generation,
    pid,
    host: owner.host,
    started_at: owner.started_at,
    process_birth: processBirth,
  };
  return { ...payload, digest: digestPayload(payload) };
}

function writeOwner(path: string, owner: StopRefreshOwner): void {
  writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: "wx" });
}

function writeOwnerExclusiveOrVerify(path: string, owner: StopRefreshOwner): boolean {
  try {
    writeOwner(path, owner);
    return true;
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      parseOwner(path, owner.generation)?.digest === owner.digest
    );
  }
}

function retireOwnerRecord(path: string, expected: StopRefreshOwner): boolean {
  try {
    if (!existsSync(path)) return true;
    if (parseOwner(path, expected.generation)?.digest !== expected.digest) return false;
    // Owner records are immutable (`wx` only) and generation/PID-specific, so a verified record
    // cannot be replaced by another writer between this check and its retirement.
    rmSync(path);
    return !existsSync(path);
  } catch {
    return false;
  }
}

function moveActiveGeneration(repoRoot: string, generation: string, prefix: string): boolean {
  try {
    const active = activePath(repoRoot);
    const anchor = anchorPath(repoRoot, generation);
    if (!sameFile(active, anchor)) return false;
    const tombstone = join(secureRoot(repoRoot), `${prefix}-${randomUUID()}`);
    renameSync(active, tombstone);
    if (!sameFile(tombstone, anchor)) return false;
    rmSync(tombstone, { force: true });
    return true;
  } catch {
    return false;
  }
}

function restoreClaimedDemand(repoRoot: string, generation: string): boolean {
  const claimed = claimedPath(repoRoot, generation);
  if (!existsSync(claimed)) return true;
  if (!markerValid(claimed)) return false;
  if (!markStopRefreshDirty(repoRoot)) return false;
  rmSync(claimed, { force: true });
  return true;
}

function secureSubdirectory(repoRoot: string, name: string): string {
  validateComponent(name);
  const base = secureRoot(repoRoot);
  const path = join(base, name);
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("stop-refresh-subdir-invalid");
  const canonical = realpathSync.native(path);
  const rel = relative(base, canonical);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("stop-refresh-subdir-escape");
  return canonical;
}

function markerValid(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && readFileSync(path, "utf8") === "dirty\n";
  } catch {
    return false;
  }
}

function removeGeneration(repoRoot: string, generation: string): void {
  try {
    rmSync(generationDir(repoRoot, generation), { recursive: true, force: true });
  } catch {
    // Generation-specific cleanup never mutates another generation.
  }
}

function sameFile(left: string, right: string): boolean {
  const a = lstatSync(left, { bigint: true });
  const b = lstatSync(right, { bigint: true });
  return (
    a.isFile() &&
    b.isFile() &&
    !a.isSymbolicLink() &&
    !b.isSymbolicLink() &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}
