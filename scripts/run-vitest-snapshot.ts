import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, relative, win32 } from "node:path";
import { resolveDefaultBranchRef } from "../src/git/default-branch.ts";
import { hashFileChunkedWithDiagnostics } from "../tests/support/chunked-hash.ts";

function run(
  command: string,
  args: string[],
  cwd: string,
  env = process.env,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? result.status}`,
    );
  }
}

function output(command: string, args: string[], cwd: string): string | null {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function resolveNodeBinary(current = process.execPath): string {
  return current;
}

export function resolveNpmCli(nodeBinary = resolveNodeBinary()): string {
  // npm を .cmd shim (cmd.exe/conhost 再導入) なしで起動するため npm-cli.js を直接指す。
  // Windows: <nodedir>/node_modules/npm/bin/npm-cli.js
  // POSIX:   <nodedir>/../lib/node_modules/npm/bin/npm-cli.js
  const nodeDir = dirname(nodeBinary === "node" ? (output("node", ["-e", "console.log(process.execPath)"], process.cwd()) ?? "node") : nodeBinary);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`npm-cli.js not found next to node executable (${nodeDir})`);
}

export function canonicalPath(path: string): string {
  const resolved = realpathSync.native(path).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export type SnapshotSource =
  { kind: "git"; revision: string } | { kind: "copy" };

export interface SnapshotStageTiming {
  readonly stage: string;
  readonly durationMs: number;
}

export interface SnapshotStageMeasurementOptions {
  readonly now?: () => number;
  readonly enabled?: boolean;
  readonly write?: (text: string) => void;
}

export function snapshotTimingLines(timings: readonly SnapshotStageTiming[]): string[] {
  return timings.map(({ stage, durationMs }) => `snapshot-stage ${stage} ${durationMs.toFixed(1)}ms`);
}

export function shouldEmitSnapshotTimings(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.UT_TDD_SNAPSHOT_TIMING === "1" || env.CI === "true";
}

export function emitSnapshotTimings(
  timings: readonly SnapshotStageTiming[],
  enabled = shouldEmitSnapshotTimings(),
  write: (text: string) => void = (text) => process.stderr.write(text),
): void {
  if (!enabled || timings.length === 0) return;
  write(`${snapshotTimingLines(timings).join("\n")}\n`);
}

export function measureSnapshotStage<T>(
  stage: string,
  action: () => T,
  options: SnapshotStageMeasurementOptions = {},
): T {
  const now = options.now ?? (() => performance.now());
  const started = now();
  try {
    return action();
  } finally {
    const timing = {
      stage,
      durationMs: now() - started,
    };
    // Emit a completed stage immediately. A later stage can hang or be killed,
    // and the measurements completed before that point must remain observable.
    emitSnapshotTimings(
      [timing],
      options.enabled ?? shouldEmitSnapshotTimings(),
      options.write,
    );
  }
}

export function resolveSnapshotSource(repoRoot: string): SnapshotSource {
  const topLevel = output("git", ["rev-parse", "--show-toplevel"], repoRoot);
  if (!topLevel || canonicalPath(topLevel) !== canonicalPath(repoRoot))
    return { kind: "copy" };
  const revision = output("git", ["rev-parse", "HEAD"], repoRoot);
  if (!revision) throw new Error("snapshot source HEAD cannot be resolved");
  return { kind: "git", revision };
}

/**
 * snapshot 内で default branch の ref を解決できるようにするための注入情報 (PLAN-L7-461)。
 *
 * snapshot は clone なので、CI checkout のように local branch を持たない面
 * (detached HEAD + remote-tracking ref のみ) から作ると default branch の ref が消える。
 * ref 依存の doctor check — `memory-sync` (`git ls-tree origin/main`) と
 * `merged-plan-status` (canonical target 解決、issue #186) — は snapshot 内で
 * 評価不能になり、前者は判定が変わり後者は throw する。producer と consumer で
 * 同じ観測をするために、作成時に ref→SHA をそのまま持ち込む。
 */
export type { DefaultBranchRef } from "../src/git/default-branch.ts";
export { resolveDefaultBranchRef } from "../src/git/default-branch.ts";

/**
 * 解決済みの default branch ref を snapshot へ複製する。HEAD は動かさない
 * (検証対象 revision は不変)。
 */
export function injectDefaultBranchRef(
  snapshotRoot: string,
  sourceRepo: string,
  ref: { branch: string; ref: string; sha: string },
): void {
  const target = `refs/remotes/origin/${ref.branch}`;
  run("git", ["fetch", "--no-tags", "--quiet", sourceRepo, `+${ref.ref}:${target}`], snapshotRoot);
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", target], snapshotRoot);
}

export function removeSnapshot(snapshotRoot: string, remove = rmSync): void {
  const failures: unknown[] = [];
  try {
    remove(snapshotRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "vitest snapshot cleanup failed");
}

export function createSnapshot(
  repoRoot: string,
  snapshotRoot: string,
  source = resolveSnapshotSource(repoRoot),
): void {
  if (source.kind === "git") {
    const originCustodyRefs = ["origin/main", "origin/HEAD"]
      .map((ref) => ({
        ref,
        revision: output("git", ["rev-parse", "--verify", `${ref}^{commit}`], repoRoot),
      }))
      .filter(
        (entry): entry is { ref: string; revision: string } => entry.revision !== null,
      );
    run(
      "git",
      [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        repoRoot,
        snapshotRoot,
      ],
      repoRoot,
    );
    run("git", ["checkout", "--detach", source.revision], snapshotRoot);
    for (const { ref, revision } of originCustodyRefs) {
      if (output("git", ["cat-file", "-e", `${revision}^{commit}`], snapshotRoot) === null) {
        run("git", ["fetch", "--no-tags", repoRoot, revision], snapshotRoot);
      }
      run("git", ["update-ref", `refs/remotes/${ref}`, revision], snapshotRoot);
    }
    if (output("git", ["rev-parse", "HEAD"], snapshotRoot) !== source.revision)
      throw new Error("snapshot revision mismatch");
    // ref 依存 check を producer / consumer で同値にする (PLAN-L7-461)。
    // 解決できない面では注入せず、従来どおり fail-close させる。
    const defaultBranchRef = resolveDefaultBranchRef(repoRoot);
    if (defaultBranchRef) injectDefaultBranchRef(snapshotRoot, repoRoot, defaultBranchRef);
    return;
  }
  cpSync(repoRoot, snapshotRoot, {
    recursive: true,
    filter: (path) =>
      !relative(repoRoot, path)
        .split(/[\\/]/)
        .some((part) => [".git", ".ut-tdd", "node_modules"].includes(part)),
  });
}

export function snapshotContentFingerprint(root: string): string {
  const entries: string[] = [];
  const visit = (path: string): void => {
    const rel = relative(root, path).replaceAll("\\", "/");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      entries.push(`link:${rel}:${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      entries.push(`dir:${rel}`);
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    entries.push(
      `file:${rel}:${hashFileChunkedWithDiagnostics("snapshot fingerprint", path, rel, stat.size)}`,
    );
  };
  visit(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export function assertSnapshotContentMatch(executionRoot: string, referenceRoot: string): void {
  if (snapshotContentFingerprint(executionRoot) !== snapshotContentFingerprint(referenceRoot))
    throw new Error("snapshot content mismatch");
}

export function assertSnapshotFingerprint(root: string, expectedFingerprint: string): void {
  if (snapshotContentFingerprint(root) !== expectedFingerprint)
    throw new Error("snapshot reference fingerprint mismatch");
}

export function assertBatchVitestArgs(args: readonly string[]): void {
  if (args.some((arg) => arg === "-w" || arg === "--watch" || arg.startsWith("--watch=")))
    throw new Error("vitest snapshot runner is batch-only; watch mode would observe a stale snapshot");
}

export function assertNotRoot(getuid = process.getuid): void {
  if (!getuid || getuid() !== 0) return;
  throw new Error(
    "vitest snapshot runner refuses to run as root (uid=0); chmod-based reference seal " +
      "(0o555/0o444) is a DAC permission that root bypasses, so the reference tree would not " +
      "be protected and the suite would fail late with an unrelated " +
      "'snapshot reference fingerprint mismatch' instead of this cause. Re-run as a non-root user.",
  );
}

export function finishSnapshotCleanup(
  primaryError: unknown,
  cleanups: Array<() => void>,
): void {
  const cleanupFailures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length === 0) return;
  if (primaryError)
    throw new AggregateError(
      [primaryError, ...cleanupFailures],
      "vitest execution and cleanup failed",
    );
  throw new AggregateError(cleanupFailures, "vitest snapshot cleanup failed");
}

export function copyReferenceRuntimeInputs(
  snapshotRoot: string,
  referenceRoot: string,
): void {
  const database = join(snapshotRoot, ".ut-tdd", "harness.db");
  if (existsSync(database)) {
    mkdirSync(join(referenceRoot, ".ut-tdd"), { recursive: true });
    copyFileSync(database, join(referenceRoot, ".ut-tdd", "harness.db"));
  }
  const lifecycleLog = join(
    snapshotRoot,
    ".ut-tdd",
    "logs",
    "feedback-lifecycle.jsonl",
  );
  if (!existsSync(lifecycleLog)) return;
  mkdirSync(join(referenceRoot, ".ut-tdd", "logs"), { recursive: true });
  copyFileSync(
    lifecycleLog,
    join(referenceRoot, ".ut-tdd", "logs", "feedback-lifecycle.jsonl"),
  );
}

function chmodTree(root: string, directoryMode: number, fileMode: number): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) {
      chmodSync(path, fileMode);
      return;
    }
    for (const entry of readdirSync(path)) visit(join(path, entry));
    chmodSync(path, directoryMode);
  };
  visit(root);
}

export function sealReference(referenceRoot: string): void {
  if (process.platform !== "win32") {
    chmodTree(referenceRoot, 0o555, 0o444);
    return;
  }
  const identity = output("whoami", [], referenceRoot);
  if (!identity) throw new Error("reference snapshot identity cannot be resolved");
  for (const command of windowsSealCommands(referenceRoot, identity))
    run(command.file, command.args, referenceRoot);
}

export interface WindowsSealCommand {
  file: "attrib" | "icacls";
  args: string[];
}

export function windowsSealCommands(
  referenceRoot: string,
  identity: string,
): WindowsSealCommand[] {
  if (!identity.trim()) throw new Error("reference snapshot identity cannot be empty");
  return [
    { file: "attrib", args: ["+R", win32.join(referenceRoot, "*"), "/S"] },
    {
      file: "icacls",
      args: [referenceRoot, "/deny", `${identity}:(OI)(CI)(WD,AD)`, "/T", "/C", "/Q"],
    },
  ];
}

export function unsealReference(referenceRoot: string): void {
  if (!existsSync(referenceRoot)) return;
  if (process.platform !== "win32") {
    chmodTree(referenceRoot, 0o755, 0o644);
    return;
  }
  const identity = output("whoami", [], referenceRoot);
  if (!identity) throw new Error("reference snapshot identity cannot be resolved");
  run("attrib", ["-R", join(referenceRoot, "*"), "/S"], referenceRoot);
  run(
    "icacls",
    [referenceRoot, "/remove:d", identity, "/T", "/C", "/Q"],
    referenceRoot,
  );
}

export function runSnapshotTests(
  args = process.argv.slice(2),
  repoRoot = process.cwd(),
  getuid = process.getuid,
): void {
  assertBatchVitestArgs(args);
  assertNotRoot(getuid);
  const snapshotRoot = join(
    tmpdir(),
    `ut-tdd-vitest-${process.pid}-${Date.now()}`,
  );
  const referenceRoot = join(
    tmpdir(),
    `ut-tdd-vitest-head-${process.pid}-${Date.now()}`,
  );
  const cacheRoot = join(
    tmpdir(),
    `ut-tdd-vitest-cache-${process.pid}-${Date.now()}`,
  );
  let primaryError: unknown;
  let sealedReferenceFingerprint: string | undefined;
  try {
    const node = measureSnapshotStage("resolve-node", () => resolveNodeBinary());
    const npmCli = measureSnapshotStage("resolve-npm", () => resolveNpmCli(node));
    const source = measureSnapshotStage("resolve-source", () =>
      resolveSnapshotSource(repoRoot),
    );
    measureSnapshotStage("create-execution-snapshot", () =>
      createSnapshot(repoRoot, snapshotRoot, source),
    );
    measureSnapshotStage("create-reference-snapshot", () =>
      createSnapshot(snapshotRoot, referenceRoot, resolveSnapshotSource(snapshotRoot)),
    );
    if (source.kind === "copy")
      measureSnapshotStage("assert-copy-content", () =>
        assertSnapshotContentMatch(snapshotRoot, referenceRoot),
      );
    measureSnapshotStage("npm-ci", () =>
      run(node, [npmCli, "ci", "--no-audit", "--no-fund"], snapshotRoot),
    );
    measureSnapshotStage("db-rebuild", () =>
      run(node, ["src/cli.ts", "db", "rebuild"], snapshotRoot),
    );
    measureSnapshotStage("copy-runtime-inputs", () =>
      copyReferenceRuntimeInputs(snapshotRoot, referenceRoot),
    );
    if (source.kind === "git")
      measureSnapshotStage("assert-reference-diff", () =>
        run(
          "git",
          ["diff", "--exit-code", "--", ":(exclude).ut-tdd/harness.db"],
          referenceRoot,
        ),
      );
    measureSnapshotStage("seal-reference", () => sealReference(referenceRoot));
    sealedReferenceFingerprint = measureSnapshotStage("fingerprint-reference", () =>
      snapshotContentFingerprint(referenceRoot),
    );
    measureSnapshotStage("vitest", () =>
      run(node, [join("node_modules", "vitest", "vitest.mjs"), "run", ...args], snapshotRoot, {
        ...process.env,
        INIT_CWD: snapshotRoot,
        UT_TDD_TEST_EXECUTION_ROOT: snapshotRoot,
        UT_TDD_TEST_FENCE_ROOT: repoRoot,
        UT_TDD_HEAD_SNAPSHOT_ROOT: referenceRoot,
        UT_TDD_UPDATE_CHECK_CACHE_DIR: cacheRoot,
        UT_TDD_VITEST_CACHE_DIR: join(cacheRoot, "vite"),
      }),
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (sealedReferenceFingerprint) {
      try {
        measureSnapshotStage("verify-reference", () =>
          assertSnapshotFingerprint(referenceRoot, sealedReferenceFingerprint!),
        );
      } catch (error) {
        primaryError = primaryError
          ? new AggregateError([primaryError, error], "vitest execution and reference verification failed")
          : error;
      }
    }
    measureSnapshotStage("cleanup", () =>
      finishSnapshotCleanup(primaryError, [
        () => unsealReference(referenceRoot),
        () => removeSnapshot(referenceRoot),
        () => removeSnapshot(snapshotRoot),
        () =>
          rmSync(cacheRoot, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
          }),
      ]),
    );
  }
  if (primaryError) throw primaryError;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) runSnapshotTests();
