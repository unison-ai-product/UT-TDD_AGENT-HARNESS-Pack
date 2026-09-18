import { describe, expect, it } from "vitest";
import { checkToolchainPin } from "../src/doctor/index.ts";
import { analyzeToolchainPin, toolchainPinMessages } from "../src/lint/toolchain-pin.ts";

const direct = {
  "@biomejs/biome": "2.4.15",
  esbuild: "0.21.5",
};

function fixture(
  overrides: {
    nodeFile?: string;
    nodeEngine?: string;
    npmEngine?: string;
    packageManager?: string;
    lockVersion?: number;
    lockEsbuild?: string;
    authority?: Record<string, string>;
  } = {},
) {
  const packageJson = JSON.stringify({
    packageManager:
      overrides.packageManager ??
      "npm@11.6.2+sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==",
    engines: { node: overrides.nodeEngine ?? "24.13.0", npm: overrides.npmEngine ?? "11.6.2" },
    devDependencies: direct,
    utTdd: {
      nodeToolchain:
        overrides.authority ??
        ({
          phase: "node_production",
          nodeAuthority: "sealed",
          executableReceipt: "required",
        } as const),
    },
  });
  const packageLock = JSON.stringify({
    lockfileVersion: overrides.lockVersion ?? 3,
    packages: {
      "": {
        devDependencies: { ...direct, esbuild: overrides.lockEsbuild ?? direct.esbuild },
      },
    },
  });
  return {
    packageJson,
    packageLock,
    bunLock: null,
    nodeVersion: overrides.nodeFile ?? "24.13.0",
  };
}

describe("toolchain pin lint", () => {
  it("accepts the sealed F0a policy and three matching direct graphs", () => {
    const result = analyzeToolchainPin(fixture());
    expect(result.ok).toBe(true);
    expect(toolchainPinMessages(result)[0]).toContain("phase=node_production");
  });

  it("rejects .node-version or engines.node one-sided drift", () => {
    for (const docs of [fixture({ nodeFile: "24.13.1" }), fixture({ nodeEngine: "24.13.1" })])
      expect(analyzeToolchainPin(docs).violations.map((v) => v.rule)).toContain(
        "node-version-mismatch",
      );
  });

  it("rejects packageManager or engines.npm one-sided drift", () => {
    for (const docs of [
      fixture({ packageManager: "npm@11.6.3+sha512-AAAA" }),
      fixture({ npmEngine: "11.6.3" }),
    ])
      expect(analyzeToolchainPin(docs).violations.map((v) => v.rule)).toContain(
        "npm-version-mismatch",
      );
  });

  it("rejects missing package-manager integrity custody", () => {
    expect(
      analyzeToolchainPin(fixture({ packageManager: "npm@11.6.2" })).violations.map((v) => v.rule),
    ).toContain("npm-package-manager-integrity-missing");
  });

  it("rejects same-version packageManager with a non-reviewed integrity digest", () => {
    expect(
      analyzeToolchainPin(fixture({ packageManager: "npm@11.6.2+sha512-AAAA" })).violations.map(
        (v) => v.rule,
      ),
    ).toContain("npm-package-manager-integrity-mismatch");
  });

  it("rejects npm lock version and root graph mutation", () => {
    expect(
      analyzeToolchainPin(fixture({ lockVersion: 2, lockEsbuild: "0.21.4" })).violations.map(
        (v) => v.rule,
      ),
    ).toEqual(expect.arrayContaining(["npm-lock-version-mismatch", "npm-lock-root-drift"]));
  });

  it("rejects npm direct graph mutation", () => {
    expect(
      analyzeToolchainPin(fixture({ lockEsbuild: "0.21.4" })).violations.map((v) => v.rule),
    ).toContain("esbuild-version-mismatch");
  });

  it("rejects reintroduction of the retired Bun lockfile", () => {
    const result = analyzeToolchainPin({
      ...fixture(),
      bunLock: JSON.stringify({ workspaces: { "": { devDependencies: direct } } }),
    });
    expect(result.violations.map((v) => v.rule)).toContain("bun-lock-present");
  });

  it("rejects runtime authority ambiguity", () => {
    expect(
      analyzeToolchainPin(
        fixture({
          authority: {
            phase: "node_candidate",
            nodeAuthority: "candidate",
            executableReceipt: "deferred_to_f0b",
          },
        }),
      ).violations.map((v) => v.rule),
    ).toContain("runtime-authority-ambiguous");
  });

  it("wires the real repo policy into doctor", () => {
    const result = checkToolchainPin(process.cwd());
    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("phase=node_production");
  });
});
