import { type ChangeLane, classifyChangeLane } from "../shared/change-lane.ts";

export const WINDOWS_SHARD_IDS = ["1/3", "2/3", "3/3"] as const;
const LANE_LEGS = ["linux", "windows-1", "windows-2", "windows-3"] as const;

interface RunBinding {
  run_id: string;
  run_attempt: number;
  head_sha: string;
}

interface LaneEvidence extends RunBinding {
  leg: string;
  lane: ChangeLane;
}

interface ShardEvidence extends RunBinding {
  shard: string;
  file_count: number;
  result: "success" | "failure" | "cancelled" | "skipped";
}

export interface WindowsShardAggregateInput {
  expected: RunBinding;
  changedPaths: readonly string[] | null;
  laneEvidence: readonly unknown[];
  shardEvidence: readonly unknown[];
}

type WindowsShardAggregateRejection =
  | "malformed_evidence"
  | "attempt_binding_mismatch"
  | "lane_evidence_mismatch"
  | "windows_shard_set_mismatch"
  | "invalid_windows_shard_outcome";

export type WindowsShardAggregateResult =
  | { ok: true; lane: "full" | "doc" }
  | { ok: false; reason: WindowsShardAggregateRejection; affected: readonly string[] };

function reject(
  reason: WindowsShardAggregateRejection,
  affected: readonly string[] = [],
): WindowsShardAggregateResult {
  return { ok: false, reason, affected: [...new Set(affected)] };
}

function isEvidenceObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundEvidence(value: unknown): value is Record<string, unknown> & RunBinding {
  return (
    isEvidenceObject(value) &&
    typeof value.run_id === "string" &&
    value.run_id.length > 0 &&
    typeof value.run_attempt === "number" &&
    Number.isSafeInteger(value.run_attempt) &&
    value.run_attempt > 0 &&
    typeof value.head_sha === "string" &&
    /^[a-f0-9]{40}$/.test(value.head_sha)
  );
}

function isLaneEvidence(value: unknown): value is LaneEvidence {
  return (
    isBoundEvidence(value) &&
    typeof value.leg === "string" &&
    value.leg.length > 0 &&
    (value.lane === "full" || value.lane === "doc")
  );
}

function isShardEvidence(value: unknown): value is ShardEvidence {
  return (
    isBoundEvidence(value) &&
    typeof value.shard === "string" &&
    value.shard.length > 0 &&
    typeof value.file_count === "number" &&
    Number.isFinite(value.file_count) &&
    (value.result === "success" ||
      value.result === "failure" ||
      value.result === "cancelled" ||
      value.result === "skipped")
  );
}

function knownIdentities(values: readonly unknown[], key: "leg" | "shard"): string[] {
  return values.flatMap((value) => {
    if (!isEvidenceObject(value)) return [];
    const id = value[key];
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
}

function matchesBinding(expected: RunBinding, evidence: RunBinding): boolean {
  return (
    evidence.run_id === expected.run_id &&
    evidence.run_attempt === expected.run_attempt &&
    evidence.head_sha === expected.head_sha
  );
}

function setProblems(expected: readonly string[], observed: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of observed) counts.set(id, (counts.get(id) ?? 0) + 1);
  const invalid = expected.filter((id) => counts.get(id) !== 1);
  const unexpected = [...counts.keys()].filter((id) => !expected.includes(id));
  return [...invalid, ...unexpected];
}

export function admitWindowsShardAggregate({
  expected,
  changedPaths,
  laneEvidence,
  shardEvidence,
}: WindowsShardAggregateInput): WindowsShardAggregateResult {
  if (!isBoundEvidence(expected)) return reject("malformed_evidence");
  if (!laneEvidence.every(isLaneEvidence) || !shardEvidence.every(isShardEvidence)) {
    return reject("malformed_evidence", [
      ...knownIdentities(
        laneEvidence.filter((evidence) => !isLaneEvidence(evidence)),
        "leg",
      ),
      ...knownIdentities(
        shardEvidence.filter((evidence) => !isShardEvidence(evidence)),
        "shard",
      ),
    ]);
  }

  const unbound = [
    ...laneEvidence.filter((evidence) => !matchesBinding(expected, evidence)).map(({ leg }) => leg),
    ...shardEvidence
      .filter((evidence) => !matchesBinding(expected, evidence))
      .map(({ shard }) => shard),
  ];
  if (unbound.length > 0) return reject("attempt_binding_mismatch", unbound);

  const lane = classifyChangeLane(changedPaths ?? []).lane;
  const laneProblems = [
    ...setProblems(
      LANE_LEGS,
      laneEvidence.map(({ leg }) => leg),
    ),
    ...laneEvidence.filter((evidence) => evidence.lane !== lane).map(({ leg }) => leg),
  ];
  if (laneProblems.length > 0) return reject("lane_evidence_mismatch", laneProblems);

  const observedShards = shardEvidence.map(({ shard }) => shard);
  if (lane === "doc") {
    return observedShards.length === 0
      ? { ok: true, lane }
      : reject("lane_evidence_mismatch", observedShards);
  }

  const shardProblems = setProblems(WINDOWS_SHARD_IDS, observedShards);
  if (shardProblems.length > 0) return reject("windows_shard_set_mismatch", shardProblems);

  const invalidOutcomes = shardEvidence
    .filter(
      ({ result, file_count }) =>
        result !== "success" || !Number.isInteger(file_count) || file_count <= 0,
    )
    .map(({ shard }) => shard);
  return invalidOutcomes.length === 0
    ? { ok: true, lane }
    : reject("invalid_windows_shard_outcome", invalidOutcomes);
}
