/**
 * snapshot runner の同時実行の排他 (issue #1665) の Red。
 * 契約: docs/design/harness/L6-function-design/snapshot-runner-lock.md と
 * snapshot-runner-lock-protocol.md、対の oracle は
 * docs/test-design/harness/L7-snapshot-runner-lock-test-design.md (§3)。
 * 実装 PR (Green) で `it.fails` を `it` に戻す。block A は snapshot-runner-lock.test.ts、029 は tests/snapshot-root-hygiene.test.ts。
 */
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import {
  acquireSnapshotLock,
  type ProcessObservation,
  type SnapshotLockAcquisition,
  type SnapshotLockDeps,
  snapshotLockDir,
} from "../src/runtime/snapshot-runner-lock.ts";
import { type RedContext, redWithPreparationPair } from "./support/red-pair.ts";
import {
  lineKind,
  lineValue,
  liveSet,
  lockPath,
  makeLockHarness,
  makeRecord,
  rec,
  T0,
} from "./support/snapshot-lock-fake.ts";
import { removeTestTree } from "./support/temp-tree.ts";

describe("snapshot runner lock: block B acquisition and release", () => {
  const reasonOf = (a: SnapshotLockAcquisition): unknown =>
    a.kind === "unavailable" ? a.reason : undefined;
  const holderGen = (a: SnapshotLockAcquisition): unknown =>
    a.kind === "busy" ? a.holder?.generation : undefined;

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-014: nested and skip_ci neither write nor probe identity",
    (t) => {
      const nested = makeLockHarness({
        resolveMode: ({ current }) => (current === null ? "acquire" : "nested"),
      });
      nested.fs.seedGen(1, rec("L1", { gen: 1 }));
      t.expect(acquireSnapshotLock(nested.options, nested.deps)).toEqual({
        kind: "nested",
        generation: 1,
      });
      t.expect(nested.lines.map(lineKind)).toContain("nested");
      t.expect(nested.fs.writeOpCount()).toBe(0);
      t.expect(nested.observed).toHaveLength(0);

      const ci = makeLockHarness({ resolveMode: () => "skip_ci" });
      ci.fs.seedGen(1, rec("L1", { gen: 1 }));
      t.expect(acquireSnapshotLock(ci.options, ci.deps)).toEqual({ kind: "skipped_ci" });
      t.expect(ci.lines).toContainEqual(
        t.expect.stringMatching(/^snapshot-lock: skipped reason=ci/),
      );
      t.expect(ci.fs.writeOpCount()).toBe(0);
      t.expect(ci.observed).toHaveLength(0);
      t.expect(ci.fs.ops).toHaveLength(0);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-015: a live generation is never replaced because of elapsed time",
    (t) => {
      const h = makeLockHarness({ maxWaitMs: 4000, classify: () => "live" });
      const old = makeRecord({ lockId: "OLD", generation: 1, queuedAtMs: T0 - 10 * 3600_000 });
      h.fs.seedGen(1, old);
      const result = acquireSnapshotLock(h.options, h.deps);
      t.expect(result.kind).toBe("busy");
      t.expect(holderGen(result)).toBe(1);
      t.expect(h.fs.has("gen-2.json")).toBe(false);
      t.expect(h.fs.has("gen-1.json")).toBe(true);
    },
  );

  // dir は snapshotLockDir(tmpRoot) から導く (L7 §2)。対の通常 it は、同じ実 fs・step hook の準備を、
  // 実装に依らない明示の dir で通す (stub の snapshotLockDir は空文字を返すため)。
  const body016 = (t: RedContext): void => {
    const dirOf = (root: string): string =>
      t.mode === "pair" ? join(root, "explicit-lock-dir") : snapshotLockDir(root);
    const run = (setup: (dir: string) => void, expectedHolder: number) => {
      const root = mkdtempSync(join(tmpdir(), "snaplock-016-"));
      try {
        const dir = dirOf(root);
        // stub (空文字) の間に作業ディレクトリへ書かないための assertion。契約の置き場は tmpRoot の下である。
        t.expect(dir.startsWith(root)).toBe(true);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "gen-1.json"),
          JSON.stringify(makeRecord({ lockId: "G1", generation: 1 })),
        );
        writeFileSync(join(dir, "released-1"), "");
        const links: string[] = [];
        let armed = true;
        const base = makeLockHarness({ maxWaitMs: 0, classify: liveSet("H", "H100") });
        const deps: SnapshotLockDeps = {
          ...base.deps,
          io: {
            mkdir: (p) => void mkdirSync(p, { recursive: true }),
            writeFile: (p, d) => writeFileSync(p, d),
            rename: (a, b) => renameSync(a, b),
            link: (a, b) => {
              links.push(b);
              if (armed && /gen-2\.json$/.test(b)) {
                armed = false;
                setup(dir);
              }
              linkSync(a, b);
            },
            readFile: (p) => readFileSync(p, "utf8"),
            readdir: (p) => readdirSync(p),
            unlink: (p) => unlinkSync(p),
          },
        };
        const result = acquireSnapshotLock(
          { ...base.options, tmpRoot: root, repoRoot: root },
          deps,
        );
        // 対の通常 it では stub が link を呼ばないので、他者の記録の準備 (世代 2〜100) を明示で実行する。
        if (t.mode === "pair" && armed) setup(dir);
        t.expect(links.filter((p) => /gen-2\.json$/.test(p))).toHaveLength(1);
        t.expect(links).toHaveLength(1);
        t.expect(result.kind).toBe("busy");
        t.expect(holderGen(result)).toBe(expectedHolder);
        t.expect(JSON.parse(readFileSync(join(dir, "gen-2.json"), "utf8")).lockId).toBe(
          expectedHolder === 2 ? "H" : "H2",
        );
        t.expect(base.lines.some((l) => lineKind(l) === "acquired")).toBe(false);
      } finally {
        removeTestTree(root);
      }
    };
    run((dir) => {
      writeFileSync(
        join(dir, "gen-2.json"),
        JSON.stringify(makeRecord({ lockId: "H", generation: 2 })),
      );
    }, 2);
    run((dir) => {
      for (let g = 2; g <= 100; g += 1) {
        const lockId = g === 2 ? "H2" : g === 100 ? "H100" : `H${g}`;
        writeFileSync(
          join(dir, `gen-${g}.json`),
          JSON.stringify(makeRecord({ lockId, generation: g })),
        );
        if (g < 100) writeFileSync(join(dir, `released-${g}`), "");
      }
    }, 100);
  };

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-016: a stalled attempt cannot link over a number that other runners advanced past",
    (t) => body016(t),
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-017: release only creates its own released mark and never touches history",
    (t) => {
      const acquire = (extra?: (h: ReturnType<typeof makeLockHarness>) => void) => {
        const h = makeLockHarness();
        for (let g = 1; g <= 4; g += 1) {
          h.fs.seedGen(g, rec(`G${g}`, { gen: g }));
          h.fs.seedReleased(g);
        }
        const acquired = acquireSnapshotLock(h.options, h.deps);
        t.expect(acquired.kind).toBe("acquired");
        t.expect(acquired.kind === "acquired" ? acquired.generation : undefined).toBe(5);
        extra?.(h);
        return { h, acquired };
      };
      const topLevel = (h: ReturnType<typeof makeLockHarness>) =>
        [...h.fs.files.keys()].filter((k) => /\/(gen-\d+\.json|released-\d+)$/.test(k)).sort();

      const a = acquire();
      const beforeA = topLevel(a.h);
      const opsBeforeA = a.h.fs.ops.length;
      if (a.acquired.kind === "acquired") a.acquired.release();
      t.expect(topLevel(a.h).filter((k) => !beforeA.includes(k))).toEqual([lockPath("released-5")]);
      t.expect(
        a.h.fs.ops
          .slice(opsBeforeA)
          .filter(
            (op) =>
              ["unlink", "rename"].includes(op.name) &&
              /(gen-|released-)\d/.test(`${op.path}${op.from ?? ""}`),
          ),
      ).toEqual([]);
      t.expect(a.h.fs.has("gen-5.json")).toBe(true);

      const b = acquire((h) => h.fs.seedGen(6, rec("G6", { gen: 6 })));
      const beforeB = topLevel(b.h);
      if (b.acquired.kind === "acquired") b.acquired.release();
      t.expect(topLevel(b.h).filter((k) => !beforeB.includes(k))).toEqual([lockPath("released-5")]);
      t.expect(b.h.fs.has("released-6")).toBe(false);
      t.expect(b.h.fs.has("gen-5.json") && b.h.fs.has("gen-6.json")).toBe(true);

      const c = acquire((h) => h.fs.failOn(["link", "writeFile", "rename"], /released-5$/, "EIO"));
      t.expect(() => c.acquired.kind === "acquired" && c.acquired.release()).not.toThrow();
      const failed = c.h.lines.find((l) => lineKind(l) === "release-failed");
      t.expect(failed && lineValue(failed, "reason")).toBe("EIO");
      t.expect(c.h.fs.has("gen-5.json")).toBe(true);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-018: link and release-mark read failures are unavailable, not busy",
    (t) => {
      const a = makeLockHarness({ maxWaitMs: 0 });
      a.fs.failOn(["link", "writeFile", "rename"], /gen-1\.json$/, "EPERM");
      const ra = acquireSnapshotLock(a.options, a.deps);
      t.expect(ra.kind).toBe("unavailable");
      t.expect(reasonOf(ra)).toBe("EPERM");
      t.expect(a.fs.has("gen-1.json")).toBe(false);

      const b = makeLockHarness({ maxWaitMs: 0, classify: () => "stale" });
      b.fs.seedGen(1, rec("G1", { gen: 1 }));
      b.fs.failOn(["readFile"], /released-1$/, "EACCES");
      const rb = acquireSnapshotLock(b.options, b.deps);
      t.expect(rb.kind).toBe("unavailable");
      t.expect(reasonOf(rb)).toBe("EACCES");
      t.expect(b.fs.generationCreations()).toHaveLength(0);
      t.expect(b.fs.has("gen-2.json")).toBe(false);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-019: the own queue entry is written and removed on every exit path",
    (t) => {
      const own = (h: ReturnType<typeof makeLockHarness>) => {
        const published = h.fs
          .opsNamed("rename", "writeFile")
          .filter((op) => /\/queue\/[^/]+\.json$/.test(op.path));
        t.expect(published.length).toBeGreaterThanOrEqual(1);
        t.expect(h.fs.queueKeys()).toEqual([]);
      };
      const live = makeLockHarness({ maxWaitMs: 4000, classify: () => "live" });
      live.fs.seedGen(1, rec("G1", { gen: 1 }));
      acquireSnapshotLock(live.options, live.deps);
      own(live);

      const free = makeLockHarness({ maxWaitMs: 4000 });
      acquireSnapshotLock(free.options, free.deps);
      own(free);

      const failing = makeLockHarness({ maxWaitMs: 4000 });
      failing.fs.failOn(["link", "writeFile", "rename"], /gen-1\.json$/, "EPERM");
      acquireSnapshotLock(failing.options, failing.deps);
      own(failing);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-020: a stale generation is replaced and nothing in history is removed",
    (t) => {
      const h = makeLockHarness({ maxWaitMs: 0, classify: liveSet() });
      for (let g = 1; g <= 3; g += 1) h.fs.seedGen(g, rec(`G${g}`, { gen: g }));
      h.fs.seedReleased(1);
      h.fs.seedReleased(2);
      const history = ["gen-1.json", "gen-2.json", "gen-3.json", "released-1", "released-2"];
      const before = history.map((name) => h.fs.text(name));
      const result = acquireSnapshotLock(h.options, h.deps);
      t.expect(result.kind).toBe("acquired");
      t.expect(result.kind === "acquired" ? result.generation : undefined).toBe(4);
      t.expect(h.fs.historyMutations()).toEqual([]);
      t.expect(history.map((name) => h.fs.text(name))).toEqual(before);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-021: stale waiters are cleaned up and live waiters are kept",
    (t) => {
      const h = makeLockHarness({
        maxWaitMs: 4000,
        classify: (r) => (r.lockId === "S" ? "stale" : "live"),
      });
      h.fs.seedGen(1, rec("G1", { gen: 1 }));
      h.fs.seedQueue(rec("S"));
      h.fs.seedQueue(rec("L"));
      acquireSnapshotLock(h.options, h.deps);
      t.expect(h.fs.files.has(lockPath("queue/S.json"))).toBe(false);
      t.expect(h.fs.files.has(lockPath("queue/L.json"))).toBe(true);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-023: without an own startToken nothing is written",
    (t) => {
      const failures: ProcessObservation[] = ["query_failed", null, { pid: 1, startToken: null }];
      for (const observation of failures) {
        const h = makeLockHarness({ maxWaitMs: 4000, observeIdentity: () => observation });
        const result = acquireSnapshotLock(h.options, h.deps);
        t.expect(result.kind).toBe("unavailable");
        t.expect(h.fs.writeOpCount()).toBe(0);
        // stub は identity を観測せずに unavailable を返す。実装は自分の identity を 1 回観測した上で書かずに終える。
        t.expect(h.observed).toHaveLength(1);
      }
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-024: while waiting only waiting, still-waiting every 60000 ms and the result are printed",
    (t) => {
      const h = makeLockHarness({
        maxWaitMs: 600000,
        classify: () => "live",
        onSleep: (elapsed) => {
          if (elapsed >= 130000) h.fs.seed(lockPath("released-1"));
        },
      });
      h.fs.seedGen(1, rec("G1", { gen: 1 }));
      const result = acquireSnapshotLock(h.options, h.deps);
      t.expect(result.kind).toBe("acquired");
      t.expect(h.lines.map(lineKind)).toEqual([
        "waiting",
        "still-waiting",
        "still-waiting",
        "acquired",
      ]);
      const still = h.lines
        .filter((l) => lineKind(l) === "still-waiting")
        .map((l) => lineValue(l, "waited_ms"));
      t.expect(still).toEqual(["60000", "120000"]);
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-025: the lock scope is tmpRoot, not the checkout",
    (t) => {
      const first = makeLockHarness({ maxWaitMs: 0, repoRoot: "/repo/a" });
      const a = acquireSnapshotLock(first.options, first.deps);
      t.expect(a.kind).toBe("acquired");
      first.fs.files.delete(lockPath("hint"));
      const second = makeLockHarness({
        maxWaitMs: 0,
        repoRoot: "/repo/b",
        fs: first.fs,
        classify: () => "live",
      });
      const b = acquireSnapshotLock(second.options, second.deps);
      t.expect(b.kind).toBe("busy");
      t.expect(b.kind === "busy" ? b.holder?.lockId : undefined).toBe(
        a.kind === "acquired" ? a.lockId : "missing",
      );
    },
  );

  redWithPreparationPair(
    "CANDIDATE-U-SNAPLOCK-031: unreadable or malformed records fail closed without replacing anyone",
    (t) => {
      const base = (maxWaitMs: number) => {
        const h = makeLockHarness({ maxWaitMs, classify: () => "live" });
        h.fs.seedGen(1, rec("G1", { gen: 1 }));
        return h;
      };
      for (const [code, reason] of [
        ["EACCES", "EACCES"],
        ["EIO", "EIO"],
      ] as const) {
        const h = base(0);
        h.fs.failOn(["readFile"], /gen-1\.json$/, code);
        const r = acquireSnapshotLock(h.options, h.deps);
        t.expect(reasonOf(r)).toBe(reason);
        t.expect(h.fs.generationCreations()).toHaveLength(0);
        t.expect(h.classifyCalls()).toBe(0);
      }
      const malformed = base(0);
      malformed.fs.seed(lockPath("gen-1.json"), "{");
      const rm = acquireSnapshotLock(malformed.options, malformed.deps);
      t.expect(reasonOf(rm)).toBe("malformed");
      t.expect(malformed.fs.generationCreations()).toHaveLength(0);
      t.expect(malformed.classifyCalls()).toBe(0);

      const vanished = base(4000);
      vanished.fs.hookBefore("readFile", /gen-1\.json$/, 2, () =>
        vanished.fs.files.delete(lockPath("gen-1.json")),
      );
      const rv = acquireSnapshotLock(vanished.options, vanished.deps);
      t.expect(reasonOf(rv)).toBe("generation_missing");
      t.expect(vanished.fs.generationCreations()).toHaveLength(0);

      const waiterFail = makeLockHarness({ maxWaitMs: 4000, classify: () => "live" });
      waiterFail.fs.seedQueue(rec("W"));
      waiterFail.fs.failOn(["readFile"], /queue\/W\.json$/, "EACCES");
      const rw = acquireSnapshotLock(waiterFail.options, waiterFail.deps);
      t.expect(reasonOf(rw)).toBe("EACCES");
      t.expect(
        waiterFail.fs.generationCreations().filter((op) => /gen-1\.json$/.test(op.path)),
      ).toHaveLength(0);
    },
  );

  redWithPreparationPair("CANDIDATE-U-SNAPLOCK-032: the hint is advice only", (t) => {
    const seeded = (
      hint: ((h: ReturnType<typeof makeLockHarness>) => void) | null,
      withReleased5 = false,
    ) => {
      const h = makeLockHarness({ maxWaitMs: 0, classify: () => "live" });
      for (let g = 1; g <= 5; g += 1) h.fs.seedGen(g, rec(`G${g}`, { gen: g }));
      for (let g = 1; g <= (withReleased5 ? 5 : 4); g += 1) h.fs.seedReleased(g);
      hint?.(h);
      return h;
    };
    const hints: ((h: ReturnType<typeof makeLockHarness>) => void)[] = [
      (h) => h.fs.seed(lockPath("hint"), "3"),
      (h) => h.fs.seed(lockPath("hint"), "abc"),
      (h) => h.fs.seed(lockPath("hint"), "50"),
      (h) => {
        h.fs.seed(lockPath("hint"), "5");
        h.fs.failOn(["readFile"], /\/hint$/, "EACCES");
      },
      () => undefined,
    ];
    for (const hint of hints) {
      const h = seeded(hint);
      const r = acquireSnapshotLock(h.options, h.deps);
      t.expect(r.kind).toBe("busy");
      t.expect(holderGen(r)).toBe(5);
      t.expect(h.fs.generationCreations()).toHaveLength(0);
    }
    const f = seeded((h) => h.fs.seed(lockPath("hint"), "50"), true);
    const rf = acquireSnapshotLock(f.options, f.deps);
    t.expect(rf.kind).toBe("acquired");
    t.expect(rf.kind === "acquired" ? rf.generation : undefined).toBe(6);
    t.expect(f.fs.generationCreations().map((op) => op.path)).toEqual([lockPath("gen-6.json")]);
    t.expect(f.fs.text("hint")).toBe("6");
  });
});
