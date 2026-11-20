import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkClaudeVersionFloor } from "../src/doctor/claude-version-floor-check.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const describeWindows = describe.skipIf(process.platform !== "win32");

let fixtureBin: string;
let originalPath: string | undefined;

describeWindows("U-CCVER-004 Windows PATH Claude probe", () => {
  beforeEach(() => {
    originalPath = process.env.PATH;
    fixtureBin = mkdtempSync(join(tmpdir(), "UT-TDD Claude version probe "));
    writeFileSync(
      join(fixtureBin, "claude.cmd"),
      '@echo off\r\nif not "%~1"=="--version" exit /b 17\r\nif not "%~2"=="" exit /b 18\r\necho 2.1.293\r\nexit /b 0\r\n',
      "utf8",
    );
    process.env.PATH = fixtureBin;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    removeTestTree(fixtureBin);
  });

  it("keeps the default PATH version check advisory and warns below the floor", () => {
    const result = checkClaudeVersionFloor();

    expect(result.ok).toBe(true);
    expect(result.messages.join("\n")).toContain("WARN");
    expect(result.messages.join("\n")).toContain("2.1.293");
    expect(result.messages.join("\n")).toContain("PATH の claude の版");
  });
});
