// 契約形の stub (issue #1665 の Red、設計書保護 gate §10.3 手順 1')。
// 契約: docs/design/harness/L6-function-design/snapshot-runner-lock.md と
// snapshot-runner-lock-protocol.md。判定・測定・I/O の実装は Green の PR で入れる。
// ここが返す値は fail-close の値だけで、成功を期待する oracle を偶然通さない。

export interface ProcessIdentity {
  pid: number;
  startToken: string | null;
}
export type ProcessObservation = ProcessIdentity | null | "query_failed";
export type Presence = true | false | "unknown";
export interface SnapshotLockRecord {
  schema: 1;
  lockId: string;
  runner: { pid: number; startToken: string };
  repoRoot: string;
  queuedAt: string;
  generation: number | null;
  acquiredAt: string | null;
}
export type SnapshotLockRead =
  | { kind: "text"; text: string }
  | { kind: "error"; code: string | null };
export type SnapshotLockReadResult =
  | { kind: "ok"; record: SnapshotLockRecord }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };
export type ClaimState = "live" | "stale";
export interface SnapshotLockStepInput {
  self: { lockId: string; queuedAt: string };
  current: { generation: number; state: "free" | "live" | "stale" } | null;
  waiters: { lockId: string; queuedAt: string; state: ClaimState }[];
  waitedMs: number;
  maxWaitMs: number;
}
export type SnapshotLockStep =
  | { action: "attempt"; generation: number }
  | { action: "wait" }
  | { action: "give_up" };
export type SnapshotLockMode = "skip_ci" | "nested" | "acquire";
export type SnapshotLockAcquisition =
  | { kind: "acquired"; lockId: string; generation: number; release: () => void }
  | { kind: "nested"; generation: number }
  | { kind: "skipped_ci" }
  | { kind: "busy"; holder: SnapshotLockRecord | null; waitedMs: number; lockDir: string }
  | { kind: "unavailable"; reason: string; lockDir: string };
export interface SnapshotLockModeInput {
  env: { CI?: string; UT_TDD_SNAPSHOT_LOCK_TOKEN?: string };
  current: { record: SnapshotLockRecord; released: boolean } | null;
  currentPresence: Presence | null;
}

export interface SnapshotLockIo {
  mkdir(path: string): void;
  writeFile(path: string, data: string): void;
  rename(from: string, to: string): void;
  link(existing: string, created: string): void;
  readFile(path: string): string;
  readdir(path: string): string[];
  unlink(path: string): void;
}
export interface SnapshotLockDeps {
  io: SnapshotLockIo;
  presence(pid: number): Presence;
  observeIdentity(pid: number): ProcessObservation;
  now(): number;
  sleep(ms: number): void;
  write(line: string): void;
  resolveMode(input: SnapshotLockModeInput): SnapshotLockMode;
  interpretRead(read: SnapshotLockRead): SnapshotLockReadResult;
  classify(
    record: SnapshotLockRecord,
    presence: Presence,
    observed: ProcessObservation | "not_observed",
  ): ClaimState;
  decide(input: SnapshotLockStepInput): SnapshotLockStep;
}
export interface SnapshotLockOptions {
  tmpRoot: string;
  repoRoot: string;
  env: { CI?: string; UT_TDD_SNAPSHOT_LOCK_TOKEN?: string };
  maxWaitMs: number;
}

export function resolveSnapshotLockMode(_input: SnapshotLockModeInput): SnapshotLockMode {
  return "acquire";
}
export function parseSnapshotLockWaitMs(
  _raw: string | undefined,
): { ok: true; ms: number } | { ok: false; message: string } {
  return { ok: false, message: "not implemented" };
}
export function presenceFromKill(_errorCode: string | null): Presence {
  return "unknown";
}
export function snapshotLockDir(_tmpRoot: string): string {
  return "";
}
export function interpretSnapshotLockRead(_read: SnapshotLockRead): SnapshotLockReadResult {
  return { kind: "unavailable", reason: "not_implemented" };
}
export function classifySnapshotLockClaim(
  _record: SnapshotLockRecord,
  _presence: Presence,
  _observed: ProcessObservation | "not_observed",
): ClaimState {
  return "live";
}
export function decideSnapshotLockStep(_input: SnapshotLockStepInput): SnapshotLockStep {
  return { action: "wait" };
}
export function identityProbeDue(_lastProbeMs: number | null, _nowMs: number): boolean {
  return false;
}
export function snapshotStageEnv(
  env: NodeJS.ProcessEnv,
  _acquisition: SnapshotLockAcquisition,
): NodeJS.ProcessEnv {
  return { ...env };
}
export function acquireSnapshotLock(
  options: SnapshotLockOptions,
  _deps: SnapshotLockDeps,
): SnapshotLockAcquisition {
  return { kind: "unavailable", reason: "not_implemented", lockDir: options.tmpRoot };
}
