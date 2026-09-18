import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  version: string;
  packages?: { "": { version: string } };
};

describe("canary release version identity", () => {
  it("U-RELVER-001: package and both independent lockfile identities are exact", () => {
    expect(packageJson.version).toBe("0.2.0-canary.1");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.[""].version).toBe(packageJson.version);
    const cli = spawnSync(process.execPath, ["src/cli.ts", "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim()).toBe(packageJson.version);
  });
});
