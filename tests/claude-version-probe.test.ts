import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type PathClaudeProbe, probePathClaude } from "../src/doctor/claude-path-probe.ts";
import {
  IS_WINDOWS,
  joinPath,
  makeFixtureDir,
  makeProbeEnv,
  readInvocations,
  samePath,
  writeFakeClaude,
} from "./support/claude-probe-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const FIXTURES: string[] = [];
function fixtureDir(prefix?: string): string {
  const dir = makeFixtureDir(prefix);
  FIXTURES.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of FIXTURES.splice(0)) removeTestTree(dir);
});

function probe(pathValue: string, extra: Record<string, string | undefined> = {}): PathClaudeProbe {
  return probePathClaude(makeProbeEnv(pathValue, extra), process.platform);
}

describe("Claude Code version probe (Issue #1674 / #1675)", () => {
  it("CANDIDATE-U-CCVER-009 does not run decoys from cwd, empty, dot or relative PATH entries, nor a path with a percent sign", () => {
    const root = fixtureDir();
    const decoy = join(root, "decoy");
    const fake = join(root, "fake");
    mkdirSync(join(decoy, "rel"), { recursive: true });
    writeFakeClaude(decoy, { version: "0.0.1" });
    writeFakeClaude(join(decoy, "rel"), { version: "0.0.2" });
    if (IS_WINDOWS) {
      // decoy の helper は実行されたら印を書く。fake の dir の helper は印を書かない。
      writeFileSync(
        join(decoy, "claude-helper.cmd"),
        '@echo off\r\n>>"%~dp0invocations.log" echo helper\r\n',
      );
      mkdirSync(fake, { recursive: true });
      writeFileSync(join(fake, "claude-helper.cmd"), "@echo off\r\n");
    }
    writeFakeClaude(fake, {
      version: "2.1.318",
      callHelper: IS_WINDOWS ? "claude-helper.cmd" : undefined,
    });
    const env = makeProbeEnv(joinPath("", ".", "rel", fake));
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src", "doctor", "claude-path-probe.ts"),
    ).href;
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(m.probePathClaude()));`,
      ],
      { cwd: decoy, env, encoding: "utf8", timeout: 60_000 },
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim().split(/\r?\n/).pop() ?? "null")).toEqual({
      kind: "found",
      version: "2.1.318",
    });
    expect(readInvocations(decoy)).toEqual([]);
    expect(readInvocations(join(decoy, "rel"))).toEqual([]);
    if (IS_WINDOWS) {
      // (b) 名前に %VAR% を含む dir の候補は実行しない。
      const pct = fixtureDir("utccver%UT_TDD_UNDEFINED_1674%");
      writeFakeClaude(pct, { version: "2.1.318" });
      expect(probe(pct, { UT_TDD_UNDEFINED_1674: undefined })).toEqual({
        kind: "found",
        version: null,
      });
      expect(readInvocations(pct)).toEqual([]);
    }
  }, 60_000);

  it.skipIf(!IS_WINDOWS)(
    "CANDIDATE-U-CCVER-010 runs a cmd shim under a dir with spaces and symbols through an absolute ComSpec",
    () => {
      const dir = fixtureDir(`UT-TDD probe & (x) !-${Math.random().toString(36).slice(2, 8)}`);
      writeFakeClaude(dir, { version: "2.1.318" });
      expect(
        probe(dir, {
          ComSpec: "cmd.exe",
          SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
        }),
      ).toEqual({ kind: "found", version: "2.1.318" });
      expect(readInvocations(dir)).toHaveLength(1);
    },
  );

  it("CANDIDATE-U-CCVER-011 runs only the first candidate even when it fails", () => {
    const root = fixtureDir();
    const a = join(root, "a");
    const b = join(root, "b");
    writeFakeClaude(a, { version: "2.1.299", exitCode: 1 });
    writeFakeClaude(b, { version: "2.1.318" });
    expect(probe(joinPath(a, b))).toEqual({ kind: "found", version: null });
    expect(readInvocations(a)).toHaveLength(1);
    expect(readInvocations(b)).toEqual([]);
  });

  it.skipIf(!IS_WINDOWS)(
    "CANDIDATE-U-CCVER-012 follows PATHEXT order and skips extensionless claude",
    () => {
      const dir = fixtureDir();
      writeFileSync(join(dir, "claude"), "#!/bin/sh\necho 2.1.290\n");
      writeFakeClaude(dir, { ext: ".bat", version: "2.1.300" });
      writeFakeClaude(dir, { ext: ".cmd", version: "2.1.318" });
      expect(probe(dir, { PATHEXT: ".BAT;.CMD" })).toEqual({ kind: "found", version: "2.1.300" });
    },
  );

  it.skipIf(IS_WINDOWS)("CANDIDATE-U-CCVER-013 skips a non-executable claude", () => {
    const root = fixtureDir();
    const a = join(root, "a");
    const b = join(root, "b");
    writeFakeClaude(a, { version: "2.1.299", mode: 0o644 });
    writeFakeClaude(b, { version: "2.1.318" });
    expect(probe(joinPath(a, b))).toEqual({ kind: "found", version: "2.1.318" });
  });

  it("CANDIDATE-U-CCVER-015 returns not_found without running anything", () => {
    const dir = fixtureDir();
    expect(probe(dir)).toEqual({ kind: "not_found" });
  });

  it("CANDIDATE-U-CCVER-020 runs the candidate by its absolute path", () => {
    const dir = fixtureDir();
    const file = writeFakeClaude(dir, { version: "2.1.318" });
    expect(probe(joinPath("", dir))).toEqual({ kind: "found", version: "2.1.318" });
    const lines = readInvocations(dir);
    expect(lines).toHaveLength(1);
    expect(samePath(lines[0] ?? "", file)).toBe(true);
  });
});
