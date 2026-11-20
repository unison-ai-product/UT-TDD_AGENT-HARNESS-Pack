import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type ConsumerNodeRuntimeIdentity,
  renderConsumerNodeWrapper,
} from "./consumer-node-runtime.ts";
import type {
  SetupConsumerRuntimeInput,
  SetupConsumerRuntimeInstall,
  SetupResult,
} from "./consumer-runtime-contracts.ts";

interface RuntimeLauncherSnapshot {
  readonly launcherPath: string;
  readonly launcher: { readonly bytes: Buffer; readonly mode: number } | null;
  readonly utTddDirectory: string;
  readonly utTddExisted: boolean;
  readonly binDirectory: string;
  readonly binExisted: boolean;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function captureRuntimeLauncher(repoRoot: string): RuntimeLauncherSnapshot {
  const utTddDirectory = join(repoRoot, ".ut-tdd");
  const binDirectory = join(utTddDirectory, "bin");
  const launcherPath = join(binDirectory, "ut-tdd.mjs");
  for (const [path, label] of [
    [utTddDirectory, "runtime root"],
    [binDirectory, "runtime bin"],
  ] as const) {
    const stat = lstatIfPresent(path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error(`consumer_runtime_setup_snapshot:${label}`);
  }
  const launcherStat = lstatIfPresent(launcherPath);
  if (launcherStat && (!launcherStat.isFile() || launcherStat.isSymbolicLink()))
    throw new Error("consumer_runtime_setup_snapshot:launcher");
  return {
    launcherPath,
    launcher: launcherStat
      ? { bytes: readFileSync(launcherPath), mode: Number(launcherStat.mode) & 0o777 }
      : null,
    utTddDirectory,
    utTddExisted: lstatIfPresent(utTddDirectory) !== null,
    binDirectory,
    binExisted: lstatIfPresent(binDirectory) !== null,
  };
}

function writeRuntimeLauncher(snapshot: RuntimeLauncherSnapshot): boolean {
  const contentBytes = Buffer.from(renderConsumerNodeWrapper(), "utf8");
  const initialStat = lstatIfPresent(snapshot.launcherPath);
  if (initialStat?.isFile() && !initialStat.isSymbolicLink()) {
    if (readFileSync(snapshot.launcherPath).equals(contentBytes)) return false;
  }
  mkdirSync(dirname(snapshot.launcherPath), { recursive: true });
  let stageDirectory: string | null = null;
  try {
    stageDirectory = mkdtempSync(join(snapshot.binDirectory, ".ut-tdd-launcher-"));
    const stagePath = join(stageDirectory, "ut-tdd.mjs");
    writeFileSync(stagePath, contentBytes, { mode: snapshot.launcher?.mode ?? 0o666 });
    if (snapshot.launcher) chmodSync(stagePath, snapshot.launcher.mode);

    const currentStat = lstatIfPresent(snapshot.launcherPath);
    if (snapshot.launcher === null) {
      if (currentStat) throw new Error("consumer_runtime_setup_restore:launcher_changed");
    } else if (
      !currentStat?.isFile() ||
      currentStat.isSymbolicLink() ||
      (Number(currentStat.mode) & 0o777) !== snapshot.launcher.mode ||
      !readFileSync(snapshot.launcherPath).equals(snapshot.launcher.bytes)
    ) {
      throw new Error("consumer_runtime_setup_restore:launcher_changed");
    }

    renameSync(stagePath, snapshot.launcherPath);
    rmdirSync(stageDirectory);
    stageDirectory = null;
    return true;
  } catch (error) {
    if (stageDirectory) {
      try {
        rmSync(stageDirectory, { recursive: true, force: false });
      } catch (cleanupError) {
        throw new Error(
          `consumer_runtime_indeterminate:launcher_stage_cleanup=${String(cleanupError)};primary=${String(error)}`,
        );
      }
    }
    throw error;
  }
}

function restoreRuntimeLauncher(snapshot: RuntimeLauncherSnapshot, writtenContent: string): void {
  const currentStat = lstatIfPresent(snapshot.launcherPath);
  if (snapshot.launcher) {
    if (currentStat && (!currentStat.isFile() || currentStat.isSymbolicLink()))
      throw new Error("consumer_runtime_setup_restore:launcher_type_changed");
    if (currentStat) {
      const currentBytes = readFileSync(snapshot.launcherPath);
      if (
        !currentBytes.equals(snapshot.launcher.bytes) &&
        !currentBytes.equals(Buffer.from(writtenContent, "utf8"))
      )
        throw new Error("consumer_runtime_setup_restore:launcher_changed");
      if (!currentBytes.equals(snapshot.launcher.bytes)) {
        chmodSync(snapshot.launcherPath, snapshot.launcher.mode | 0o200);
        writeFileSync(snapshot.launcherPath, snapshot.launcher.bytes);
        chmodSync(snapshot.launcherPath, snapshot.launcher.mode);
      }
    } else {
      mkdirSync(dirname(snapshot.launcherPath), { recursive: true });
      writeFileSync(snapshot.launcherPath, snapshot.launcher.bytes, {
        mode: snapshot.launcher.mode,
      });
      chmodSync(snapshot.launcherPath, snapshot.launcher.mode);
    }
  } else if (currentStat) {
    if (!currentStat.isFile() || currentStat.isSymbolicLink())
      throw new Error("consumer_runtime_setup_restore:launcher_type_changed");
    if (!readFileSync(snapshot.launcherPath).equals(Buffer.from(writtenContent, "utf8")))
      throw new Error("consumer_runtime_setup_restore:launcher_changed");
    rmSync(snapshot.launcherPath, { force: false });
  }
  if (!snapshot.binExisted && lstatIfPresent(snapshot.binDirectory)?.isDirectory()) {
    if (readdirSync(snapshot.binDirectory).length === 0) rmdirSync(snapshot.binDirectory);
  }
  if (!snapshot.utTddExisted && lstatIfPresent(snapshot.utTddDirectory)?.isDirectory()) {
    if (readdirSync(snapshot.utTddDirectory).length === 0) rmdirSync(snapshot.utTddDirectory);
  }
}

/** Internal-only test seam; never exposed as a CLI / Pack API option. */
export type ConsumerWorktreeSetupFault = (barrier: "afterRuntimePublishBeforeLauncher") => void;

export function createConsumerRuntimeOnlyInstaller<TSnapshot>(ports: {
  readonly assertSetupRuntimeRoot: (
    identity: ConsumerNodeRuntimeIdentity,
    repoRoot: string,
  ) => void;
  readonly captureRuntimeTree: (root: string) => TSnapshot;
  readonly restoreRuntimeTree: (root: string, snapshot: TSnapshot) => void;
  readonly installConsumerRuntimeFromSetup: (
    input: SetupConsumerRuntimeInput,
  ) => Promise<SetupConsumerRuntimeInstall>;
}): {
  readonly ensureLauncher: (repoRoot: string) => void;
  readonly install: (
    input: SetupConsumerRuntimeInput,
    repoRoot: string,
    fault?: ConsumerWorktreeSetupFault,
  ) => Promise<SetupResult>;
} {
  const ensureLauncher = (repoRoot: string): void => {
    const snapshot = captureRuntimeLauncher(repoRoot);
    const content = renderConsumerNodeWrapper();
    try {
      writeRuntimeLauncher(snapshot);
    } catch (error) {
      try {
        restoreRuntimeLauncher(snapshot, content);
      } catch (restoreError) {
        throw new Error(
          `consumer_runtime_indeterminate:launcher=${String(restoreError)};primary=${String(error)}`,
        );
      }
      throw error;
    }
  };

  const install = async (
    input: SetupConsumerRuntimeInput,
    repoRoot: string,
    fault?: ConsumerWorktreeSetupFault,
  ): Promise<SetupResult> => {
    ports.assertSetupRuntimeRoot(input.identity, repoRoot);
    const runtimeSnapshot = ports.captureRuntimeTree(input.identity.runtime_root);
    const launcherSnapshot = captureRuntimeLauncher(repoRoot);
    const launcherContent = renderConsumerNodeWrapper();
    try {
      const consumerRuntime = await ports.installConsumerRuntimeFromSetup(input);
      if (!consumerRuntime.result.ok) throw new Error(consumerRuntime.result.reason);
      fault?.("afterRuntimePublishBeforeLauncher");
      writeRuntimeLauncher(launcherSnapshot);
      return {
        phase: "0-A",
        written: [join(".ut-tdd", "bin", "ut-tdd.mjs")],
        branchProtection: { applied: false, reason: "runtime-only" },
        consumerRuntime,
      };
    } catch (error) {
      let launcherRestoreError: unknown;
      let runtimeRestoreError: unknown;
      try {
        restoreRuntimeLauncher(launcherSnapshot, launcherContent);
      } catch (restoreError) {
        launcherRestoreError = restoreError;
      }
      try {
        ports.restoreRuntimeTree(input.identity.runtime_root, runtimeSnapshot);
        if (
          !launcherSnapshot.utTddExisted &&
          lstatIfPresent(launcherSnapshot.utTddDirectory)?.isDirectory() &&
          readdirSync(launcherSnapshot.utTddDirectory).length === 0
        )
          rmdirSync(launcherSnapshot.utTddDirectory);
      } catch (restoreError) {
        runtimeRestoreError = restoreError;
      }
      if (launcherRestoreError !== undefined || runtimeRestoreError !== undefined) {
        throw new Error(
          `consumer_runtime_indeterminate:launcher=${String(launcherRestoreError)};runtime=${String(runtimeRestoreError)};primary=${String(error)}`,
        );
      }
      throw error;
    }
  };
  return { ensureLauncher, install };
}
