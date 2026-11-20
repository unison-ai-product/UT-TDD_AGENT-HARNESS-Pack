import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CandidatePreconditionFailure,
  verifySnapshotCandidate,
} from "./support/snapshot-candidate.ts";
import { removeTestTree } from "./support/temp-tree.ts";

/*
 * Contract-first Red (issue #1129): the subject module is intentionally absent in this slice.
 * A module-resolution failure inside it.fails keeps the contract PR green, but is NOT evidence
 * that any individual guard is Red. The implementation PR must run candidate-specific mutation
 * probes before converting these to ordinary tests. Real-process oracles (013-017, 020) are
 * added by the Green PRs, not here.
 */

interface Identity {
  pid: number;
  startToken: string | null;
}
interface Entry extends Identity {
  ppid: number;
  pgid: number | null;
  startOrder: number | null;
}
interface Lease {
  schema: 1;
  runId: string;
  runner: Identity;
  owner: Identity;
  roots: string[];
  stage: { name: string; child: Identity & { pgid?: number; startOrder?: number } } | null;
  createdAt: string;
}
type Observation = Identity | null | "query_failed";
interface SweepPlan {
  kill: Identity[];
  removePaths: string[];
  skipped: { runId: string; reason: string }[];
  reapedRunIds: string[];
}
interface LeaseApi {
  classifyLiveness(recorded: Identity, observed: Observation): "alive" | "dead" | "unknown";
  decideParentWatch(input: {
    owner: Identity;
    observed: Observation;
    consecutiveUnknown: number;
  }): {
    action: "continue" | "stop_parent_lost" | "stop_parent_unobservable";
    emitUnknownDiagnostic: boolean;
  };
  planSweep(input: {
    leases: Lease[];
    table: Entry[] | "query_failed";
    tmpRoot: string;
    platform: "win32" | "posix";
  }): SweepPlan;
  stopStageTree(input: {
    runnerPid: number;
    child: Identity & { pgid?: number };
    platform: "win32" | "posix";
    port: { killTree(target: { kind: "pid" | "pgid"; value: number }): number };
  }): unknown;
  judgeTreeStop(input: {
    exitCode: number;
    stdout: string;
    survivorsAfter: number;
  }): "stopped" | "failed" | "survivors";
}

interface GitSourceFixture {
  root: string;
  head: string;
}

interface SnapshotStageObservation {
  root: string;
  staged: string | null;
  unstaged: string | null;
  untracked: boolean;
  ignored: boolean;
  packManifest: boolean;
}

interface SnapshotRunnerCapture {
  runnerError: string | null;
  stdout: string;
  stderr: string;
  exitCodeBefore: number | string | null | undefined;
  exitCodeAfter: number | string | null | undefined;
  stageCalls: string[];
  snapshotStages: SnapshotStageObservation[];
}

function rejectCandidatePrecondition(reason: string): never {
  throw new CandidatePreconditionFailure(reason);
}

function gitOk(cwd: string, args: string[]): boolean {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 && !result.error;
}

function createGitSourceFixture(): GitSourceFixture | null {
  let root: string | undefined;
  let ready = false;
  try {
    root = mkdtempSync(join(tmpdir(), "ut-tdd-snapshot-source-red-"));
    if (!gitOk(root, ["init"])) return null;
    writeFileSync(join(root, ".gitattributes"), "staged.txt -text\nunstaged.txt -text\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(root, "staged.txt"), "base staged\n");
    writeFileSync(join(root, "unstaged.txt"), "base unstaged\n");
    if (!gitOk(root, ["add", "--all"])) return null;
    if (
      !gitOk(root, [
        "-c",
        "user.name=UT-TDD fixture",
        "-c",
        "user.email=ut-tdd-fixture@example.invalid",
        "commit",
        "-m",
        "snapshot source fixture",
      ])
    )
      return null;
    const revision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    if (revision.status !== 0 || revision.error) return null;
    ready = true;
    return { root, head: revision.stdout.trim() };
  } catch {
    return null;
  } finally {
    if (root && !ready) removeTestTree(root);
  }
}

function snapshotStageObservation(root: string): SnapshotStageObservation {
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return null;
    }
  };
  return {
    root,
    staged: read("staged.txt"),
    unstaged: read("unstaged.txt"),
    untracked: existsSync(join(root, "untracked.txt")),
    ignored: existsSync(join(root, "ignored.txt")),
    packManifest: existsSync(join(root, "package.json")),
  };
}

async function runSnapshotRunnerWithStageStubs(
  args: string[],
  repoRoot: string,
): Promise<SnapshotRunnerCapture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stageCalls: string[] = [];
  const snapshotStages: SnapshotStageObservation[] = [];
  const exitCodeBefore = process.exitCode;
  const childProcess =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const mockSpawnSync = ((
    command: string,
    commandArgs: string[] = [],
    options?: { cwd?: string },
  ) => {
    if (command === "git") return childProcess.spawnSync(command, commandArgs, options as never);
    const rendered = commandArgs.join(" ");
    stageCalls.push(rendered);
    if (commandArgs[0]?.endsWith("npm-cli.js"))
      snapshotStages.push(snapshotStageObservation(options?.cwd ?? repoRoot));
    return {
      status: 0,
      stdout: command === "whoami" ? "fixture-user\n" : "",
      stderr: "",
      error: undefined,
      signal: null,
      pid: process.pid,
      output: ["", ""],
    };
  }) as never;
  vi.doMock("node:child_process", () => ({ ...childProcess, spawnSync: mockSpawnSync }));
  vi.resetModules();
  const stdoutWrite = vi.spyOn(process.stdout, "write");
  const stderrWrite = vi.spyOn(process.stderr, "write");
  stdoutWrite.mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  stderrWrite.mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
  let runnerError: string | null = null;
  try {
    const { runSnapshotTests } = await import("../scripts/run-vitest-snapshot.ts");
    runSnapshotTests(args, repoRoot, () => 1);
  } catch (error) {
    runnerError = String(error);
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
  return {
    runnerError,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCodeBefore,
    exitCodeAfter: process.exitCode,
    stageCalls,
    snapshotStages,
  };
}

function snapshotRunnerCompletionFailure(capture: SnapshotRunnerCapture): string | null {
  if (capture.runnerError) return `runner threw: ${capture.runnerError}`;
  if (capture.exitCodeAfter !== capture.exitCodeBefore)
    return `process.exitCode changed from ${String(capture.exitCodeBefore)} to ${String(capture.exitCodeAfter)}`;
  if (capture.snapshotStages.length === 0) return "npm stage did not observe an execution snapshot";
  const requiredStages = ["npm-cli.js ci", "src/cli.ts db rebuild", "vitest.mjs run"];
  const missingStages = requiredStages.filter(
    (required) => !capture.stageCalls.some((call) => call.includes(required)),
  );
  return missingStages.length > 0 ? `stub stages not reached: ${missingStages.join(", ")}` : null;
}

async function loadSubject(): Promise<LeaseApi> {
  // Non-literal specifier so this file transforms before the production subject exists.
  // No repository path is read here (test-repository-isolation forbids import.meta / cwd roots).
  const specifier = ["..", "src", "runtime", "snapshot-run-lease.ts"].join("/");
  return (await import(/* @vite-ignore */ specifier)) as unknown as LeaseApi;
}

const TMP = join("tmp-root");
const id = (pid: number, token: string | null = `t${pid}`): Identity => ({
  pid,
  startToken: token,
});
const entry = (pid: number, ppid: number, extra: Partial<Entry> = {}): Entry => ({
  pid,
  ppid,
  pgid: null,
  startToken: `t${pid}`,
  startOrder: pid,
  ...extra,
});
const lease = (extra: Partial<Lease> = {}): Lease => ({
  schema: 1,
  runId: "run-a",
  runner: id(100),
  owner: id(50),
  roots: [join(TMP, "ut-tdd-vitest-100-1")],
  stage: { name: "vitest", child: id(200) },
  createdAt: "2026-10-19T00:00:00.000Z",
  ...extra,
});
const plan = (
  api: LeaseApi,
  leases: Lease[],
  table: Entry[] | "query_failed",
  platform: "win32" | "posix" = "win32",
) => api.planSweep({ leases, table, tmpRoot: TMP, platform });

describe("snapshot runner lifecycle L7 candidate Red (issue #1129 / #1415)", () => {
  it.fails("CANDIDATE-U-SNAPLC-001: liveness uses pid and startToken, unknown is not dead", async () => {
    const api = await loadSubject();
    expect(api.classifyLiveness(id(1), id(1))).toBe("alive");
    expect(api.classifyLiveness(id(1), null)).toBe("dead");
    expect(api.classifyLiveness(id(1, "a"), id(1, "b"))).toBe("dead");
    expect(api.classifyLiveness(id(1), "query_failed")).toBe("unknown");
    expect(api.classifyLiveness(id(1, null), id(1))).toBe("unknown");
  });

  it.fails("CANDIDATE-U-SNAPLC-002: parent watch stops only on confirmed death", async () => {
    const api = await loadSubject();
    const owner = id(50);
    expect(api.decideParentWatch({ owner, observed: null, consecutiveUnknown: 0 }).action).toBe(
      "stop_parent_lost",
    );
    expect(api.decideParentWatch({ owner, observed: owner, consecutiveUnknown: 0 }).action).toBe(
      "continue",
    );
    for (const n of [1, 2, 3, 10]) {
      const r = api.decideParentWatch({ owner, observed: "query_failed", consecutiveUnknown: n });
      expect(r.action).toBe("continue");
      expect(r.emitUnknownDiagnostic).toBe(n === 3);
    }
  });

  it.fails("CANDIDATE-U-SNAPLC-003: sweep does nothing when the process table is unavailable", async () => {
    const api = await loadSubject();
    const r = plan(api, [lease(), lease({ runId: "run-b" })], "query_failed");
    expect(r.kill).toEqual([]);
    expect(r.removePaths).toEqual([]);
    expect(r.reapedRunIds).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["query_failed", "query_failed"]);
  });

  it.fails("CANDIDATE-U-SNAPLC-004: a live runner's lease, children and roots are never touched", async () => {
    const api = await loadSubject();
    const table = [entry(100, 50), entry(200, 100), entry(300, 200)];
    const r = plan(api, [lease()], table);
    expect(r.kill).toEqual([]);
    expect(r.removePaths).toEqual([]);
    expect(r.skipped).toEqual([{ runId: "run-a", reason: "runner_alive" }]);
  });

  it.fails("CANDIDATE-U-SNAPLC-005: dead runner reaps only the proven child chain even when owner lives", async () => {
    const api = await loadSubject();
    const table = [entry(50, 1), entry(200, 100), entry(300, 200), entry(400, 300), entry(999, 1)];
    const r = plan(api, [lease()], table);
    expect(r.kill.map((k) => k.pid)).toEqual([200, 300, 400]);
    expect(r.reapedRunIds).toEqual(["run-a"]);
  });

  it.fails("CANDIDATE-U-SNAPLC-006: a reused child pid is not killed", async () => {
    const api = await loadSubject();
    const table = [entry(200, 1, { startToken: "other-process" })];
    const r = plan(api, [lease()], table);
    expect(r.kill).toEqual([]);
    expect(r.removePaths).toEqual([]);
    expect(r.reapedRunIds).toEqual([]);
    expect(r.skipped).toEqual([{ runId: "run-a", reason: "identity_unproven" }]);
  });

  it.fails("CANDIDATE-U-SNAPLC-007: win32 grandchildren of a dead child are never reaped from a stale lease", async () => {
    const api = await loadSubject();
    const l = lease({
      stage: { name: "vitest", child: { pid: 200, startToken: "c", startOrder: 10 } },
    });
    const tables: Entry[][] = [
      // (a) child.pid is free; same table as "child died, pid reused, its child started, reuser died"
      [entry(300, 200, { startOrder: 20 })],
      // (b) child.pid occupied by another process that started after the grandchild
      [entry(200, 1, { startToken: "x", startOrder: 30 }), entry(300, 200, { startOrder: 20 })],
      // (c) occupant started before the grandchild
      [entry(200, 1, { startToken: "x", startOrder: 15 }), entry(300, 200, { startOrder: 20 })],
      // (d) grandchild started before the recorded child
      [entry(300, 200, { startOrder: 5 })],
    ];
    for (const table of tables) {
      const r = plan(api, [l], table);
      expect(r.kill).toEqual([]);
      expect(r.removePaths).toEqual([]);
      expect(r.reapedRunIds).toEqual([]);
      expect(r.skipped).toEqual([{ runId: "run-a", reason: "identity_unproven" }]);
    }
  });

  it.fails("CANDIDATE-U-SNAPLC-008: posix reaps a group only while its leader is the proven live child", async () => {
    const api = await loadSubject();
    const l = lease({ stage: { name: "vitest", child: { pid: 200, startToken: "c", pgid: 200 } } });
    const members = [
      entry(301, 1, { pgid: 200 }),
      entry(302, 1, { pgid: 200 }),
      entry(303, 1, { pgid: 999 }),
    ];
    const leaderAlive = [entry(200, 1, { startToken: "c", pgid: 200 }), ...members];
    expect(plan(api, [l], leaderAlive, "posix").kill.map((k) => k.pid)).toEqual([200, 301, 302]);
    const r = plan(api, [l], members, "posix");
    expect(r.kill).toEqual([]);
    expect(r.removePaths).toEqual([]);
    expect(r.reapedRunIds).toEqual([]);
    expect(r.skipped).toEqual([{ runId: "run-a", reason: "identity_unproven" }]);
  });

  it.fails("CANDIDATE-U-SNAPLC-009: identities without a startToken are never killed", async () => {
    const api = await loadSubject();
    const table = [entry(200, 100, { startToken: null }), entry(300, 200, { startToken: null })];
    const r = plan(api, [lease()], table);
    expect(r.kill).toEqual([]);
    expect(r.skipped.some((s) => s.reason === "identity_unproven")).toBe(true);
  });

  it.fails("CANDIDATE-U-SNAPLC-010: only well-formed roots directly under the tmp root are removed", async () => {
    const api = await loadSubject();
    const good = join(TMP, "ut-tdd-vitest-100-1");
    const roots = [
      good,
      join("elsewhere", "ut-tdd-vitest-100-2"),
      join(TMP, "unrelated-dir"),
      join(TMP, "deep", "ut-tdd-vitest-100-3"),
      join(TMP, "..", "ut-tdd-vitest-100-4"),
    ];
    const r = plan(api, [lease({ roots, stage: null })], []);
    expect(r.removePaths).toEqual([good]);
  });

  it.fails("CANDIDATE-U-SNAPLC-011: sweep planning is deterministic and ordered", async () => {
    const api = await loadSubject();
    const table = [entry(400, 300), entry(300, 200), entry(200, 100)];
    const a = lease({ runId: "b" });
    const b = lease({ runId: "a", runner: id(101), stage: null });
    const r1 = plan(api, [a, b], table);
    const r2 = plan(api, [b, a], [...table].reverse());
    expect(r1).toEqual(r2);
    const pids = r1.kill.map((k) => k.pid);
    expect(pids).toEqual([...pids].sort((x, y) => x - y));
    expect(r1.reapedRunIds).toEqual([...r1.reapedRunIds].sort());
  });

  it.fails("CANDIDATE-U-SNAPLC-012: unrelated node/vitest processes are not victims", async () => {
    const api = await loadSubject();
    const unrelated = Array.from({ length: 20 }, (_, i) => entry(5000 + i, 1, { pgid: 7000 + i }));
    expect(plan(api, [lease()], unrelated).kill).toEqual([]);
  });

  it.fails("CANDIDATE-U-SNAPLC-018: tree kill never targets the runner itself", async () => {
    const api = await loadSubject();
    for (const platform of ["win32", "posix"] as const) {
      const calls: { kind: string; value: number }[] = [];
      api.stopStageTree({
        runnerPid: 100,
        child: { pid: 200, startToken: "c", pgid: 200 },
        platform,
        port: {
          killTree(target) {
            calls.push(target);
            return 0;
          },
        },
      });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.value !== 100 && c.value !== -100)).toBe(true);
    }
  });

  it.fails("CANDIDATE-U-SNAPLC-019: kill result is decided by exit code and re-observation, not output text", async () => {
    const api = await loadSubject();
    for (const stdout of [
      "",
      "SUCCESS: terminated",
      "成功しました",
      "プロセスは強制終了されました",
    ]) {
      expect(api.judgeTreeStop({ exitCode: 0, stdout, survivorsAfter: 0 })).toBe("stopped");
    }
    expect(api.judgeTreeStop({ exitCode: 128, stdout: "成功しました", survivorsAfter: 0 })).toBe(
      "failed",
    );
    expect(api.judgeTreeStop({ exitCode: 0, stdout: "成功しました", survivorsAfter: 2 })).toBe(
      "survivors",
    );
  });

  it.fails("CANDIDATE-U-SNAPLC-021: unobservable parent stops the run only at the consecutive-unknown limit", async () => {
    const api = await loadSubject();
    const owner = id(50);
    const at = (observed: Observation, n: number) =>
      api.decideParentWatch({ owner, observed, consecutiveUnknown: n }).action;
    expect(at("query_failed", 14)).toBe("continue");
    expect(at("query_failed", 15)).toBe("stop_parent_unobservable");
    expect(at("query_failed", 16)).toBe("stop_parent_unobservable");
    expect(at(null, 15)).toBe("stop_parent_lost");
    expect(at(owner, 15)).toBe("continue");
  });

  it("U-SNAPLC-022: dirty Git runner warns and continues on the committed snapshot", async () => {
    let fixture: GitSourceFixture | null = null;
    await verifySnapshotCandidate(
      "022",
      () => {
        if (fixture) removeTestTree(fixture.root);
      },
      async (assertionsReached) => {
        try {
          fixture = createGitSourceFixture();
        } catch (error) {
          rejectCandidatePrecondition(`Git fixture creation threw: ${String(error)}`);
        }
        if (!fixture) rejectCandidatePrecondition("Git fixture creation returned no fixture");

        let setupOkay = true;
        let setupFailure: string | null = null;
        try {
          writeFileSync(join(fixture.root, "staged.txt"), "staged edit\n");
          setupOkay = gitOk(fixture.root, ["add", "staged.txt"]);
          writeFileSync(join(fixture.root, "unstaged.txt"), "unstaged edit\n");
          writeFileSync(join(fixture.root, "untracked.txt"), "untracked edit\n");
          writeFileSync(join(fixture.root, "ignored.txt"), "ignored edit\n");
          if (!setupOkay) setupFailure = "git add staged.txt returned nonzero";
        } catch (error) {
          setupOkay = false;
          setupFailure = String(error);
        }
        if (!setupOkay) rejectCandidatePrecondition(`dirty fixture setup failed: ${setupFailure}`);

        let captured: SnapshotRunnerCapture;
        try {
          captured = await runSnapshotRunnerWithStageStubs([], fixture.root);
        } catch (error) {
          rejectCandidatePrecondition(`runner harness setup threw: ${String(error)}`);
        }
        const completionFailure = snapshotRunnerCompletionFailure(captured);
        if (completionFailure) rejectCandidatePrecondition(completionFailure);
        const executionSnapshot = captured.snapshotStages[0];
        if (!executionSnapshot)
          rejectCandidatePrecondition("npm stage has no snapshot observation");
        assertionsReached();
        expect(executionSnapshot.staged).toBe("base staged\n");
        expect(executionSnapshot.unstaged).toBe("base unstaged\n");
        expect(executionSnapshot.untracked).toBe(false);
        expect(executionSnapshot.ignored).toBe(false);
        expect(captured.stderr).toContain(fixture.head);
        expect(captured.stderr).toMatch(/(?:作業\s*(?:tree|ツリー)|working tree)/i);
        expect(captured.stderr).toMatch(
          /(?:ではなく|でなく|ではない|対象外|not|rather than|instead of)/i,
        );
        expect(captured.stderr).toContain("staged.txt");
        expect(captured.stderr).toContain("unstaged.txt");
        expect(captured.stderr).toContain("untracked.txt");
        expect(captured.stderr).not.toContain("ignored.txt");
      },
    );
  });

  it("U-SNAPLC-023: non-Git Pack runner names copy source and path", async () => {
    let parent: string | null = null;
    let pack: string | null = null;
    await verifySnapshotCandidate(
      "023",
      () => {
        if (parent) removeTestTree(parent);
      },
      async (assertionsReached) => {
        try {
          parent = mkdtempSync(join(tmpdir(), "ut-tdd-snapshot-copy-red-"));
        } catch (error) {
          rejectCandidatePrecondition(`Pack fixture parent creation threw: ${String(error)}`);
        }
        const gitInitSucceeded = gitOk(parent, ["init"]);
        if (!gitInitSucceeded)
          rejectCandidatePrecondition("fixture Git root initialization returned nonzero");
        pack = join(parent, "pack");
        try {
          mkdirSync(pack);
          writeFileSync(join(pack, "package.json"), "{}\n");
        } catch (error) {
          rejectCandidatePrecondition(`Pack fixture setup threw: ${String(error)}`);
        }

        let captured: SnapshotRunnerCapture;
        try {
          captured = await runSnapshotRunnerWithStageStubs([], pack);
        } catch (error) {
          rejectCandidatePrecondition(`runner harness setup threw: ${String(error)}`);
        }
        const completionFailure = snapshotRunnerCompletionFailure(captured);
        if (completionFailure) rejectCandidatePrecondition(completionFailure);
        if (!captured.snapshotStages[0]?.packManifest)
          rejectCandidatePrecondition(
            `Pack manifest absent at npm stage: ${JSON.stringify(captured.snapshotStages[0])}`,
          );
        const output = `${captured.stdout}${captured.stderr}`.replaceAll("\\", "/");
        assertionsReached();
        expect(output).toContain("source: copy (commit なし)");
        expect(output).toContain(pack.replaceAll("\\", "/"));
      },
    );
  });

  it("U-SNAPLC-024: clean Git runner output identifies the commit SHA", async () => {
    let fixture: GitSourceFixture | null = null;
    await verifySnapshotCandidate(
      "024",
      () => {
        if (fixture) removeTestTree(fixture.root);
      },
      async (assertionsReached) => {
        try {
          fixture = createGitSourceFixture();
        } catch (error) {
          rejectCandidatePrecondition(`Git fixture creation threw: ${String(error)}`);
        }
        if (!fixture) rejectCandidatePrecondition("Git fixture creation returned no fixture");

        let captured: SnapshotRunnerCapture;
        try {
          captured = await runSnapshotRunnerWithStageStubs([], fixture.root);
        } catch (error) {
          rejectCandidatePrecondition(`runner harness setup threw: ${String(error)}`);
        }
        const completionFailure = snapshotRunnerCompletionFailure(captured);
        if (completionFailure) rejectCandidatePrecondition(completionFailure);
        const executionSnapshot = captured.snapshotStages[0];
        if (!executionSnapshot)
          rejectCandidatePrecondition("npm stage has no snapshot observation");

        assertionsReached();
        expect(executionSnapshot.staged).toBe("base staged\n");
        expect(`${captured.stdout}${captured.stderr}`).toContain(fixture.head);
      },
    );
  });
});
