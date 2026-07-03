import { describe, expect, it } from "vitest";
import { checkToolchainPin } from "../src/doctor/index";
import { analyzeToolchainPin, toolchainPinMessages } from "../src/lint/toolchain-pin";

function packageJson(spec: string): string {
  return JSON.stringify({
    devDependencies: {
      "@biomejs/biome": spec,
    },
  });
}

function bunLock(spec: string): string {
  return [
    "{",
    '  "workspaces": {',
    '    "": {',
    '      "devDependencies": {',
    `        "@biomejs/biome": "${spec}",`,
    "      },",
    "    },",
    "  },",
    '  "packages": {}',
    "}",
  ].join("\n");
}

describe("toolchain pin lint", () => {
  it("rejects non-exact biome package and lock specs", () => {
    const result = analyzeToolchainPin({
      packageJson: packageJson("^2.4.15"),
      bunLock: bunLock("^2.4.15"),
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(["biome-package-spec-not-exact", "biome-lock-spec-not-exact"]),
    );
    expect(toolchainPinMessages(result)[0]).toContain("toolchain-pin - violation");
  });

  it("accepts exact package and lock specs", () => {
    const result = analyzeToolchainPin({
      packageJson: packageJson("2.4.15"),
      bunLock: bunLock("2.4.15"),
    });

    expect(result.ok).toBe(true);
    expect(toolchainPinMessages(result)[0]).toContain("toolchain-pin - OK");
  });

  it("rejects package and lock spec mismatches", () => {
    const result = analyzeToolchainPin({
      packageJson: packageJson("2.4.15"),
      bunLock: bunLock("2.4.16"),
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("biome-package-lock-mismatch");
  });

  it("wires the real repo toolchain pin check into doctor exports", () => {
    const result = checkToolchainPin(process.cwd());

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("toolchain-pin - OK");
  });
});
