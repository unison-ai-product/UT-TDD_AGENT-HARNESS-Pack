import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveNodeBinary } from "../scripts/run-vitest-snapshot.ts";

describe("global setup fence", () => {
  it("U-TESTHYGIENE-043: turns a sealed detached-reference teardown violation into a nonzero runner process", () => {
    // PLAN-L7-462 step 2: runner 実発火 oracle は node 直 spawn (bun/.cmd shell 経由なし)。
    const result = spawnSync(
      resolveNodeBinary(),
      ["scripts/run-vitest-snapshot.ts", "tests/fixtures/reference-fence-trip.test.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, UT_TDD_FENCE_TRIP: "1" },
      },
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("test workspace fence violation");
  });
});
