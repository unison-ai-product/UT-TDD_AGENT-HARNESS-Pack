import { stripVTControlCharacters } from "node:util";
import { WINDOWS_SHARD_IDS } from "../lint/windows-ci-shard-admission.ts";

export interface WindowsShardSelection {
  shard: string;
  files: readonly string[];
}

export interface WindowsShardPartitionResult {
  ok: boolean;
  missing: readonly string[];
  unexpected: readonly string[];
  duplicates: readonly string[];
  invalidShards: readonly string[];
}

const TEST_PATH = /^tests\/.+\.test\.ts$/;
const SNAPSHOT_COMMAND = "node scripts/run-vitest-snapshot.ts";

function repositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function admitWindowsShardPartition(
  expectedFiles: readonly string[],
  selections: readonly WindowsShardSelection[],
): WindowsShardPartitionResult {
  const expected = new Set(expectedFiles.map(repositoryPath));
  const validShards = new Set<string>(WINDOWS_SHARD_IDS);
  const seenShards = new Set<string>();
  const invalid = new Set<string>();
  const observed = new Set<string>();
  const repeated = new Set<string>();
  for (const { shard, files } of selections) {
    if (!validShards.has(shard) || seenShards.has(shard)) invalid.add(shard);
    seenShards.add(shard);
    for (const file of files) {
      const path = repositoryPath(file);
      if (observed.has(path)) repeated.add(path);
      observed.add(path);
    }
  }
  for (const shard of validShards) {
    if (!seenShards.has(shard)) invalid.add(shard);
  }
  const missing = [...expected].filter((path) => !observed.has(path)).sort();
  const unexpected = [...observed].filter((path) => !expected.has(path)).sort();
  const duplicates = [...repeated].sort();
  const invalidShards = [...invalid].sort();
  return {
    ok: missing.length + unexpected.length + duplicates.length + invalidShards.length === 0,
    missing,
    unexpected,
    duplicates,
    invalidShards,
  };
}

function snapshotArguments(command: string): string[] {
  if (command === SNAPSHOT_COMMAND) return [];
  if (!command.startsWith(`${SNAPSHOT_COMMAND} `)) throw new Error("unknown snapshot command");
  return command.slice(SNAPSHOT_COMMAND.length).trim().split(/\s+/);
}

export function expectedWindowsShardFiles(
  tracked: readonly string[],
  fastCommand: string,
  cliCommand: string,
): string[] {
  const fast = snapshotArguments(fastCommand);
  const exclusions = new Set<string>();
  for (let index = 0; index < fast.length; index += 2) {
    const path = fast[index + 1];
    if (fast[index] !== "--exclude" || path === undefined || !TEST_PATH.test(path)) {
      throw new Error("unknown test:fast exclusion");
    }
    exclusions.add(path);
  }
  const cli = new Set(snapshotArguments(cliCommand));
  if ([...cli].some((path) => !TEST_PATH.test(path))) throw new Error("unknown test:cli file");
  const expected = tracked.filter((path) => TEST_PATH.test(path));
  return expected.filter((path) => !exclusions.has(path) || cli.has(path)).sort();
}

interface WindowsRegressionWindow {
  startedAt: number;
  completedAt: number;
}

function regressionStepLines(
  log: string,
  { startedAt, completedAt }: WindowsRegressionWindow,
): string[] {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt <= startedAt) {
    throw new Error("invalid Windows regression step timestamps");
  }
  return stripVTControlCharacters(log)
    .split(/\r?\n/)
    .flatMap((line) => {
      const separator = line.indexOf(" ");
      const timestamp = Date.parse(line.slice(0, separator));
      return timestamp >= startedAt && timestamp < completedAt + 1000
        ? [line.slice(separator + 1)]
        : [];
    });
}

const SNAPSHOT_SOURCE = /^snapshot source: git commit ([a-f0-9]{40})$/;

export function readWindowsRegressionSnapshotSource(
  log: string,
  bounds: WindowsRegressionWindow,
): string {
  const sources = regressionStepLines(log, bounds).flatMap((line) => {
    const match = SNAPSHOT_SOURCE.exec(line);
    return match ? [match[1]] : [];
  });
  if (sources.length !== 1) throw new Error("missing or ambiguous regression snapshot source");
  return sources[0];
}

export function readWindowsShardSnapshot(
  log: string,
  bounds: WindowsRegressionWindow,
): { source: string; files: string[] } {
  const stepLines = regressionStepLines(log, bounds);
  const sourceIndices = stepLines.flatMap((line, index) =>
    SNAPSHOT_SOURCE.test(line) ? [index] : [],
  );
  const summaryIndices = stepLines.flatMap((line, index) =>
    /^\s*Test Files\s/.test(line) ? [index] : [],
  );
  const [sourceIndex] = sourceIndices;
  const [summaryIndex] = summaryIndices;
  if (sourceIndices.length !== 1 || summaryIndices.length !== 1 || summaryIndex <= sourceIndex) {
    throw new Error("missing or ambiguous snapshot source and Test Files summary");
  }
  const files = stepLines.slice(sourceIndex + 1, summaryIndex).flatMap((line) => {
    const match = /^\s*[\u2713\u2193]\s+(tests[\\/].+?\.test\.ts)(?=\s*\(|\s*$)/.exec(line);
    return match ? [repositoryPath(match[1])] : [];
  });
  const summaryTotal = Number(/\((\d+)\)\s*$/.exec(stepLines[summaryIndex])?.[1]);
  if (files.length === 0 || files.length !== summaryTotal) {
    throw new Error("Windows reporter rows do not match the Test Files total");
  }
  return { source: stepLines[sourceIndex].slice("snapshot source: git commit ".length), files };
}
