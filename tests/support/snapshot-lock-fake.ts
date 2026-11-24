// snapshot runner lock (issue #1665) の block B 用の偽の io と stub の束ね。
// 契約: docs/test-design/harness/L7-snapshot-runner-lock-test-design.md §2。
import type {
  ClaimState,
  Presence,
  ProcessObservation,
  SnapshotLockDeps,
  SnapshotLockIo,
  SnapshotLockMode,
  SnapshotLockModeInput,
  SnapshotLockOptions,
  SnapshotLockRead,
  SnapshotLockReadResult,
  SnapshotLockRecord,
  SnapshotLockStep,
  SnapshotLockStepInput,
} from "../../src/runtime/snapshot-runner-lock.ts";
import { snapshotLockDir } from "../../src/runtime/snapshot-runner-lock.ts";

export const LOCK_TMP_ROOT = "/fake-tmp";
// lock dir の期待値は snapshotLockDir(tmpRoot) から導く (L7 §2。置き場の変異を block B に漏らさない)。
export const LOCK_DIR = snapshotLockDir(LOCK_TMP_ROOT).replace(/\\/g, "/");
export const T0 = Date.parse("2026-11-16T09:00:00.000Z");

export type FakeOpName =
  | "mkdir"
  | "writeFile"
  | "rename"
  | "link"
  | "readFile"
  | "readdir"
  | "unlink";
export const WRITE_OPS: readonly FakeOpName[] = ["mkdir", "writeFile", "rename", "link", "unlink"];
export interface FakeOp {
  name: FakeOpName;
  path: string;
  from?: string;
  /** 操作の時点で path が既に在ったか。 */
  existed: boolean;
}

const norm = (p: string): string => p.replace(/\\/g, "/");
const codeError = (code: string): Error => Object.assign(new Error(code), { code });

export function lockPath(name: string): string {
  return `${LOCK_DIR}/${name}`;
}

export function makeRecord(o: {
  lockId: string;
  generation?: number | null;
  pid?: number;
  startToken?: string;
  queuedAtMs?: number;
}): SnapshotLockRecord {
  const at = new Date(o.queuedAtMs ?? T0).toISOString();
  const generation = o.generation === undefined ? null : o.generation;
  return {
    schema: 1,
    lockId: o.lockId,
    runner: { pid: o.pid ?? 4242, startToken: o.startToken ?? `T-${o.lockId}` },
    repoRoot: "/other/repo",
    queuedAt: at,
    generation,
    acquiredAt: generation === null ? null : at,
  };
}

export class FakeLockFs {
  readonly files = new Map<string, string>();
  readonly ops: FakeOp[] = [];
  private readonly counts = new Map<string, number>();
  private readonly hooks: { name: FakeOpName; match: RegExp; nth: number; fn: () => void }[] = [];
  private readonly failures: { names: FakeOpName[]; match: RegExp; code: string }[] = [];

  seed(path: string, data = ""): void {
    this.files.set(norm(path), data);
  }
  seedGen(generation: number, record: SnapshotLockRecord): void {
    this.seed(lockPath(`gen-${generation}.json`), JSON.stringify(record));
  }
  seedReleased(generation: number): void {
    this.seed(lockPath(`released-${generation}`));
  }
  seedQueue(record: SnapshotLockRecord): void {
    this.seed(lockPath(`queue/${record.lockId}.json`), JSON.stringify(record));
  }
  has(name: string): boolean {
    return this.files.has(lockPath(name));
  }
  text(name: string): string | undefined {
    return this.files.get(lockPath(name));
  }
  queueKeys(): string[] {
    return [...this.files.keys()].filter((key) => key.includes("/queue/"));
  }
  /** 操作 (名前・path の正規表現・何回目か) の直前に 1 回だけ走る callback。 */
  hookBefore(name: FakeOpName, match: RegExp, nth: number, fn: () => void): void {
    this.hooks.push({ name, match, nth, fn });
  }
  failOn(names: FakeOpName[], match: RegExp, code: string): void {
    this.failures.push({ names, match, code });
  }
  opsNamed(...names: FakeOpName[]): FakeOp[] {
    return this.ops.filter((op) => names.includes(op.name));
  }
  writeOpCount(): number {
    return this.opsNamed(...WRITE_OPS).length;
  }
  /**
   * 操作の時点で既に在る世代ファイル / released の印への書き込み系の操作 (L7 §3.2 の 020)。
   * unlink、rename の移動元、rename の移動先 (置き換え)、writeFile の path を数える。
   * 操作の前に無い path への作成は数えない。
   */
  historyMutations(): FakeOp[] {
    const hit = (p: string | undefined): boolean =>
      p !== undefined && /\/(gen-\d+\.json|released-\d+)$/.test(p);
    return this.ops.filter((op) => {
      if (op.name === "unlink") return hit(op.path);
      if (op.name === "rename") return hit(op.from) || (hit(op.path) && op.existed);
      if (op.name === "writeFile") return hit(op.path) && op.existed;
      return false;
    });
  }
  /** 世代ファイルを作る操作 (link のほか writeFile / rename で作る実装も数える)。 */
  generationCreations(): FakeOp[] {
    return this.ops.filter(
      (op) => ["link", "writeFile", "rename"].includes(op.name) && /\/gen-\d+\.json$/.test(op.path),
    );
  }

  private enter(name: FakeOpName, path: string, from?: string): void {
    const key = norm(path);
    this.ops.push({
      name,
      path: key,
      from: from === undefined ? undefined : norm(from),
      existed: this.files.has(key),
    });
    const countKey = `${name}:${key}`;
    const nth = (this.counts.get(countKey) ?? 0) + 1;
    this.counts.set(countKey, nth);
    for (const hook of this.hooks) {
      if (hook.name === name && hook.nth === nth && hook.match.test(key)) {
        this.hooks.splice(this.hooks.indexOf(hook), 1);
        hook.fn();
        break;
      }
    }
    for (const failure of this.failures) {
      if (failure.names.includes(name) && failure.match.test(key)) throw codeError(failure.code);
    }
  }
  private set(path: string, data: string): void {
    this.files.set(path, data);
  }

  readonly io: SnapshotLockIo = {
    mkdir: (path) => {
      this.enter("mkdir", path);
    },
    writeFile: (path, data) => {
      this.enter("writeFile", path);
      this.set(norm(path), data);
    },
    rename: (from, to) => {
      this.enter("rename", to, from);
      const data = this.files.get(norm(from));
      if (data === undefined) throw codeError("ENOENT");
      this.files.delete(norm(from));
      this.set(norm(to), data);
    },
    link: (existing, created) => {
      this.enter("link", created, existing);
      const data = this.files.get(norm(existing));
      if (data === undefined) throw codeError("ENOENT");
      if (this.files.has(norm(created))) throw codeError("EEXIST");
      this.set(norm(created), data);
    },
    readFile: (path) => {
      this.enter("readFile", path);
      const data = this.files.get(norm(path));
      if (data === undefined) throw codeError("ENOENT");
      return data;
    },
    readdir: (path) => {
      this.enter("readdir", path);
      const prefix = `${norm(path).replace(/\/$/, "")}/`;
      return [...this.files.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map((key) => key.slice(prefix.length));
    },
    unlink: (path) => {
      this.enter("unlink", path);
      if (!this.files.delete(norm(path))) throw codeError("ENOENT");
    },
  };
}

/** §2 の固定: text は JSON.parse して ok (失敗は malformed)、error は ENOENT なら absent、他は code。 */
export function stubInterpretRead(read: SnapshotLockRead): SnapshotLockReadResult {
  if (read.kind === "error") {
    return read.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unavailable", reason: read.code ?? "UNKNOWN" };
  }
  try {
    return { kind: "ok", record: JSON.parse(read.text) as SnapshotLockRecord };
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
}

/** §2 の固定: 世代が無い・free・stale なら次の世代の attempt、live は上限まで wait、届いたら give_up。 */
export function stubDecide(input: SnapshotLockStepInput): SnapshotLockStep {
  const { current } = input;
  if (current === null) return { action: "attempt", generation: 1 };
  if (current.state !== "live") return { action: "attempt", generation: current.generation + 1 };
  return input.waitedMs >= input.maxWaitMs ? { action: "give_up" } : { action: "wait" };
}

export interface LockHarnessOptions {
  maxWaitMs?: number;
  repoRoot?: string;
  classify?: (record: SnapshotLockRecord) => ClaimState;
  resolveMode?: (input: SnapshotLockModeInput) => SnapshotLockMode;
  observeIdentity?: (pid: number) => ProcessObservation;
  presence?: (pid: number) => Presence;
  onSleep?: (elapsedMs: number) => void;
  fs?: FakeLockFs;
}

export function makeLockHarness(o: LockHarnessOptions = {}) {
  const fs = o.fs ?? new FakeLockFs();
  const lines: string[] = [];
  const observed: number[] = [];
  let classifyCalls = 0;
  let nowMs = T0;
  const deps: SnapshotLockDeps = {
    io: fs.io,
    presence: o.presence ?? (() => true),
    observeIdentity: (pid) => {
      observed.push(pid);
      return o.observeIdentity ? o.observeIdentity(pid) : { pid, startToken: `T-self-${pid}` };
    },
    now: () => nowMs,
    sleep: (ms) => {
      nowMs += ms;
      o.onSleep?.(nowMs - T0);
    },
    write: (line) => {
      lines.push(line.trim());
    },
    resolveMode: o.resolveMode ?? (() => "acquire"),
    interpretRead: stubInterpretRead,
    classify: (record) => {
      classifyCalls += 1;
      return o.classify ? o.classify(record) : "live";
    },
    decide: stubDecide,
  };
  const options: SnapshotLockOptions = {
    tmpRoot: LOCK_TMP_ROOT,
    repoRoot: o.repoRoot ?? LOCK_TMP_ROOT,
    env: {},
    maxWaitMs: o.maxWaitMs ?? 0,
  };
  return { fs, deps, options, lines, observed, classifyCalls: () => classifyCalls };
}

/** 行の種類 (`snapshot-lock: <kind> ...` の kind)。文面は解析せず、kind と key=value だけを見る。 */
export function lineKind(line: string): string {
  return line.replace(/^snapshot-lock:\s*/, "").split(/\s+/)[0] ?? "";
}
export function lineValue(line: string, key: string): string | undefined {
  return new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(line)?.[1];
}

export const rec = (
  lockId: string,
  o: { pid?: number; token?: string; gen?: number | null } = {},
) => makeRecord({ lockId, pid: o.pid, startToken: o.token, generation: o.gen ?? null });
export const liveSet =
  (...ids: string[]) =>
  (r: SnapshotLockRecord): ClaimState =>
    ids.includes(r.lockId) ? "live" : "stale";
