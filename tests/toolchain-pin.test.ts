import { describe, expect, it } from "vitest";
import { checkToolchainPin } from "../src/doctor/index.ts";
import { analyzeToolchainPin, toolchainPinMessages } from "../src/lint/toolchain-pin.ts";

const direct = {
  "@biomejs/biome": "2.4.15",
  esbuild: "0.28.2",
};

const reviewedNodeVersion = "24.22.3";
const reviewedNpmVersion = "11.19.1";
const reviewedNpmIntegrity =
  "sha512-ztsxKxt/kkIaAs+2i0GU6I+DRmUdrNasxTZKJe9TCdSjKxlhah/4r/hl5ygMD6XAg1qZ9c2TNomR4qgOydp10g==";

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
    packageManager: overrides.packageManager ?? `npm@${reviewedNpmVersion}+${reviewedNpmIntegrity}`,
    engines: {
      node: overrides.nodeEngine ?? ">=24.22.3 <25",
      npm: overrides.npmEngine ?? ">=11.19.1 <12",
    },
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
    nodeVersion: overrides.nodeFile ?? reviewedNodeVersion,
  };
}

describe("toolchain pin lint", () => {
  it("accepts reviewed pins included by valid engine ranges and matching direct graphs", () => {
    const result = analyzeToolchainPin(fixture());
    expect(result.ok).toBe(true);
    expect(toolchainPinMessages(result)[0]).toContain("phase=node_production");
  });

  it("rejects .node-version drift from the reviewed Node pin", () => {
    expect(
      analyzeToolchainPin(fixture({ nodeFile: "24.22.2" })).violations.map((v) => v.rule),
    ).toContain("node-version-mismatch");
  });

  it("accepts wider valid Node and npm engine ranges when they include the reviewed pins", () => {
    const rules = analyzeToolchainPin(
      fixture({ nodeEngine: ">=24.22.0 <25", npmEngine: ">=11.19.0 <12" }),
    ).violations.map((v) => v.rule);
    expect(rules).not.toContain("node-version-mismatch");
    expect(rules).not.toContain("npm-version-mismatch");
  });

  it("rejects valid engine ranges that exclude the reviewed Node or npm pin", () => {
    for (const { docs, rule } of [
      {
        docs: fixture({ nodeEngine: ">=24.23.0 <25" }),
        rule: "node-version-mismatch",
      },
      { docs: fixture({ nodeEngine: "<24" }), rule: "node-version-mismatch" },
      {
        docs: fixture({ npmEngine: ">=11.20.0 <12" }),
        rule: "npm-version-mismatch",
      },
    ]) {
      const rules = analyzeToolchainPin(docs).violations.map((v) => v.rule);
      expect(rules).toContain(rule);
    }
  });

  it("rejects invalid engine ranges without throwing", () => {
    for (const { docs, rule } of [
      {
        docs: fixture({ nodeEngine: "latest" }),
        rule: "node-version-mismatch",
      },
      {
        docs: fixture({ nodeEngine: "24.x.y.z" }),
        rule: "node-version-mismatch",
      },
      { docs: fixture({ nodeEngine: "" }), rule: "node-version-mismatch" },
      { docs: fixture({ nodeEngine: "   " }), rule: "node-version-mismatch" },
      { docs: fixture({ npmEngine: "latest" }), rule: "npm-version-mismatch" },
      { docs: fixture({ npmEngine: "" }), rule: "npm-version-mismatch" },
      { docs: fixture({ npmEngine: "   " }), rule: "npm-version-mismatch" },
    ]) {
      const rules = analyzeToolchainPin(docs).violations.map((v) => v.rule);
      expect(rules).toContain(rule);
    }
  });

  it("rejects packageManager drift from the reviewed npm pin", () => {
    expect(
      analyzeToolchainPin(fixture({ packageManager: "npm@11.19.2+sha512-AAAA" })).violations.map(
        (v) => v.rule,
      ),
    ).toEqual(expect.arrayContaining(["npm-version-mismatch", "npm-package-manager-not-exact"]));
  });

  it("rejects missing package-manager integrity custody", () => {
    expect(
      analyzeToolchainPin(fixture({ packageManager: `npm@${reviewedNpmVersion}` })).violations.map(
        (v) => v.rule,
      ),
    ).toContain("npm-package-manager-integrity-missing");
  });

  it("rejects same-version packageManager with a non-reviewed integrity digest", () => {
    expect(
      analyzeToolchainPin(
        fixture({ packageManager: `npm@${reviewedNpmVersion}+sha512-AAAA` }),
      ).violations.map((v) => v.rule),
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
