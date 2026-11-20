import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupConsumerWorktreeRuntime } from "../src/setup/index.ts";
import {
  cleanupConsumerWorktreeRuntimeFixture,
  createConsumerWorktreeRuntimeFixture,
} from "./support/consumer-worktree-runtime.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";

let fixture: Awaited<ReturnType<typeof createConsumerWorktreeRuntimeFixture>>;

const WORKTREE_SETUP_FAULT = "consumer-worktree-setup-test-fault";

type ConsumerWorktreeSetupWithFault = (input: {
  readonly currentRoot: string;
  readonly worktreePath: string;
  readonly releaseDirectory: string;
  readonly expectedConsumerDigest: string;
  readonly fault?: (barrier: "afterRuntimePublishBeforeLauncher") => void;
}) => Promise<{ readonly status: "installed" | "already-installed" }>;

const setupConsumerWorktreeWithFault =
  setupConsumerWorktreeRuntime as unknown as ConsumerWorktreeSetupWithFault;

function snapshotPath(path: string): string {
  try {
    const info = lstatSync(path);
    const mode = info.mode & 0o7777;
    if (info.isSymbolicLink())
      return JSON.stringify({ kind: "symlink", mode, target: readlinkSync(path) });
    if (!info.isDirectory())
      return JSON.stringify({ kind: "file", mode, bytes: readFileSync(path).toString("hex") });
    return JSON.stringify({
      kind: "directory",
      mode,
      entries: readdirSync(path)
        .sort()
        .map((name) => [name, snapshotPath(join(path, name))]),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function worktreeSetupInput(worktreePath: string) {
  return {
    currentRoot: fixture.main,
    worktreePath,
    releaseDirectory: fixture.release,
    expectedConsumerDigest: fixture.anchor,
  };
}

function rollbackSnapshotPaths(worktreePath: string): readonly string[] {
  return [
    join(worktreePath, ".ut-tdd"),
    join(fixture.main, ".ut-tdd", "runtime"),
    dirname(fixture.cache),
    join(fixture.linked["001"], ".ut-tdd"),
  ];
}

describe("consumer worktree runtime rollback Red (#1592)", () => {
  heavyBeforeAll(["git", 300_000], async () => {
    fixture = await createConsumerWorktreeRuntimeFixture([
      "011-success",
      "011-empty",
      "011-existing",
    ]);
  });

  heavyAfterAll("teardown", () => cleanupConsumerWorktreeRuntimeFixture());

  describe.sequential("U-CWTRT-011 production transaction", () => {
    type InitialState = "absent" | "existing-sentinel";
    const rollbackBaselines = new Map<
      InitialState,
      {
        readonly target: string;
        readonly paths: readonly string[];
        readonly snapshot: readonly string[];
      }
    >();

    it("control: production install succeeds without a fault; already-installed skips it", async () => {
      const target = fixture.linked["011-success"];
      const result = await setupConsumerWorktreeRuntime(worktreeSetupInput(target));
      expect(result.status).toBe("installed");
      expect(existsSync(join(target, ".ut-tdd", "runtime", "activation", "active.json"))).toBe(
        true,
      );
      expect(existsSync(join(target, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(true);

      let callbackCalls = 0;
      const alreadyInstalled = await setupConsumerWorktreeWithFault({
        ...worktreeSetupInput(target),
        fault: () => {
          callbackCalls += 1;
        },
      });
      expect(alreadyInstalled.status).toBe("already-installed");
      expect(callbackCalls).toBe(0);
    });

    it("prerequisite: both rollback targets are isolated linked worktrees with valid initial states", () => {
      for (const initialState of ["absent", "existing-sentinel"] as const) {
        const target = fixture.linked[initialState === "absent" ? "011-empty" : "011-existing"];
        const linkedCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: target,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        });
        expect(linkedCheck.status, linkedCheck.stderr).toBe(0);
        expect(linkedCheck.stdout.trim()).toBe("true");

        const utTdd = join(target, ".ut-tdd");
        expect(snapshotPath(utTdd)).toBe("missing");
        if (initialState === "existing-sentinel") {
          mkdirSync(utTdd, { recursive: true });
          const sentinel = join(utTdd, "preserve.txt");
          writeFileSync(sentinel, "preexisting sentinel\n", { mode: 0o640 });
          const sentinelMode = lstatSync(sentinel).mode & 0o7777;
          expect(snapshotPath(sentinel)).toBe(
            JSON.stringify({
              kind: "file",
              mode: sentinelMode,
              bytes: Buffer.from("preexisting sentinel\n").toString("hex"),
            }),
          );
          expect(existsSync(join(utTdd, "runtime"))).toBe(false);
          expect(existsSync(join(utTdd, "bin", "ut-tdd.mjs"))).toBe(false);
        }
      }
    });

    for (const initialState of ["absent", "existing-sentinel"] as const) {
      it(`precondition snapshot (${initialState}) is valid immediately before the fault oracle`, () => {
        const target = fixture.linked[initialState === "absent" ? "011-empty" : "011-existing"];
        const paths = rollbackSnapshotPaths(target);
        const snapshot = paths.map(snapshotPath);
        expect(snapshot[1]).not.toBe("missing");
        expect(snapshot[2]).not.toBe("missing");
        if (initialState === "absent") {
          expect(snapshot[0]).toBe("missing");
        } else {
          const sentinel = join(target, ".ut-tdd", "preserve.txt");
          const sentinelMode = lstatSync(sentinel).mode & 0o7777;
          expect(snapshotPath(sentinel)).toBe(
            JSON.stringify({
              kind: "file",
              mode: sentinelMode,
              bytes: Buffer.from("preexisting sentinel\n").toString("hex"),
            }),
          );
          expect(snapshot[0]).toContain("preserve.txt");
        }
        rollbackBaselines.set(initialState, { target, paths, snapshot });
        expect(rollbackBaselines.has(initialState)).toBe(true);
      });

      it(`U-CWTRT-011 rollback oracle after runtime publish (${initialState})`, async () => {
        const baseline = rollbackBaselines.get(initialState);
        if (!baseline) throw new Error(`rollback precondition missing for ${initialState}`);
        const { target, paths, snapshot } = baseline;
        let callbackCalls = 0;
        let setupError: unknown;
        try {
          await setupConsumerWorktreeWithFault({
            ...worktreeSetupInput(target),
            fault: (barrier) => {
              callbackCalls += 1;
              expect(barrier).toBe("afterRuntimePublishBeforeLauncher");
              expect(
                existsSync(join(target, ".ut-tdd", "runtime", "activation", "active.json")),
              ).toBe(true);
              expect(existsSync(join(target, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(false);
              throw new Error(WORKTREE_SETUP_FAULT);
            },
          });
        } catch (error) {
          setupError = error;
        }

        expect(callbackCalls).toBe(1);
        expect(String(setupError)).toContain(WORKTREE_SETUP_FAULT);
        expect(paths.map(snapshotPath)).toEqual(snapshot);
      });
    }
  });
});
