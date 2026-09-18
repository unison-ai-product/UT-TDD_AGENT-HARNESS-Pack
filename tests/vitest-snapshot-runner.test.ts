import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBatchVitestArgs,
  assertNotRoot,
  assertSnapshotContentMatch,
  assertSnapshotFingerprint,
  copyReferenceRuntimeInputs,
  createSnapshot,
  emitSnapshotTimings,
  finishSnapshotCleanup,
  measureSnapshotStage,
  removeSnapshot,
  resolveNodeBinary,
  resolveSnapshotSource,
  runSnapshotTests,
  sealReference,
  shouldEmitSnapshotTimings,
  snapshotContentFingerprint,
  snapshotTimingLines,
  unsealReference,
  windowsSealCommands,
} from "../scripts/run-vitest-snapshot.ts";
import { removeTestTree } from "./support/temp-tree.ts";

describe("vitest snapshot runner", () => {
  it("CANDIDATE-SNAPSHOT-COST-001: emits stage timings only when explicitly enabled", () => {
    const timings = [
      { stage: "npm-ci", durationMs: 12.345 },
      { stage: "cleanup", durationMs: 0 },
    ];
    expect(snapshotTimingLines(timings)).toEqual([
      "snapshot-stage npm-ci 12.3ms",
      "snapshot-stage cleanup 0.0ms",
    ]);
    const writes: string[] = [];
    emitSnapshotTimings(timings, false, (text) => writes.push(text));
    expect(writes).toEqual([]);
    emitSnapshotTimings(timings, true, (text) => writes.push(text));
    expect(writes).toEqual(["snapshot-stage npm-ci 12.3ms\nsnapshot-stage cleanup 0.0ms\n"]);
    expect(shouldEmitSnapshotTimings({})).toBe(false);
    expect(shouldEmitSnapshotTimings({ UT_TDD_SNAPSHOT_TIMING: "1" })).toBe(true);
    expect(shouldEmitSnapshotTimings({ CI: "true" })).toBe(true);
    expect(shouldEmitSnapshotTimings({ CI: "false" })).toBe(false);
  });

  it("CANDIDATE-SNAPSHOT-COST-002: emits each completed stage before the next stage", () => {
    const writes: string[] = [];
    let tick = 100;
    const now = () => {
      const current = tick;
      tick += 12.345;
      return current;
    };
    const measurement = { now, enabled: true, write: (text: string) => writes.push(text) };

    expect(
      measureSnapshotStage(
        "first",
        () => {
          expect(writes).toEqual([]);
          return "ok";
        },
        measurement,
      ),
    ).toBe("ok");
    expect(writes).toEqual(["snapshot-stage first 12.3ms\n"]);

    expect(() =>
      measureSnapshotStage(
        "second",
        () => {
          expect(writes).toEqual(["snapshot-stage first 12.3ms\n"]);
          throw new Error("stage failed");
        },
        measurement,
      ),
    ).toThrow("stage failed");
    expect(writes).toEqual(["snapshot-stage first 12.3ms\n", "snapshot-stage second 12.3ms\n"]);
  });

  it("U-TESTHYGIENE-047: resolves only the current Node executable", () => {
    expect(resolveNodeBinary("/runtime/node")).toBe("/runtime/node");
    expect(readFileSync(join(process.cwd(), "scripts/run-vitest-snapshot.ts"), "utf8")).toContain(
      "windowsHide: true",
    );
  });

  it("U-TESTHYGIENE-045: rejects watch arguments because an execution snapshot cannot observe live edits", () => {
    expect(() => assertBatchVitestArgs(["--watch"])).toThrow("batch-only");
    expect(() => assertBatchVitestArgs(["-w"])).toThrow("batch-only");
    expect(() => assertBatchVitestArgs(["--watch=false"])).toThrow("batch-only");
    expect(() => assertBatchVitestArgs(["tests/example.test.ts", "--reporter=dot"])).not.toThrow();
  });

  it("U-TESTHYGIENE-046: does not advertise a live-source watch script", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.["test:watch"]).toBeUndefined();
  });

  it("U-TESTHYGIENE-021: copies a non-Git Pack without sharing node_modules", () => {
    const source = mkdtempSync(join(tmpdir(), "ut-tdd-pack-source-"));
    const snapshot = `${source}-snapshot`;
    try {
      writeFileSync(join(source, "package.json"), "{}\n");
      mkdirSync(join(source, "node_modules"));
      writeFileSync(join(source, "node_modules", "leak.txt"), "source-only\n");
      createSnapshot(source, snapshot);
      expect(existsSync(join(snapshot, "package.json"))).toBe(true);
      expect(existsSync(join(snapshot, "node_modules"))).toBe(false);
    } finally {
      removeTestTree(source);
      removeTestTree(snapshot);
    }
  });

  it("U-TESTHYGIENE-032: treats a Pack nested below an unrelated Git root as non-Git", () => {
    const parent = mkdtempSync(join(tmpdir(), "ut-tdd-parent-git-"));
    const pack = join(parent, "pack");
    const snapshot = `${parent}-snapshot`;
    try {
      expect(spawnSync("git", ["init"], { cwd: parent }).status).toBe(0);
      mkdirSync(pack);
      writeFileSync(join(pack, "package.json"), "{}\n");
      mkdirSync(join(pack, "node_modules"));
      writeFileSync(join(pack, "node_modules", "leak.txt"), "source-only\n");
      mkdirSync(join(pack, "nested", "node_modules"), { recursive: true });
      writeFileSync(join(pack, "nested", "node_modules", "leak.txt"), "nested-source-only\n");
      mkdirSync(join(pack, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(join(pack, ".ut-tdd", "memory", "leak.md"), "source-runtime\n");

      expect(resolveSnapshotSource(pack)).toEqual({ kind: "copy" });
      createSnapshot(pack, snapshot);
      expect(existsSync(join(snapshot, "package.json"))).toBe(true);
      expect(existsSync(join(snapshot, "node_modules"))).toBe(false);
      expect(existsSync(join(snapshot, "nested", "node_modules"))).toBe(false);
      expect(existsSync(join(snapshot, ".ut-tdd"))).toBe(false);
    } finally {
      removeTestTree(parent);
      removeTestTree(snapshot);
    }
  });

  it("U-TESTHYGIENE-034: derives a non-Git reference from the captured execution", () => {
    const source = mkdtempSync(join(tmpdir(), "ut-tdd-copy-source-"));
    const execution = `${source}-execution`;
    const reference = `${source}-reference`;
    try {
      writeFileSync(join(source, "package.json"), '{"version":1}\n');
      createSnapshot(source, execution);
      writeFileSync(join(source, "package.json"), '{"version":2}\n');
      createSnapshot(execution, reference);

      expect(snapshotContentFingerprint(execution)).toBe(snapshotContentFingerprint(reference));

      expect(readFileSync(join(execution, "package.json"), "utf8")).toBe(
        readFileSync(join(reference, "package.json"), "utf8"),
      );
      expect(readFileSync(join(reference, "package.json"), "utf8")).toContain('"version":1');
    } finally {
      removeTestTree(source);
      removeTestTree(execution);
      removeTestTree(reference);
    }
  });

  it("U-TESTHYGIENE-040: fails closed when a non-Git reference diverges from execution capture", () => {
    const execution = mkdtempSync(join(tmpdir(), "ut-tdd-copy-execution-"));
    const reference = `${execution}-reference`;
    try {
      writeFileSync(join(execution, "package.json"), '{"version":1}\n');
      createSnapshot(execution, reference);
      writeFileSync(join(reference, "package.json"), '{"version":2}\n');
      expect(() => assertSnapshotContentMatch(execution, reference)).toThrow(
        "snapshot content mismatch",
      );
    } finally {
      removeTestTree(execution);
      removeTestTree(reference);
    }
  });

  it("U-TESTHYGIENE-042: fails closed when a sealed reference changes after its fingerprint is captured", () => {
    const reference = mkdtempSync(join(tmpdir(), "ut-tdd-reference-fingerprint-"));
    try {
      const file = join(reference, "package.json");
      writeFileSync(file, '{"version":1}\n');
      sealReference(reference);
      const fingerprint = snapshotContentFingerprint(reference);
      unsealReference(reference);
      writeFileSync(file, '{"version":2}\n');
      expect(() => assertSnapshotFingerprint(reference, fingerprint)).toThrow(
        "snapshot reference fingerprint mismatch",
      );
    } finally {
      removeTestTree(reference);
    }
  });

  it("U-TESTHYGIENE-039: uses one captured Git revision for execution and reference", () => {
    const source = mkdtempSync(join(tmpdir(), "ut-tdd-git-source-"));
    const execution = `${source}-execution`;
    const reference = `${source}-reference`;
    try {
      expect(spawnSync("git", ["init"], { cwd: source }).status).toBe(0);
      writeFileSync(join(source, "package.json"), '{"version":1}\n');
      expect(spawnSync("git", ["add", "package.json"], { cwd: source }).status).toBe(0);
      expect(
        spawnSync(
          "git",
          [
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "initial",
          ],
          { cwd: source },
        ).status,
      ).toBe(0);
      const captured = resolveSnapshotSource(source);
      expect(captured.kind).toBe("git");
      createSnapshot(source, execution, captured);
      writeFileSync(join(source, "package.json"), '{"version":2}\n');
      expect(spawnSync("git", ["add", "package.json"], { cwd: source }).status).toBe(0);
      expect(
        spawnSync(
          "git",
          ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "next"],
          { cwd: source },
        ).status,
      ).toBe(0);
      createSnapshot(source, reference, captured);
      expect(readFileSync(join(execution, "package.json"), "utf8").trim()).toBe('{"version":1}');
      expect(readFileSync(join(reference, "package.json"), "utf8").trim()).toBe('{"version":1}');
    } finally {
      removeTestTree(source);
      removeTestTree(execution);
      removeTestTree(reference);
    }
  });

  it("U-TESTHYGIENE-055: preserves distinct origin custody refs in a detached execution snapshot", () => {
    const source = mkdtempSync(join(tmpdir(), "ut-tdd-git-custody-source-"));
    const snapshot = `${source}-snapshot`;
    try {
      expect(spawnSync("git", ["init"], { cwd: source }).status).toBe(0);
      const sourceBranch = spawnSync("git", ["branch", "--show-current"], {
        cwd: source,
        encoding: "utf8",
      }).stdout.trim();
      writeFileSync(join(source, "package.json"), "{}\n");
      expect(spawnSync("git", ["add", "package.json"], { cwd: source }).status).toBe(0);
      expect(
        spawnSync(
          "git",
          [
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "initial",
          ],
          { cwd: source },
        ).status,
      ).toBe(0);
      const headRevision = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: source,
        encoding: "utf8",
      }).stdout.trim();
      expect(
        spawnSync("git", ["checkout", "--orphan", "custody-source"], { cwd: source }).status,
      ).toBe(0);
      writeFileSync(join(source, "package.json"), '{"custody":true}\n');
      expect(spawnSync("git", ["add", "package.json"], { cwd: source }).status).toBe(0);
      expect(
        spawnSync(
          "git",
          [
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "custody",
          ],
          { cwd: source },
        ).status,
      ).toBe(0);
      const custodyRevision = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: source,
        encoding: "utf8",
      }).stdout.trim();
      expect(spawnSync("git", ["checkout", sourceBranch], { cwd: source }).status).toBe(0);
      expect(spawnSync("git", ["branch", "-D", "custody-source"], { cwd: source }).status).toBe(0);
      expect(
        spawnSync("git", ["update-ref", "refs/remotes/origin/main", custodyRevision], {
          cwd: source,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["update-ref", "refs/remotes/origin/HEAD", custodyRevision], {
          cwd: source,
        }).status,
      ).toBe(0);

      createSnapshot(source, snapshot);

      expect(
        spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: snapshot,
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe(headRevision);
      expect(
        spawnSync("git", ["rev-parse", "origin/main"], {
          cwd: snapshot,
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe(custodyRevision);
      expect(
        spawnSync("git", ["rev-parse", "origin/HEAD"], {
          cwd: snapshot,
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe(custodyRevision);
    } finally {
      removeTestTree(source);
      removeTestTree(snapshot);
    }
  });

  it("U-TESTHYGIENE-036: seals the reference for the whole test interval and unseals cleanup", () => {
    const reference = mkdtempSync(join(tmpdir(), "ut-tdd-sealed-reference-"));
    const outside = mkdtempSync(join(tmpdir(), "ut-tdd-sealed-outside-"));
    const file = join(reference, "source.txt");
    const nested = join(reference, "nested");
    const outsideFile = join(outside, "outside.txt");
    try {
      writeFileSync(file, "immutable\n");
      mkdirSync(nested);
      writeFileSync(outsideFile, "outside\n");
      if (process.platform !== "win32") symlinkSync(outsideFile, join(reference, "outside-link"));
      sealReference(reference);
      if (process.platform === "win32") {
        expect(() => writeFileSync(file, "mutated\n")).toThrow();
        expect(() => writeFileSync(join(reference, "new.txt"), "created\n")).toThrow();
        expect(() => writeFileSync(join(nested, "new.txt"), "created\n")).toThrow();
      } else {
        expect(statSync(file).mode & 0o222).toBe(0);
        expect(statSync(outsideFile).mode & 0o222).not.toBe(0);
      }
      unsealReference(reference);
      writeFileSync(file, "cleanup-enabled\n");
    } finally {
      unsealReference(reference);
      removeTestTree(reference);
      removeTestTree(outside);
    }
  });

  it("U-TESTHYGIENE-027: copies only deterministic runtime inputs into the reference", () => {
    const execution = mkdtempSync(join(tmpdir(), "ut-tdd-execution-"));
    const reference = mkdtempSync(join(tmpdir(), "ut-tdd-reference-"));
    try {
      mkdirSync(join(execution, ".ut-tdd", "logs"), { recursive: true });
      mkdirSync(join(execution, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(join(execution, ".ut-tdd", "harness.db"), "db");
      writeFileSync(join(execution, ".ut-tdd", "logs", "feedback-lifecycle.jsonl"), "{}\n");
      writeFileSync(join(execution, ".ut-tdd", "memory", "private.md"), "must-not-copy\n");

      copyReferenceRuntimeInputs(execution, reference);

      expect(existsSync(join(reference, ".ut-tdd", "harness.db"))).toBe(true);
      expect(existsSync(join(reference, ".ut-tdd", "logs", "feedback-lifecycle.jsonl"))).toBe(true);
      expect(existsSync(join(reference, ".ut-tdd", "memory", "private.md"))).toBe(false);
    } finally {
      removeTestTree(execution);
      removeTestTree(reference);
    }
  });

  it("U-TESTHYGIENE-048: fails closed before seal when running as root (uid=0)", () => {
    expect(() => assertNotRoot(() => 0)).toThrow(
      "vitest snapshot runner refuses to run as root (uid=0)",
    );
    expect(() => assertNotRoot(() => 0)).toThrow(/chmod-based reference seal/);
    expect(() => assertNotRoot(() => 0)).toThrow(/Re-run as a non-root user/);
  });

  it("U-TESTHYGIENE-049: passes through unaffected for non-root uid and platforms without getuid", () => {
    expect(() => assertNotRoot(() => 1000)).not.toThrow();
    expect(() => assertNotRoot(undefined)).not.toThrow();
  });

  it("U-TESTHYGIENE-050: runSnapshotTests entrypoint fails closed before any snapshot side effect when uid=0 is injected", () => {
    const before = new Set(readdirSync(tmpdir()));
    let created: string[] = [];
    try {
      expect(() => runSnapshotTests(["--reporter=dot"], process.cwd(), () => 0)).toThrow(
        "vitest snapshot runner refuses to run as root (uid=0)",
      );
      created = readdirSync(tmpdir()).filter(
        (entry) => !before.has(entry) && entry.startsWith("ut-tdd-vitest-"),
      );
      expect(created).toEqual([]);
    } finally {
      for (const entry of created) removeTestTree(join(tmpdir(), entry));
    }
  });

  it("U-TESTHYGIENE-051: runSnapshotTests entrypoint reaches past the root guard for a non-root injected uid", () => {
    const missingRepoRoot = join(tmpdir(), `ut-tdd-missing-repo-${process.pid}-${Date.now()}`);
    const before = new Set(readdirSync(tmpdir()));
    let thrown: unknown;
    let created: string[] = [];
    try {
      try {
        runSnapshotTests(["--reporter=dot"], missingRepoRoot, () => 1000);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect(String(thrown)).not.toMatch(/refuses to run as root/);
    } finally {
      created = readdirSync(tmpdir()).filter(
        (entry) => !before.has(entry) && entry.startsWith("ut-tdd-vitest-"),
      );
      for (const entry of created) removeTestTree(join(tmpdir(), entry));
    }
  });

  it("U-TESTHYGIENE-052: Windows seal contract denies inherited write-data and add-file rights", () => {
    expect(windowsSealCommands("C:\\snapshot", "HOST\\runner")).toEqual([
      { file: "attrib", args: ["+R", "C:\\snapshot\\*", "/S"] },
      {
        file: "icacls",
        args: ["C:\\snapshot", "/deny", "HOST\\runner:(OI)(CI)(WD,AD)", "/T", "/C", "/Q"],
      },
    ]);
    expect(() => windowsSealCommands("C:\\snapshot", " ")).toThrow(
      "reference snapshot identity cannot be empty",
    );
  });

  it("U-TESTHYGIENE-022: propagates final snapshot cleanup failure", () => {
    const failure = new Error("EBUSY");
    expect(() =>
      removeSnapshot("snapshot", () => {
        throw failure;
      }),
    ).toThrow("vitest snapshot cleanup failed");
  });

  it("U-TESTHYGIENE-023: runs every cleanup and aggregates primary and cleanup failures", () => {
    const called: string[] = [];
    expect(() =>
      finishSnapshotCleanup(new Error("test failed"), [
        () => {
          called.push("snapshot");
          throw new Error("snapshot cleanup failed");
        },
        () => {
          called.push("cache");
          throw new Error("cache cleanup failed");
        },
      ]),
    ).toThrow("vitest execution and cleanup failed");
    expect(called).toEqual(["snapshot", "cache"]);
  });
});

/**
 * PLAN-L7-461 スコープ1 前提: snapshot は clone なので、CI checkout のように
 * local branch を持たない (detached HEAD) 面から作ると default branch の ref が消える。
 * ref 依存 check (`memory-sync` の `git ls-tree origin/main`、`merged-plan-status` の
 * canonical target 解決) は snapshot 内で評価不能になり、前者は判定変化、後者は throw する
 * (issue #186 で実測)。snapshot 作成時に default branch の ref→SHA を注入して同値にする。
 */
describe("snapshot default branch ref injection (PLAN-L7-461)", () => {
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  };
  const gitStatus = (cwd: string, ...args: string[]): number | null =>
    spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).status;

  /** CI checkout と同型の面を作る: default branch は remote-tracking ref にだけ在り、HEAD は detached。 */
  const makeDetachedCheckout = (): { origin: string; checkout: string; sha: string } => {
    const origin = mkdtempSync(join(tmpdir(), "ut-tdd-refinject-origin-"));
    git(origin, "init", "--initial-branch=main");
    git(origin, "config", "user.email", "test@example.com");
    git(origin, "config", "user.name", "test");
    writeFileSync(join(origin, "seed.txt"), "seed\n");
    git(origin, "add", "seed.txt");
    git(origin, "commit", "-m", "seed");
    const sha = git(origin, "rev-parse", "HEAD");

    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-refinject-checkout-"));
    removeTestTree(checkout);
    git(tmpdir(), "clone", "--no-tags", origin, checkout);
    git(checkout, "checkout", "--detach", sha);
    git(checkout, "branch", "-D", "main");
    return { origin, checkout, sha };
  };

  it("U-TESTHYGIENE-053: injects the default branch ref so ref-dependent checks resolve inside the snapshot", () => {
    const { origin, checkout, sha } = makeDetachedCheckout();
    const snapshot = `${checkout}-snapshot`;
    try {
      // 前提確認: local branch が無いので素の clone では default branch ref が生えない。
      expect(gitStatus(checkout, "rev-parse", "--verify", "main^{commit}")).not.toBe(0);

      createSnapshot(checkout, snapshot);

      expect(git(snapshot, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}")).toBe(sha);
      expect(git(snapshot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe(
        "origin/main",
      );
      // 注入は HEAD を動かさない (検証対象 revision は不変)。
      expect(git(snapshot, "rev-parse", "HEAD")).toBe(sha);
    } finally {
      removeTestTree(origin);
      removeTestTree(checkout);
      removeTestTree(snapshot);
    }
  });

  it("U-TESTHYGIENE-054: fabricates no ref when the source has no default branch, so ref-dependent checks stay fail-closed", () => {
    const { origin, checkout } = makeDetachedCheckout();
    const snapshot = `${checkout}-snapshot`;
    try {
      // default branch の痕跡を全て落とす (解決不能な面)。
      git(checkout, "remote", "remove", "origin");
      expect(
        gitStatus(checkout, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"),
      ).not.toBe(0);

      createSnapshot(checkout, snapshot);

      expect(
        gitStatus(snapshot, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"),
      ).not.toBe(0);
      expect(gitStatus(snapshot, "rev-parse", "--verify", "refs/heads/main^{commit}")).not.toBe(0);
    } finally {
      removeTestTree(origin);
      removeTestTree(checkout);
      removeTestTree(snapshot);
    }
  });
});
