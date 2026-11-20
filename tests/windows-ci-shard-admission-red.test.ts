import { describe, expect, it } from "vitest";
import {
  admitWindowsShardAggregate,
  type WindowsShardAggregateInput,
} from "../src/lint/windows-ci-shard-admission.ts";

const expected = {
  run_id: "42",
  run_attempt: 2,
  head_sha: "a".repeat(40),
};

const legs = ["linux", "windows-1", "windows-2", "windows-3"];
const shards = ["1/3", "2/3", "3/3"];

function fullInput(): WindowsShardAggregateInput {
  return {
    expected,
    changedPaths: ["src/cli.ts"],
    laneEvidence: legs.map((leg) => ({ ...expected, leg, lane: "full" })),
    shardEvidence: shards.map((shard) => ({
      ...expected,
      shard,
      file_count: 10,
      result: "success",
    })),
  };
}

function docInput(): WindowsShardAggregateInput {
  return {
    expected,
    changedPaths: ["docs/reference/windows-ci.md"],
    laneEvidence: legs.map((leg) => ({ ...expected, leg, lane: "doc" })),
    shardEvidence: [],
  };
}

describe("Windows shard aggregate admission", () => {
  it("admits three successful full-lane shards and uses full when paths are unknown", () => {
    const full = fullInput();

    expect([full, { ...full, changedPaths: null }].map(admitWindowsShardAggregate)).toEqual([
      { ok: true, lane: "full" },
      { ok: true, lane: "full" },
    ]);
  });

  it("U-CISHARD-006: rejects missing, duplicate, and surplus shards", () => {
    const input = fullInput();
    const extra = { ...expected, shard: "4/3", file_count: 10, result: "success" };
    const cases = [
      input.shardEvidence.slice(0, 2),
      [...input.shardEvidence, input.shardEvidence[1]],
      [...input.shardEvidence, extra],
    ];

    expect(
      cases.map((shardEvidence) => admitWindowsShardAggregate({ ...input, shardEvidence })),
    ).toMatchObject(cases.map(() => ({ ok: false, reason: "windows_shard_set_mismatch" })));
  });

  it("U-CISHARD-007: binds shard evidence to run, attempt, and HEAD", () => {
    const input = fullInput();
    const otherBindings = [{ run_id: "43" }, { run_attempt: 1 }, { head_sha: "b".repeat(40) }];
    const [, ...remainingShards] = input.shardEvidence;
    const actual = otherBindings.map((otherBinding) =>
      admitWindowsShardAggregate({
        ...input,
        shardEvidence: [
          { ...expected, shard: "1/3", file_count: 10, result: "success", ...otherBinding },
          ...remainingShards,
        ],
      }),
    );

    expect(actual).toMatchObject(
      otherBindings.map(() => ({ ok: false, reason: "attempt_binding_mismatch" })),
    );
  });

  it("U-CISHARD-008: requires a positive integer file count for each shard", () => {
    const input = fullInput();
    const cases = [
      [10, 0, 10],
      [0, 0, 0],
      [10, -1, 10],
      [10, 1.5, 10],
    ];
    const actual = cases.map((counts) =>
      admitWindowsShardAggregate({
        ...input,
        shardEvidence: shards.map((shard, index) => ({
          ...expected,
          shard,
          file_count: counts[index],
          result: "success",
        })),
      }),
    );

    expect(actual).toMatchObject(
      cases.map(() => ({ ok: false, reason: "invalid_windows_shard_outcome" })),
    );
  });

  it("U-CISHARD-013: admits doc lane with bound lane evidence and no shards", () => {
    expect(admitWindowsShardAggregate(docInput())).toEqual({ ok: true, lane: "doc" });
  });

  it("U-CISHARD-014: rejects lane, shard, and run binding contradictions", () => {
    const doc = docInput();
    const full = fullInput();
    const [, ...remainingLegs] = doc.laneEvidence;

    expect([
      admitWindowsShardAggregate({ ...doc, changedPaths: full.changedPaths }),
      admitWindowsShardAggregate({ ...doc, shardEvidence: full.shardEvidence }),
      admitWindowsShardAggregate({
        ...doc,
        laneEvidence: [
          { ...expected, run_attempt: 1, leg: "linux", lane: "doc" },
          ...remainingLegs,
        ],
      }),
    ]).toMatchObject([
      { ok: false, reason: "lane_evidence_mismatch" },
      { ok: false, reason: "lane_evidence_mismatch" },
      { ok: false, reason: "attempt_binding_mismatch" },
    ]);
  });
});
