import { describe, expect, it } from "vitest";
import { latestReleaseTag, parseSemver } from "../src/setup/update-check.ts";

describe("B: parseSemver / latestReleaseTag (特性化)", () => {
  it("U-SEMVER-015: parseSemver は v 付きと無しを受け入れる", () => {
    expect(parseSemver("v0.1.4")).toEqual([0, 1, 4]);
    expect(parseSemver("0.1.4")).toEqual([0, 1, 4]);
    expect(parseSemver("  v1.2.3\n")).toEqual([1, 2, 3]);
  });

  it("U-SEMVER-016: prerelease と build を拒否する", () => {
    expect(parseSemver("v0.2.0-rc.1")).toBeNull();
    expect(parseSemver("1.2.3+b")).toBeNull();
    expect(parseSemver("v1.0.0-beta")).toBeNull();
  });

  it("U-SEMVER-017: 欠けた部と別の接頭辞を拒否する", () => {
    for (const s of ["v1.2", "release-candidate", "", "vv1.2.3", "=1.2.3", "V1.2.3", "v 1.2.3"]) {
      expect(parseSemver(s)).toBeNull();
    }
  });

  it("U-SEMVER-018: 先頭 0 と桁あふれを受け入れる", () => {
    expect(parseSemver("v01.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v99999999999999999999.0.0")).not.toBeNull();
  });

  it("U-SEMVER-019: latestReleaseTag は最大の tag を選ぶ", () => {
    expect(latestReleaseTag(["v0.1.9", "v0.1.10", "v0.1.2", "nightly", "v1.0.0-beta"])).toBe(
      "v0.1.10",
    );
    expect(latestReleaseTag([])).toBeNull();
    expect(latestReleaseTag(["nightly", "poc"])).toBeNull();
    expect(latestReleaseTag(["v1.0.0-beta", "v0.9.0"])).toBe("v0.9.0");
  });

  it("U-SEMVER-020: 同値は先を残し、trim し、先頭 0 を同値とみなす", () => {
    expect(latestReleaseTag(["v1.2.3", "1.2.3"])).toBe("v1.2.3");
    expect(latestReleaseTag(["1.2.3", "v1.2.3"])).toBe("1.2.3");
    expect(latestReleaseTag(["  v0.1.4  ", "v0.1.3"])).toBe("v0.1.4");
    expect(latestReleaseTag(["v01.2.3", "v1.2.4"])).toBe("v1.2.4");
    expect(latestReleaseTag(["v1.2.3", "v01.2.3"])).toBe("v1.2.3");
  });

  it("U-SEMVER-021: 入力の順序に依らない", () => {
    const tags = ["v0.1.2", "v0.1.10", "v0.2.0", "v1.0.0", "v0.9.9"];
    const permute = (xs: string[]): string[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]),
          );
    const all = permute(tags);
    expect(all.length).toBe(120);
    for (const p of all) expect(latestReleaseTag(p)).toBe("v1.0.0");
  });

  it("U-SEMVER-031: 範囲外の数は Number の丸め後の値で比べる (反例)", () => {
    expect(latestReleaseTag(["v9007199254740992.0.0", "v9007199254740994.0.0"])).toBe(
      "v9007199254740994.0.0",
    );
    expect(latestReleaseTag(["v9007199254740992.0.0", "v9007199254740993.0.0"])).toBe(
      "v9007199254740992.0.0",
    );
  });
});
