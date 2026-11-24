import "../src/runtime/windows-hide.ts";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  classifyChangeLane,
  resolveChangeDiffRange,
  SystemGitDiffNamesPort,
} from "../src/github/change-lane.ts";
import {
  admitWindowsShardAggregate,
  WINDOWS_SHARD_IDS,
} from "../src/lint/windows-ci-shard-admission.ts";
import { readWindowsCiBinding, WindowsCiEvidenceError } from "./windows-ci-shard-evidence.mjs";

const REQUIRED_LEGS = ["linux", ...WINDOWS_SHARD_IDS.map((shard) => "windows-" + shard[0])];
const LANE_DIRECTORY = /^harness-lane-([a-z0-9-]+)-attempt-([1-9][0-9]*)$/;
const SHARD_DIRECTORY = /^windows-shard-([1-9][0-9]*)-attempt-([1-9][0-9]*)$/;

function changedPaths(expected, env) {
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const { range } = resolveChangeDiffRange({
      eventName: env.GITHUB_EVENT_NAME ?? "",
      headSha: expected.head_sha,
      baseSha: event?.pull_request?.base?.sha,
      beforeSha: event?.before,
    });
    return range ? new SystemGitDiffNamesPort(process.cwd()).diffNames(range) : null;
  } catch {
    return null;
  }
}

function artifactDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).map((entry) => {
      const lane = LANE_DIRECTORY.exec(entry.name);
      const shard = SHARD_DIRECTORY.exec(entry.name);
      if (!entry.isDirectory() || (!lane && !shard)) {
        throw new WindowsCiEvidenceError("malformed_evidence");
      }
      const [kind, identity, attempt] = lane
        ? ["lane", lane[1], Number(lane[2])]
        : ["shard", shard[1] + "/3", Number(shard[2])];
      if (!Number.isSafeInteger(attempt)) {
        throw new WindowsCiEvidenceError("malformed_evidence", [identity]);
      }
      return { kind, identity, attempt, path: join(root, entry.name) };
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function readArtifact(directory) {
  const filename = directory.kind + "-evidence.json";
  const identity = directory.identity;
  try {
    const files = readdirSync(directory.path, { withFileTypes: true });
    if (files.length !== 1 || files[0].name !== filename || !files[0].isFile()) {
      throw new WindowsCiEvidenceError("malformed_evidence", [identity]);
    }
    const value = JSON.parse(readFileSync(join(directory.path, filename), "utf8"));
    const key = directory.kind === "lane" ? "leg" : "shard";
    if (!value || value[key] !== identity) {
      throw new WindowsCiEvidenceError("malformed_evidence", [identity]);
    }
    return value;
  } catch (error) {
    if (error instanceof WindowsCiEvidenceError) throw error;
    throw new WindowsCiEvidenceError("malformed_evidence", [identity]);
  }
}

function collectWindowsCiEvidence(root, attempt, lane) {
  const directories = artifactDirectories(root);
  const current = directories.filter((directory) => directory.attempt === attempt);
  const required = [
    ...REQUIRED_LEGS.map((identity) => ({ kind: "lane", identity })),
    ...(lane === "full" ? WINDOWS_SHARD_IDS.map((identity) => ({ kind: "shard", identity })) : []),
  ];
  const stale = required
    .filter(({ kind, identity }) => {
      const matches = (directory) => directory.kind === kind && directory.identity === identity;
      return (
        !current.some(matches) &&
        directories.some((directory) => directory.attempt < attempt && matches(directory))
      );
    })
    .map(({ identity }) => identity);
  if (stale.length > 0) throw new WindowsCiEvidenceError("attempt_binding_mismatch", stale);
  return {
    laneEvidence: current.filter(({ kind }) => kind === "lane").map(readArtifact),
    shardEvidence: current.filter(({ kind }) => kind === "shard").map(readArtifact),
  };
}

function run(args, env) {
  try {
    if (args.length !== 2 || args[0] !== "--evidence-dir" || !isAbsolute(args[1])) {
      throw new WindowsCiEvidenceError("malformed_evidence");
    }
    const expected = readWindowsCiBinding(env);
    const paths = changedPaths(expected, env);
    const lane = classifyChangeLane(paths ?? []).lane;
    const evidence = collectWindowsCiEvidence(args[1], expected.run_attempt, lane);
    return admitWindowsShardAggregate({ expected, changedPaths: paths, ...evidence });
  } catch (error) {
    return error instanceof WindowsCiEvidenceError
      ? { ok: false, reason: error.reason, affected: error.affected }
      : { ok: false, reason: "malformed_evidence", affected: [] };
  }
}

if (import.meta.main) {
  const result = run(process.argv.slice(2), process.env);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
