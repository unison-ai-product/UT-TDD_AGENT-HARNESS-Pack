import { describe, expect, it } from "vitest";
import {
  analyzeToolchainPin,
  NODE_TOOLCHAIN_POLICY,
  type ToolchainPinDocs,
} from "../src/lint/toolchain-pin.ts";

const nodePin = NODE_TOOLCHAIN_POLICY.nodeVersion;
const npmPin = NODE_TOOLCHAIN_POLICY.npmVersion;
const npmIntegrity = NODE_TOOLCHAIN_POLICY.npmIntegrity;
const direct = {
  "@biomejs/biome": "2.4.15",
  esbuild: "0.28.2",
};

function fixture(
  overrides: {
    nodeFile?: string;
    nodeEngine?: string;
    npmEngine?: string;
    packageManager?: string;
  } = {},
): ToolchainPinDocs {
  const packageJson = JSON.stringify({
    packageManager: overrides.packageManager ?? `npm@${npmPin}+${npmIntegrity}`,
    engines: {
      node: overrides.nodeEngine ?? nodePin,
      npm: overrides.npmEngine ?? npmPin,
    },
    devDependencies: direct,
    utTdd: {
      nodeToolchain: {
        phase: NODE_TOOLCHAIN_POLICY.phase,
        nodeAuthority: NODE_TOOLCHAIN_POLICY.nodeAuthority,
        executableReceipt: NODE_TOOLCHAIN_POLICY.executableReceipt,
      },
    },
  });
  const packageLock = JSON.stringify({
    lockfileVersion: NODE_TOOLCHAIN_POLICY.lockfileVersion,
    packages: {
      "": { devDependencies: direct },
    },
  });

  return {
    packageJson,
    packageLock,
    bunLock: null,
    nodeVersion: overrides.nodeFile ?? nodePin,
  };
}

describe("toolchain pin engines range raw Red candidates", () => {
  it("U-TOOLPIN-001 rejects .node-version drift from the exact reviewed pin", () => {
    const result = analyzeToolchainPin(fixture({ nodeFile: "23.0.0" }));
    expect(result.violations.map((violation) => violation.rule)).toContain("node-version-mismatch");
  });

  it("U-TOOLPIN-002 accepts a valid Node range containing the reviewed pin", () => {
    const baseline = analyzeToolchainPin(fixture());
    expect(baseline.ok).toBe(true);

    const result = analyzeToolchainPin(fixture({ nodeEngine: `>=${nodePin} <25` }));
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "node-version-mismatch",
    );
    expect(result.ok).toBe(true);
  });

  it("U-TOOLPIN-003 rejects valid Node ranges that exclude the reviewed pin", () => {
    for (const nodeEngine of ["<24", ">=25 <26", `>${nodePin} <25`]) {
      const result = analyzeToolchainPin(fixture({ nodeEngine }));
      expect(result.violations.map((violation) => violation.rule)).toContain(
        "node-version-mismatch",
      );
    }
  });

  it("U-TOOLPIN-004 reports invalid Node ranges without throwing", () => {
    for (const nodeEngine of ["latest", "", "  ", "24.x.y.z"]) {
      const result = analyzeToolchainPin(fixture({ nodeEngine }));
      expect(result.violations.map((violation) => violation.rule)).toContain(
        "node-version-mismatch",
      );
    }
  });

  it("U-TOOLPIN-005 rejects packageManager version drift from the exact npm pin", () => {
    const result = analyzeToolchainPin(fixture({ packageManager: `npm@10.0.0+${npmIntegrity}` }));
    expect(result.violations.map((violation) => violation.rule)).toContain("npm-version-mismatch");
  });

  it("U-TOOLPIN-006 accepts a valid npm range containing the packageManager pin", () => {
    const baseline = analyzeToolchainPin(fixture());
    expect(baseline.ok).toBe(true);

    const result = analyzeToolchainPin(fixture({ npmEngine: `>=${npmPin} <12` }));
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "npm-version-mismatch",
    );
    expect(result.ok).toBe(true);
  });

  it("U-TOOLPIN-007 rejects npm ranges outside or invalid for the packageManager pin", () => {
    for (const npmEngine of [">=12 <13", `>${npmPin} <12`, "latest", "", "  "]) {
      const result = analyzeToolchainPin(fixture({ npmEngine }));
      expect(result.violations.map((violation) => violation.rule)).toContain(
        "npm-version-mismatch",
      );
    }
  });

  it("U-TOOLPIN-008 retains packageManager integrity-missing and wrong-digest findings", () => {
    const missing = analyzeToolchainPin(fixture({ packageManager: `npm@${npmPin}` }));
    expect(missing.violations.map((violation) => violation.rule)).toContain(
      "npm-package-manager-integrity-missing",
    );

    const wrongDigest = analyzeToolchainPin(
      fixture({ packageManager: `npm@${npmPin}+sha512-AAAA` }),
    );
    expect(wrongDigest.violations.map((violation) => violation.rule)).toContain(
      "npm-package-manager-integrity-mismatch",
    );
  });
});
