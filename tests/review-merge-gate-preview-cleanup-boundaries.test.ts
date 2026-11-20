import { execFileSync as realExecFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync as realRmSync } from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASELINE_GATES } from "../src/feedback/baseline-conflict.ts";
import { CODE_SIZE_BASELINE_PATH } from "../src/lint/code-size.ts";
import {
  buildFixture,
  cleanFixture,
  type Fixture,
  runMerge,
  separatedFile,
  TARGET,
} from "./fixtures/baseline-recompute-fixture.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";

const injected = vi.hoisted(() => ({
  fixtureRoot: "",
  showTopLevelCount: 0,
  failShowTopLevelAt: 0,
  rootAtShowTopLevel: 0,
  failMkdtemp: false,
  trackCleanup: false,
  previewPath: "",
  failWorktreeRemove: false,
  failDirectoryRemove: false,
  failPrune: false,
  cleanupCalls: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const command = String(args[0]);
      const commandArgs = Array.isArray(args[1]) ? args[1].map(String) : [];
      if (
        command === "git" &&
        commandArgs.at(-2) === "rev-parse" &&
        commandArgs.at(-1) === "--show-toplevel"
      ) {
        injected.showTopLevelCount += 1;
        if (injected.showTopLevelCount === injected.failShowTopLevelAt) {
          throw new Error("injected_preview_root_resolution_failure");
        }
        if (injected.showTopLevelCount === injected.rootAtShowTopLevel) {
          return `${parse(injected.fixtureRoot).root}\n` as never;
        }
      }
      if (injected.trackCleanup && command === "git") {
        if (commandArgs.includes("worktree") && commandArgs.includes("remove")) {
          injected.cleanupCalls.push("worktree_remove");
          if (injected.failWorktreeRemove) throw new Error("injected_worktree_remove_failure");
        }
        if (commandArgs.includes("worktree") && commandArgs.includes("prune")) {
          injected.cleanupCalls.push("worktree_prune");
          if (injected.failPrune) throw new Error("injected_worktree_prune_failure");
        }
      }
      return actual.execFileSync(...args);
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      if (injected.failMkdtemp) throw new Error("injected_preview_directory_create_failure");
      const path = actual.mkdtempSync(...args);
      if (injected.trackCleanup) injected.previewPath = path;
      return path;
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (injected.trackCleanup && String(args[0]) === injected.previewPath) {
        injected.cleanupCalls.push("directory_remove");
        if (injected.failDirectoryRemove) throw new Error("injected_directory_remove_failure");
      }
      return actual.rmSync(...args);
    },
  };
});

const wrapperBaseline = '{\n  "src/alpha.ts": {"lines": null, "functionExcess": null}\n}\n';
let fixture: Fixture;

function resetInjected(): void {
  injected.fixtureRoot = "";
  injected.showTopLevelCount = 0;
  injected.failShowTopLevelAt = 0;
  injected.rootAtShowTopLevel = 0;
  injected.failMkdtemp = false;
  injected.trackCleanup = false;
  injected.previewPath = "";
  injected.failWorktreeRemove = false;
  injected.failDirectoryRemove = false;
  injected.failPrune = false;
  injected.cleanupCalls = [];
}

function cleanupOwnedPreview(): void {
  const ownedPath = injected.previewPath;
  if (!ownedPath) return;

  // Disable the injected failures before using the mock-wrapped APIs for real
  // fixture teardown. Keep previewPath until all ownership checks are complete.
  injected.failShowTopLevelAt = 0;
  injected.rootAtShowTopLevel = 0;
  injected.failMkdtemp = false;
  injected.trackCleanup = false;
  injected.failWorktreeRemove = false;
  injected.failDirectoryRemove = false;
  injected.failPrune = false;

  const fixtureRoot = realpathSync.native(fixture.work);
  const expectedParent = resolve(dirname(fixtureRoot));
  const previewPath = resolve(ownedPath);
  const samePath = (left: string, right: string): boolean =>
    process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (
    !samePath(dirname(previewPath), expectedParent) ||
    !basename(previewPath).startsWith("ut-tdd-baseline-preview-1559-")
  ) {
    throw new Error(`refusing to clean an unowned preview path: ${previewPath}`);
  }

  const worktrees = String(
    realExecFileSync("git", ["-C", fixture.work, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const isRegistered = worktrees
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => samePath(resolve(line.slice("worktree ".length)), previewPath));
  if (isRegistered) {
    realExecFileSync("git", ["-C", fixture.work, "worktree", "remove", "--force", previewPath], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  }
  if (existsSync(previewPath)) realRmSync(previewPath, { recursive: true, force: true });
  realExecFileSync("git", ["-C", fixture.work, "worktree", "prune"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function captureStderr(run: () => unknown): { result: unknown; output: string } {
  let output = "";
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as never);
  try {
    return { result: run(), output };
  } finally {
    write.mockRestore();
  }
}

function resultReceipt(path: string | null): Record<string, unknown> {
  if (!path) throw new Error("merge receipt path was not returned");
  const receipts = readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const receipt = receipts.filter((entry) => entry.receiptKind === "merge_result").at(-1);
  if (!receipt) throw new Error("merge_result receipt was not written");
  return receipt;
}

function enableCleanupFaults(input: {
  worktreeRemove?: boolean;
  directoryRemove?: boolean;
  prune?: boolean;
}): void {
  injected.trackCleanup = true;
  injected.failWorktreeRemove = input.worktreeRemove ?? false;
  injected.failDirectoryRemove = input.directoryRemove ?? false;
  injected.failPrune = input.prune ?? false;
}

describe.sequential("review merge gate preview cleanup boundaries (U-RVMG-052)", () => {
  heavyBeforeAll("git", () => {
    fixture = buildFixture(
      {
        [TARGET]: separatedFile("const left = 1;", "const right = 1;"),
        [CODE_SIZE_BASELINE_PATH]: wrapperBaseline,
      },
      {
        pr: { [TARGET]: separatedFile("const left = 2;", "const right = 1;") },
        main: { [TARGET]: separatedFile("const left = 1;", "const right = 2;") },
      },
    );
    injected.fixtureRoot = fixture.work;
  });

  afterEach(() => {
    cleanupOwnedPreview();
    resetInjected();
    vi.restoreAllMocks();
  });

  heavyAfterAll("teardown", () => {
    cleanFixture(fixture);
  });

  it("root resolution failure and filesystem-root parent resolution both deny before merge", () => {
    injected.failShowTopLevelAt = 2;
    const unresolvedRoot = runMerge(fixture);
    expect(unresolvedRoot.result.reason).toBe(
      "baseline_conflict_unknown:preview_parent_unresolved",
    );
    expect(unresolvedRoot.merges).toBe(0);

    resetInjected();
    injected.fixtureRoot = fixture.work;
    injected.rootAtShowTopLevel = 2;
    const unresolvedParent = runMerge(fixture);
    expect(unresolvedParent.result.reason).toBe(
      "baseline_conflict_unknown:preview_parent_unresolved",
    );
    expect(unresolvedParent.merges).toBe(0);
  });

  it("preview directory creation failure denies without attempting merge", () => {
    injected.failMkdtemp = true;
    const run = runMerge(fixture);
    expect(run.result.reason).toBe("baseline_conflict_unknown:preview_dir_create_failed");
    expect(run.merges).toBe(0);
  });

  it.each([
    {
      stage: "worktree_remove",
      faults: { worktreeRemove: true },
      expectedCalls: ["worktree_remove", "directory_remove", "worktree_prune"],
      reasonPart: "worktree_remove:injected_worktree_remove_failure",
    },
    {
      stage: "directory_remove",
      faults: { worktreeRemove: true, directoryRemove: true },
      expectedCalls: ["worktree_remove", "directory_remove", "worktree_prune"],
      reasonPart: "directory_remove:injected_directory_remove_failure",
    },
    {
      stage: "worktree_prune",
      faults: { prune: true },
      expectedCalls: ["worktree_remove", "worktree_prune"],
      reasonPart: "worktree_prune:injected_worktree_prune_failure",
    },
  ])("$stage cleanup failure still attempts later stages and preserves allow decision", ({
    faults,
    expectedCalls,
    reasonPart,
  }) => {
    enableCleanupFaults(faults);
    const { result: run, output } = captureStderr(() => runMerge(fixture));
    const merge = run as ReturnType<typeof runMerge>;

    expect(merge.result).toMatchObject({ ok: true, decision: "merge", reason: "merge_ready" });
    expect(merge.merges).toBe(1);
    expect(injected.cleanupCalls).toEqual(expectedCalls);
    expect(output).toContain("baseline preview cleanup failed:");
    expect(output).toContain(reasonPart);
    expect(resultReceipt(merge.result.receiptPath)).toMatchObject({
      decision: "merge",
      preview: { cleanup: "failed", cleanupReason: expect.stringContaining(reasonPart) },
    });
  });

  it("cleanup failure leaves an already denied decision denied and records preview diagnostics", () => {
    const codeSizeGate = BASELINE_GATES.find((gate) => gate.name === "code-size");
    if (!codeSizeGate) throw new Error("code-size gate prerequisite missing");
    vi.spyOn(codeSizeGate, "check").mockReturnValue({
      ok: false,
      findings: [{ path: TARGET, kind: "code-size-required", reason: "injected_denial" }],
    });
    enableCleanupFaults({ worktreeRemove: true, directoryRemove: true, prune: true });

    const { result: run, output } = captureStderr(() => runMerge(fixture));
    const merge = run as ReturnType<typeof runMerge>;
    expect(merge.result.reason).toBe("baseline_conflict_recomputed:code-size=code-size-required");
    expect(merge.merges).toBe(0);
    expect(injected.cleanupCalls).toEqual([
      "worktree_remove",
      "directory_remove",
      "worktree_prune",
    ]);
    expect(output).toContain("baseline preview cleanup failed:");
    const receipt = resultReceipt(merge.result.receiptPath);
    expect(receipt).toMatchObject({
      decision: "deny",
      reason: "baseline_conflict_recomputed:code-size=code-size-required",
      preview: {
        cleanup: "failed",
        cleanupReason: expect.stringContaining("worktree_remove:injected_worktree_remove_failure"),
      },
    });
    expect((receipt.preview as Record<string, unknown>).cleanupReason).toContain(
      "directory_remove:injected_directory_remove_failure",
    );
    expect((receipt.preview as Record<string, unknown>).cleanupReason).toContain(
      "worktree_prune:injected_worktree_prune_failure",
    );
  });
});
