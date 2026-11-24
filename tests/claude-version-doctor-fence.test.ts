import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PathClaudeProbe } from "../src/doctor/claude-path-probe.ts";
import { checkClaudeVersionFloor } from "../src/doctor/claude-version-floor-check.ts";
import { readInvocations, samePath } from "./support/claude-probe-fixture.ts";

const PREFIX = "doctor: claude-version-floor - ";

function check(probePathClaude: () => PathClaudeProbe) {
  return checkClaudeVersionFloor({ probePathClaude });
}

const fenceDir = process.env.UT_TDD_CLAUDE_FENCE_DIR;
const fenceIsFirst =
  !!fenceDir &&
  existsSync(fenceDir) &&
  samePath((process.env.PATH ?? "").split(delimiter)[0] ?? "", fenceDir);

describe("Claude Code version doctor row and fence (Issue #1675 / #1677)", () => {
  it("CANDIDATE-U-CCVER-014 shows the four states exactly, all ok", () => {
    const cases: { probe: () => PathClaudeProbe; message: string }[] = [
      {
        probe: () => ({ kind: "not_found" }),
        message: `${PREFIX}SKIP: PATH に claude が見つからない (版を確かめられない)`,
      },
      {
        probe: () => ({ kind: "found", version: null }),
        message: `${PREFIX}WARN: PATH の claude の版を読めない (版を確かめられない)`,
      },
      {
        probe: () => ({ kind: "found", version: "2.1.318" }),
        message: `${PREFIX}OK: PATH の claude の版 (2.1.318)`,
      },
      {
        probe: () => {
          throw new Error("probe failed");
        },
        message: `${PREFIX}WARN: PATH の claude の版を読めない (版を確かめられない)`,
      },
    ];
    for (const { probe, message } of cases) {
      const result = check(probe);
      expect(result.ok).toBe(true);
      expect(result.messages).toEqual([message]);
    }
  });

  it("CANDIDATE-U-CCVER-018 the fence sits first on PATH and records the default probe", () => {
    const dir = process.env.UT_TDD_CLAUDE_FENCE_DIR;
    expect(dir).toBeTruthy();
    expect(samePath((process.env.PATH ?? "").split(delimiter)[0] ?? "", dir ?? "")).toBe(true);
    const before = readInvocations(dir ?? "").length;
    checkClaudeVersionFloor();
    expect(readInvocations(dir ?? "").length).toBe(before + 1);
  });

  // 前提 (fence が PATH の先頭) が偽なら skip し、検出に数えない。
  (fenceIsFirst ? it : it.skip)(
    "CANDIDATE-U-CCVER-019 the doctor CLI child process shows the fence version in its row",
    () => {
      const run = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "src", "cli.ts"),
          "doctor",
          "--profile",
          "consumer-toolchain",
          "--json",
        ],
        { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 120_000 },
      );
      const payload = JSON.parse(run.stdout) as { messages: string[] };
      expect(payload.messages).toContain(`${PREFIX}OK: PATH の claude の版 (9999.0.0)`);
    },
    130_000,
  );
});
