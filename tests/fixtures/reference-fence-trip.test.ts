import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unsealReference } from "../../scripts/run-vitest-snapshot.ts";

describe.skipIf(process.env.UT_TDD_FENCE_TRIP !== "1")("reference fence trip fixture", () => {
  it("mutates the supplied HEAD snapshot after global setup captures it", () => {
    const referenceRoot = process.env.UT_TDD_HEAD_SNAPSHOT_ROOT;
    if (!referenceRoot) throw new Error("reference fence trip requires UT_TDD_HEAD_SNAPSHOT_ROOT");
    if (process.platform === "win32") {
      expect(() => writeFileSync(join(referenceRoot, "sealed-probe.txt"), "probe\n")).toThrow();
    } else {
      expect(statSync(referenceRoot).mode & 0o222).toBe(0);
    }
    unsealReference(referenceRoot);
    appendFileSync(join(referenceRoot, "trip.txt"), "trip\n");
  });
});
