import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireSnapshotLock,
  classifySnapshotLockClaim,
  decideSnapshotLockStep,
  identityProbeDue,
  interpretSnapshotLockRead,
  parseSnapshotLockWaitMs,
  presenceFromKill,
  resolveSnapshotLockMode,
  type SnapshotLockAcquisition,
  type SnapshotLockRecord,
  snapshotLockDir,
  snapshotStageEnv,
} from "../src/runtime/snapshot-runner-lock.ts";
import { redWithPreparationPair } from "./support/red-pair.ts";
import {
  FakeLockFs,
  LOCK_DIR,
  LOCK_TMP_ROOT,
  lockPath,
  rec,
  stubDecide,
  stubInterpretRead,
} from "./support/snapshot-lock-fake.ts";

const T1 = "2026-11-16T09:00:00.000Z";
const T2 = "2026-11-16T09:00:05.000Z";
const T3 = "2026-11-16T08:59:00.000Z";
const claim = (startToken = "T1"): SnapshotLockRecord => ({
  schema: 1,
  lockId: "L",
  runner: { pid: 100, startToken },
  repoRoot: "/r",
  queuedAt: T1,
  generation: 1,
  acquiredAt: T1,
});
const waiter = (lockId: string, queuedAt: string, state: "live" | "stale" = "live") => ({
  lockId,
  queuedAt,
  state,
});

describe("snapshot runner lock: fixture preconditions", () => {
  it("exposes the contract-shaped module surface and a working fake io", () => {
    for (const fn of [
      resolveSnapshotLockMode,
      parseSnapshotLockWaitMs,
      presenceFromKill,
      snapshotLockDir,
      interpretSnapshotLockRead,
      classifySnapshotLockClaim,
      decideSnapshotLockStep,
      identityProbeDue,
      snapshotStageEnv,
      acquireSnapshotLock,
    ]) {
      expect(typeof fn).toBe("function");
    }
    const fs = new FakeLockFs();
    fs.seedGen(1, rec("A", { gen: 1 }));
    fs.io.writeFile(lockPath("tmp/x.json"), "{}");
    fs.io.link(lockPath("tmp/x.json"), lockPath("gen-2.json"));
    expect(() => fs.io.link(lockPath("tmp/x.json"), lockPath("gen-2.json"))).toThrow("EEXIST");
    expect(fs.io.readdir(lockPath("tmp"))).toEqual(["x.json"]);
    expect(stubInterpretRead({ kind: "error", code: "ENOENT" })).toEqual({ kind: "absent" });
    expect(
      stubDecide({
        self: { lockId: "s", queuedAt: T1 },
        current: null,
        waiters: [],
        waitedMs: 0,
        maxWaitMs: 0,
      }),
    ).toEqual({ action: "attempt", generation: 1 });
    expect(LOCK_DIR).toBe(snapshotLockDir(LOCK_TMP_ROOT).replace(/\\/g, "/"));
  });
});

describe("snapshot runner lock: block A pure functions", () => {
  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-001: CI=true skips and other values acquire",
    (t) => {
      const mode = (CI?: string) =>
        resolveSnapshotLockMode({
          env: CI === undefined ? {} : { CI },
          current: null,
          currentPresence: null,
        });
      t.expect(mode("true")).toBe("skip_ci");
      t.expect(mode("false")).toBe("acquire");
      t.expect(mode("1")).toBe("acquire");
      t.expect(mode("")).toBe("acquire");
      t.expect(mode(undefined)).toBe("acquire");
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-002: nested needs a matching live unreleased token",
    (t) => {
      const current = (released = false) => ({ record: rec("L3", { gen: 3 }), released });
      const mode = (
        token: string | undefined,
        presence: true | false | "unknown",
        released = false,
      ) =>
        resolveSnapshotLockMode({
          env: token === undefined ? {} : { UT_TDD_SNAPSHOT_LOCK_TOKEN: token },
          current: current(released),
          currentPresence: presence,
        });
      t.expect(mode("L3", true)).toBe("nested");
      t.expect(mode("L9", true)).toBe("acquire");
      t.expect(mode("L3", false)).toBe("acquire");
      t.expect(mode("L3", true, true)).toBe("acquire");
      t.expect(mode(undefined, true)).toBe("acquire");
      t.expect(mode("L3", "unknown")).toBe("nested");
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-003: wait ms accepts only unset, empty and decimal digits",
    (t) => {
      t.expect(parseSnapshotLockWaitMs(undefined)).toEqual({ ok: true, ms: 0 });
      t.expect(parseSnapshotLockWaitMs("")).toEqual({ ok: true, ms: 0 });
      t.expect(parseSnapshotLockWaitMs("0")).toEqual({ ok: true, ms: 0 });
      t.expect(parseSnapshotLockWaitMs("120000")).toEqual({ ok: true, ms: 120000 });
      for (const bad of ["-1", "1.5", " 5", "5s", "9007199254740992"]) {
        t.expect(parseSnapshotLockWaitMs(bad).ok).toBe(false);
      }
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-004: presence from kill and unknown stays live",
    (t) => {
      t.expect(presenceFromKill(null)).toBe(true);
      t.expect(presenceFromKill("EPERM")).toBe(true);
      t.expect(presenceFromKill("ESRCH")).toBe(false);
      t.expect(presenceFromKill("EINVAL")).toBe("unknown");
      t.expect(classifySnapshotLockClaim(claim(), "unknown", "not_observed")).toBe("live");
    },
  );

  redWithPreparationPair("CANDIDATE-U-SNAPLOCK-005: absent process is stale (K1)", (t) => {
    const same = { pid: 100, startToken: "T1" };
    t.expect(classifySnapshotLockClaim(claim(), false, "not_observed")).toBe("stale");
    t.expect(classifySnapshotLockClaim(claim(), false, same)).toBe("stale");
  });

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-006: identity observation decides stale only on a proven mismatch (K2-K4)",
    (t) => {
      const at = (startToken: string | null) => ({ pid: 100, startToken });
      t.expect(classifySnapshotLockClaim(claim("T1"), true, at("T2"))).toBe("stale");
      t.expect(classifySnapshotLockClaim(claim("T1"), true, "query_failed")).toBe("live");
      t.expect(classifySnapshotLockClaim(claim("T1"), true, null)).toBe("stale");
      t.expect(classifySnapshotLockClaim(claim("T1"), true, at("T1"))).toBe("live");
      t.expect(classifySnapshotLockClaim(claim("T1"), true, at(null))).toBe("live");
      t.expect(classifySnapshotLockClaim(claim("T1"), true, "not_observed")).toBe("live");
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-007: read interpretation separates absent, unavailable and ok (R1-R4)",
    (t) => {
      const text = (o: unknown) =>
        interpretSnapshotLockRead({ kind: "text", text: JSON.stringify(o) });
      const valid = claim();
      t.expect(interpretSnapshotLockRead({ kind: "error", code: "ENOENT" })).toEqual({
        kind: "absent",
      });
      t.expect(interpretSnapshotLockRead({ kind: "error", code: "EACCES" })).toEqual({
        kind: "unavailable",
        reason: "EACCES",
      });
      t.expect(interpretSnapshotLockRead({ kind: "error", code: "EIO" })).toEqual({
        kind: "unavailable",
        reason: "EIO",
      });
      t.expect(interpretSnapshotLockRead({ kind: "error", code: null })).toEqual({
        kind: "unavailable",
        reason: "UNKNOWN",
      });
      t.expect(interpretSnapshotLockRead({ kind: "text", text: "{" })).toEqual({
        kind: "unavailable",
        reason: "malformed",
      });
      const malformed = { kind: "unavailable", reason: "malformed" };
      t.expect(text({ ...valid, runner: { pid: 100, startToken: null } })).toEqual(malformed);
      t.expect(text({ ...valid, runner: { pid: 100, startToken: "" } })).toEqual(malformed);
      t.expect(text({ ...valid, runner: { pid: 0, startToken: "T1" } })).toEqual(malformed);
      t.expect(text({ ...valid, lockId: undefined })).toEqual(malformed);
      t.expect(text({ ...valid, schema: 2 })).toEqual(malformed);
      t.expect(text(valid)).toEqual({ kind: "ok", record: valid });
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-008: only the earliest live waiter may attempt",
    (t) => {
      const step = (
        current: "free" | "stale" | null,
        w: { lockId: string; queuedAt: string },
        self: { lockId: string; queuedAt: string },
      ) =>
        decideSnapshotLockStep({
          self,
          current: current === null ? null : { generation: 3, state: current },
          waiters: [{ ...w, state: "live" }],
          waitedMs: 0,
          maxWaitMs: 600000,
        }).action;
      t.expect(step(null, { lockId: "a", queuedAt: T1 }, { lockId: "s", queuedAt: T2 })).toBe(
        "wait",
      );
      t.expect(step("stale", { lockId: "a", queuedAt: T1 }, { lockId: "s", queuedAt: T2 })).toBe(
        "wait",
      );
      t.expect(step("free", { lockId: "a", queuedAt: T1 }, { lockId: "b", queuedAt: T1 })).toBe(
        "wait",
      );
      t.expect(step("free", { lockId: "b", queuedAt: T1 }, { lockId: "a", queuedAt: T1 })).toBe(
        "attempt",
      );
      t.expect(step("free", { lockId: "a", queuedAt: T2 }, { lockId: "z", queuedAt: T1 })).toBe(
        "attempt",
      );
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-009: stale waiters do not count and the next generation is current + 1",
    (t) => {
      const base = { self: { lockId: "s", queuedAt: T1 }, waitedMs: 0, maxWaitMs: 600000 };
      const stale = [waiter("S", T3, "stale")];
      t.expect(decideSnapshotLockStep({ ...base, current: null, waiters: stale }).action).toBe(
        "attempt",
      );
      t.expect(decideSnapshotLockStep({ ...base, current: null, waiters: [] })).toEqual({
        action: "attempt",
        generation: 1,
      });
      t.expect(
        decideSnapshotLockStep({ ...base, current: { generation: 7, state: "free" }, waiters: [] }),
      ).toEqual({
        action: "attempt",
        generation: 8,
      });
      t.expect(
        decideSnapshotLockStep({
          ...base,
          current: { generation: 7, state: "stale" },
          waiters: [],
        }),
      ).toEqual({
        action: "attempt",
        generation: 8,
      });
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-010: give up only when the wait limit is reached and nothing is attemptable",
    (t) => {
      const step = (state: "free" | "live", waitedMs: number, maxWaitMs: number) =>
        decideSnapshotLockStep({
          self: { lockId: "s", queuedAt: T1 },
          current: { generation: 2, state },
          waiters: [],
          waitedMs,
          maxWaitMs,
        }).action;
      t.expect(step("live", 59999, 60000)).toBe("wait");
      t.expect(step("live", 60000, 60000)).toBe("give_up");
      t.expect(step("live", 0, 0)).toBe("give_up");
      t.expect(step("free", 70000, 60000)).toBe("attempt");
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-011: identity probe is due on first sight and after 300000 ms",
    (t) => {
      t.expect(identityProbeDue(null, 0)).toBe(true);
      t.expect(identityProbeDue(1000, 300999)).toBe(false);
      t.expect(identityProbeDue(1000, 301000)).toBe(true);
      t.expect(identityProbeDue(1000, 1000)).toBe(false);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-012: only an acquired runner adds the token to the stage env",
    (t) => {
      const acquired: SnapshotLockAcquisition = {
        kind: "acquired",
        lockId: "L5",
        generation: 5,
        release: () => undefined,
      };
      for (const base of [{ PATH: "p" }, { PATH: "p", UT_TDD_SNAPSHOT_LOCK_TOKEN: "old" }]) {
        t.expect(snapshotStageEnv(base, acquired)).toEqual({
          PATH: "p",
          UT_TDD_SNAPSHOT_LOCK_TOKEN: "L5",
        });
        t.expect(snapshotStageEnv(base, { kind: "nested", generation: 2 })).toEqual(base);
        t.expect(snapshotStageEnv(base, { kind: "skipped_ci" })).toEqual(base);
      }
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-013: lock dir is derived from tmpRoot and avoids the vitest root names",
    (t) => {
      for (const tmpRoot of ["/t", "C:\\t"]) {
        const dir = snapshotLockDir(tmpRoot);
        t.expect(dir).toBe(join(tmpRoot, "ut-tdd-snapshot-runner-lock"));
        const name = dir.split(/[\\/]/).pop() ?? "";
        t.expect(name.startsWith("ut-tdd-vitest-")).toBe(false);
        t.expect(/^ut-tdd-vitest-(head-|cache-)?\d+-\d+/.test(name)).toBe(false);
      }
    },
  );
});
