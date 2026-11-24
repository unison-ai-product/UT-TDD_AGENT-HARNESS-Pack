import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHandoverDeps, runHandover } from "../src/handover/index.ts";
import {
  buildProviderHandover,
  nodeProviderHandoverDeps,
  readProviderHandoverCurrent,
  runProviderHandover,
} from "../src/runtime/provider-handover.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const NOW = "2026-11-11T06:00:00.000Z";
const ACTIVE_PLAN = "PLAN-L7-04-handover-mechanism";
const CURRENT_PLAN = join(".ut-tdd", "state", "current-plan");
const POINTER = join(".ut-tdd", "handover", "CURRENT.json");
const PROVIDER_CURRENT = join(".ut-tdd", "handover", "provider", "CURRENT.json");
const DIGEST = join(".ut-tdd", "logs", "plan", `${ACTIVE_PLAN}.digest.json`);
const LEGACY_PROVIDER_PACKAGE = {
  schema_version: "provider-handover.v1",
  handover_kind: "mechanical",
  handover_id: "20260608000000-claude-to-codex-legacy-plan",
  from: "claude",
  to: "codex",
  active_plan: ACTIVE_PLAN,
  budget: null,
  context: {
    summary: "continue legacy session",
    next_actions: ["review handover"],
    files: ["src/runtime/provider-handover.ts"],
  },
  created_at: "2026-06-08T00:00:00.000Z",
} as const;
const LEGACY_DIGEST = {
  plan_id: ACTIVE_PLAN,
  sessions: ["session-1"],
  commits: ["abc123"],
  files_touched: ["src/handover/index.ts"],
  failures: [],
  updated_at: NOW,
} as const;
const LEGACY_PROVIDER_INPUT = {
  from: "claude",
  to: "codex",
  activePlan: ACTIVE_PLAN,
  summary: "continue",
} as const;
const PLAN_FREE_PROVIDER_INPUT = { from: "claude", to: "codex", summary: "continue" } as const;
const tempRoots: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-planret-s4-handover-"));
  tempRoots.push(root);
  execFileSync("git", ["init", "--quiet", "-b", ACTIVE_PLAN], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
    windowsHide: true,
  });
  execFileSync("git", ["config", "user.name", "UT-TDD handover fixture"], {
    cwd: root,
    windowsHide: true,
  });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: initialize handover fixture",
    ],
    {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  return root;
}

function writeFixture(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function handoverDeps(root: string) {
  return { ...nodeHandoverDeps(root), now: () => NOW };
}

function providerDeps(root: string) {
  return { ...nodeProviderHandoverDeps(root), now: () => NOW };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) removeTestTree(root);
});

describe("U-PLANRET-026 S4 handover retirement", () => {
  it("U-PLANRET-026: new session pointer has null active_plan", () => {
    const root = tempRepo();
    writeFixture(root, CURRENT_PLAN, `${ACTIVE_PLAN}\n${NOW}`);
    writeFixture(root, DIGEST, JSON.stringify(LEGACY_DIGEST));
    writeFixture(root, PROVIDER_CURRENT, JSON.stringify(LEGACY_PROVIDER_PACKAGE));
    const result = runHandover({ date: "2026-11-11" }, handoverDeps(root));
    const pointer = JSON.parse(readFileSync(join(root, POINTER), "utf8")) as {
      active_plan: string | null;
    };

    expect([result.pointer.active_plan, pointer.active_plan]).toEqual([null, null]);
  });

  it("U-PLANRET-026: new provider package has null active_plan", () => {
    const pkg = buildProviderHandover(LEGACY_PROVIDER_INPUT, NOW);

    expect(pkg.active_plan).toBeNull();
  });

  it("U-PLANRET-026: provider ID has no PLAN suffix", () => {
    const pkg = buildProviderHandover(LEGACY_PROVIDER_INPUT, NOW);

    expect(pkg.handover_id).toBe("20261111060000-claude-to-codex");
  });

  it("U-PLANRET-026: provider generation accepts no PLAN input", () => {
    const root = tempRepo();
    writeFixture(root, CURRENT_PLAN, `${ACTIVE_PLAN}\n${NOW}`);
    writeFixture(root, DIGEST, JSON.stringify(LEGACY_DIGEST));
    writeFixture(root, PROVIDER_CURRENT, JSON.stringify(LEGACY_PROVIDER_PACKAGE));
    let result: ReturnType<typeof runProviderHandover> | undefined;
    expect(() => {
      result = runProviderHandover(
        PLAN_FREE_PROVIDER_INPUT as Parameters<typeof buildProviderHandover>[0],
        providerDeps(root),
      );
    }).not.toThrow();

    expect(result?.package.active_plan).toBeNull();
    expect(result?.package.handover_id).toBe("20261111060000-claude-to-codex");
    expect(JSON.parse(readFileSync(join(root, PROVIDER_CURRENT), "utf8")).active_plan).toBeNull();
  });

  it("U-PLANRET-026: legacy reader preserves the saved provider package", () => {
    const root = tempRepo();
    writeFixture(root, PROVIDER_CURRENT, JSON.stringify(LEGACY_PROVIDER_PACKAGE));

    expect(readProviderHandoverCurrent(providerDeps(root))).toEqual(LEGACY_PROVIDER_PACKAGE);
  });

  it("U-PLANRET-026: branch alone does not resolve session active_plan", () => {
    const root = tempRepo();

    expect(runHandover({ date: "2026-11-11" }, handoverDeps(root)).pointer.active_plan).toBeNull();
  });

  it("U-PLANRET-026: legacy PLAN digest does not populate new pointer fields", () => {
    const root = tempRepo();
    writeFixture(root, DIGEST, JSON.stringify(LEGACY_DIGEST));

    const pointer = runHandover({ date: "2026-11-11" }, handoverDeps(root)).pointer;
    expect(pointer.active_plan).toBeNull();
    expect(pointer.digest_summary).toBeNull();
  });
});
