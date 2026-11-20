import { describe, expect, it } from "vitest";
import {
  admitWindowsShardPartition,
  expectedWindowsShardFiles,
  readWindowsShardSnapshot,
} from "../src/github/windows-ci-shard-partition.ts";

const alpha = "tests/alpha.test.ts";
const beta = "tests/beta.test.ts";
const gamma = "tests/gamma.test.ts";
const skipped = "tests/skipped-file.test.ts";
const expectedFiles = [alpha, beta, gamma, skipped];
const selections = [
  { shard: "1/3", files: [alpha] },
  { shard: "2/3", files: [beta] },
  { shard: "3/3", files: [gamma, skipped] },
];

describe("CANDIDATE-U-CISHARD-009: partition of selected Windows test files", () => {
  it("accepts the exact disjoint selection including a fully skipped file", () => {
    expect(admitWindowsShardPartition(expectedFiles, selections)).toEqual({
      ok: true,
      missing: [],
      unexpected: [],
      duplicates: [],
      invalidShards: [],
    });
  });

  it("reports an extra test when a Windows exclusion is lost", () => {
    const excluded = "tests/doctor.test.ts";
    const observed = [
      { shard: "1/3", files: [alpha, excluded] },
      { shard: "2/3", files: [beta] },
      { shard: "3/3", files: [gamma, skipped] },
    ];

    expect(admitWindowsShardPartition(expectedFiles, observed)).toMatchObject({
      ok: false,
      unexpected: [excluded],
    });
  });

  it("reports every duplicate when shard arguments are lost", () => {
    const unsharded = selections.map(({ shard }) => ({ shard, files: expectedFiles }));
    const result = admitWindowsShardPartition(expectedFiles, unsharded);

    expect(result.ok).toBe(false);
    expect([...result.duplicates].sort()).toEqual([...expectedFiles].sort());
  });

  it("reports a missing test even when every shard selected a file", () => {
    const observed = [
      { shard: "1/3", files: [alpha] },
      { shard: "2/3", files: [beta] },
      { shard: "3/3", files: [gamma] },
    ];

    expect(admitWindowsShardPartition(expectedFiles, observed)).toMatchObject({
      ok: false,
      missing: [skipped],
    });
  });

  it("rejects an invalid shard label even when the file partition is exact", () => {
    const observed = [
      { shard: "1/3", files: [alpha] },
      { shard: "2/3", files: [beta] },
      { shard: "4/3", files: [gamma, skipped] },
    ];
    const result = admitWindowsShardPartition(expectedFiles, observed);

    expect(result.ok).toBe(false);
    expect(result.invalidShards).toContain("4/3");
  });

  it("rejects a repeated shard label even when the file partition is exact", () => {
    const observed = [...selections.slice(0, 2), { ...selections[2], shard: "2/3" }];
    expect(admitWindowsShardPartition(expectedFiles, observed)).toMatchObject({
      ok: false,
      invalidShards: ["2/3", "3/3"],
    });
  });
});

describe("Windows CI partition evidence inputs", () => {
  const source = "a".repeat(40);
  const log = [
    "2026-11-19T09:00:00.111Z  ↓ tests/earlier.test.ts (1 test | 1 skipped)",
    `2026-11-19T09:00:01.123Z snapshot source: git commit ${source}`,
    "2026-11-19T09:00:02.456Z  \x1b[32m✓\x1b[0m tests\\alpha.test.ts (1 test) 10ms",
    "2026-11-19T09:00:03.789Z  ↓ tests/skipped-file.test.ts (2 tests | 2 skipped)",
    "2026-11-19T09:00:04.111Z  Test Files  1 passed | 1 skipped (2)",
    "2026-11-19T09:00:05.222Z  Test Files  1 passed (1)",
  ].join("\n");
  const bounds = {
    startedAt: Date.parse("2026-11-19T09:00:01Z"),
    completedAt: Date.parse("2026-11-19T09:00:04Z"),
  };

  it("reads the bound step and preserves fully skipped files", () => {
    expect(readWindowsShardSnapshot(log, bounds)).toEqual({ source, files: [alpha, skipped] });
  });

  it("rejects a missing snapshot, a truncated file list and an ambiguous summary", () => {
    expect(() => readWindowsShardSnapshot(log.replace(source, "missing"), bounds)).toThrow(
      "snapshot source",
    );
    expect(() =>
      readWindowsShardSnapshot(log.replace("↓ tests/skipped-file.test.ts", "hidden"), bounds),
    ).toThrow("Test Files total");
    expect(() =>
      readWindowsShardSnapshot(log.replace("09:00:05.222", "09:00:04.222"), bounds),
    ).toThrow("ambiguous");
  });

  it("derives expectations from tracked tests, fast exclusions and explicit CLI files", () => {
    const runner = "node scripts/run-vitest-snapshot.ts";
    expect(
      expectedWindowsShardFiles(
        [gamma, beta, alpha, "tests/helper.ts"],
        `${runner} --exclude ${gamma} --exclude ${beta}`,
        `${runner} ${beta}`,
      ),
    ).toEqual([alpha, beta]);
    expect(() =>
      expectedWindowsShardFiles([alpha], `${runner} --unknown ${alpha}`, runner),
    ).toThrow("test:fast");
  });
});
