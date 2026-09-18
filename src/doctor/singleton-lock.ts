import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../shared/fs.ts";

/**
 * doctor 多重起動ガード (PLAN-L7-442)。
 *
 * 2026-07-16 に同一 repo で doctor が 16 本並列滞留し、メモリ枯渇 (16GB 中残 31MB) で
 * 全プロセスがスラッシングする実害が出た (agent の再試行嵐 × doctor の長い実行時間)。
 * doctor は read-only 検査なので同時に複数走らせる価値がなく、2 本目以降は即座に
 * fail-fast させて再試行嵐がプロセスを積み上げられない構造にする。
 *
 * 位置づけ: これは資源保護の advisory guard であって安全ゲートではない。lock I/O
 * 自体の失敗で doctor を止めない (fail-open) — doctor 本体の検査こそが安全側の関心で、
 * lock 障害を理由に検査を殺すほうが有害。stale lock (保持プロセス死亡 / 期限超過) は
 * 自動回収する。
 */

export interface DoctorLockRecord {
  pid: number;
  started_at: string;
  host: string;
  lock_id?: string;
}

export type DoctorLockAcquisition =
  | { acquired: true; release: () => void }
  | { acquired: false; holder: DoctorLockRecord }
  // lock I/O が壊れている場合は fail-open (doctor 検査を優先)
  | { acquired: true; release: () => void; degraded: true };

export interface DoctorLockDeps {
  now: () => number;
  hostName?: () => string;
  isPidAlive: (pid: number) => boolean;
  io?: DoctorLockIo;
}

export interface DoctorLockIo {
  mkdirRecursive: (path: string) => void;
  createExclusive: (path: string, content: string) => void;
  readText: (path: string) => string;
  list: (path: string) => string[];
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
}

/** 実行上限の想定。これを超えた lock はハング残骸とみなして回収する。 */
export const DOCTOR_LOCK_STALE_MS = 45 * 60 * 1000;

export function doctorLockPath(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "state", "doctor.lock");
}

export function doctorLockClaimsPath(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "state", "doctor-lock", "claims");
}

export function doctorLockClaimPath(repoRoot: string, lockId: string): string {
  return join(doctorLockClaimsPath(repoRoot), `${lockId}.json`);
}

export function defaultDoctorLockDeps(): DoctorLockDeps {
  return {
    now: () => Date.now(),
    hostName: hostname,
    isPidAlive: (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM = 存在するが触れない (生存)。ESRCH 等 = 不在。
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    io: defaultDoctorLockIo(),
  };
}

export function defaultDoctorLockIo(): DoctorLockIo {
  return {
    mkdirRecursive: (path) => ensureDir(path, { recursive: true }),
    createExclusive: (path, content) => writeFileSync(path, content, { flag: "wx" }),
    readText: (path) => readFileSync(path, "utf8"),
    list: (path) => readdirSync(path),
    rename: (from, to) => renameSync(from, to),
    remove: (path) => rmSync(path, { force: true }),
  };
}

export function isStaleDoctorLock(record: DoctorLockRecord, deps: DoctorLockDeps): boolean {
  const startedAt = Date.parse(record.started_at);
  if (Number.isFinite(startedAt) && deps.now() - startedAt > DOCTOR_LOCK_STALE_MS) return true;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return true;
  // 他ホストの pid はローカルOSでは意味を持たない。共有workspaceで別ホストの
  // fresh lock をローカル pid 不在として回収すると二重doctorになるため、PID probe
  // は同一hostだけに限定する。別hostは TTL が切れた場合だけ回収する。
  return record.host === (deps.hostName ?? hostname)() && !deps.isPidAlive(record.pid);
}

function readLockRecord(path: string, deps: DoctorLockDeps): DoctorLockRecord | null {
  try {
    const parsed = JSON.parse(
      (deps.io ?? defaultDoctorLockIo()).readText(path),
    ) as Partial<DoctorLockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.started_at !== "string" ||
      typeof parsed.host !== "string" ||
      typeof parsed.lock_id !== "string"
    )
      return null;
    return {
      pid: parsed.pid,
      started_at: parsed.started_at,
      host: parsed.host,
      lock_id: parsed.lock_id,
    };
  } catch {
    return null; // 読めない/壊れた lock は stale 扱いで回収する
  }
}

export function acquireDoctorLock(
  repoRoot: string,
  pid: number = process.pid,
  deps: DoctorLockDeps = defaultDoctorLockDeps(),
): DoctorLockAcquisition {
  const claimsPath = doctorLockClaimsPath(repoRoot);
  const io = deps.io ?? defaultDoctorLockIo();
  const localHost = (deps.hostName ?? hostname)();
  const lockId = randomUUID();
  const record: DoctorLockRecord = {
    pid,
    started_at: new Date(deps.now()).toISOString(),
    host: localHost,
    lock_id: lockId,
  };
  const ownPath = doctorLockClaimPath(repoRoot, lockId);
  const ownTempPath = `${ownPath}.tmp`;
  const release = () => {
    try {
      // owner 固有 path は再利用しない。他者 generation を照合・rename・削除しない。
      io.remove(ownPath);
      io.remove(ownTempPath);
    } catch {
      // release 失敗は stale 回収に任せる
    }
  };
  try {
    io.mkdirRecursive(claimsPath);
    io.createExclusive(ownTempPath, `${JSON.stringify(record)}\n`);
    io.rename(ownTempPath, ownPath);

    const active: Array<{ path: string; record: DoctorLockRecord }> = [];
    for (const name of io.list(claimsPath)) {
      if (!name.endsWith(".json")) continue;
      const path = join(claimsPath, name);
      const claim = readLockRecord(path, deps);
      if (path === ownPath && !claim) throw new Error("published doctor claim is unreadable");
      if (!claim || (path !== ownPath && isStaleDoctorLock(claim, deps))) {
        io.remove(path);
        continue;
      }
      active.push({ path, record: claim });
    }
    const otherClaims = active.filter(
      ({ record: activeRecord }) => activeRecord.lock_id !== record.lock_id,
    );
    otherClaims.sort(
      (a, b) =>
        a.record.started_at.localeCompare(b.record.started_at) ||
        (a.record.lock_id ?? "").localeCompare(b.record.lock_id ?? ""),
    );
    const winner = otherClaims[0]?.record;
    if (winner) {
      release();
      return { acquired: false, holder: winner };
    }
    return { acquired: true, release };
  } catch {
    release();
    // lock 基盤の障害で doctor を殺さない (advisory guard、fail-open)
    return { acquired: true, release: () => {}, degraded: true };
  }
}

export function doctorLockBlockedMessage(holder: DoctorLockRecord): string {
  return (
    `doctor: already running (pid=${holder.pid}, host=${holder.host}, started_at=${holder.started_at}) — ` +
    `多重起動を fail-fast する (PLAN-L7-442、再試行嵐によるプロセス滞留防止)。` +
    `実行中の doctor の完了を待つこと。プロセスが死んでいる場合や ${Math.round(DOCTOR_LOCK_STALE_MS / 60000)} 分超過の lock は次回起動時に自動回収される。`
  );
}
