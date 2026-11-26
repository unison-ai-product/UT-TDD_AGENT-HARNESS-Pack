import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { scanPostMergeBackstop } from "../src/feedback/post-merge-backstop.ts";
import {
  buildClaudeProviderReviewInboxEntry,
  claudeWorkspaceId,
  publishClaudeInboxEntry,
  waitForClaudeMemory,
} from "../src/runtime/claude-memory-wake.ts";
import {
  resolveProjectMemoryRoot,
  resolveProjectMemoryRootWithPorts,
} from "../src/runtime/project-memory-root.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

interface Command {
  file: "git" | "gh";
  args: string[];
}

const TOPOLOGY = ["rev-parse --show-toplevel", "rev-parse --path-format=absolute --git-common-dir"];
const IDENTITY_READ = [
  "rev-parse --show-object-format",
  "rev-parse HEAD",
  "ls-tree",
  "show",
  "rev-parse HEAD",
  "remote get-url origin",
];
const SESSION_ID = "session-start-identity-read";
const SESSION_MEMORY = {
  memory_id: "memory:session-start-observation",
  kind: "project" as const,
  title: "SessionStart observation",
  body: "SessionStart observation fixture",
  tags: ["session-start"],
  source_path: ".ut-tdd/memory/session-start-observation.md",
  updated_at: "2026-11-26T00:00:00.000Z",
  content_hash: "e".repeat(64),
};

interface SessionRun {
  root: string;
  sessionId: string;
  start: SpawnSyncReturns<string>;
  commands: Command[];
  inbox: Array<{ path: string; bytes: Buffer }>;
}

function sessionRun(pendingCount: number, suffix: string, ghMode = "available"): SessionRun {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ut-session-start-observation-${suffix}-`)));
  const sessionId = `session-start-observation-${suffix}`;
  ensureTrackedProjectIdentity(root, `fixture/session-start-observation-${suffix}`);
  const project = resolveProjectMemoryRoot(root);
  if (!project.ok) throw new Error(project.reason);
  const inbox = Array.from({ length: pendingCount }, (_, index) => {
    const digest = String(index + 1).padStart(16, "0");
    const entry = buildClaudeProviderReviewInboxEntry({
      memory: {
        ...SESSION_MEMORY,
        memory_id: `memory:session-start-observation-${suffix}-${index}`,
      },
      projectId: project.projectId,
      operationId: `session-start-observation-${suffix}-${index}`,
      workspaceId: claudeWorkspaceId(root),
      producer: { provider: "codex", sessionId: `codex-observation-${suffix}` },
      target: { scope: "session", provider: "claude", sessionId },
      requestDigest: digest,
      requestPath: `.ut-tdd/review/requests/${digest}.json`,
      pr: 1900 + index,
      exactHead: "c".repeat(40),
      reviewRevision: `review-observation-${suffix}-${index}`,
      authorFamily: "codex",
    });
    const path = publishClaudeInboxEntry(root, entry);
    return { path, bytes: readFileSync(path) };
  });
  const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
  try {
    migrate(db);
  } finally {
    db.close();
  }
  const start = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve("tests/support/session-start-identity-preload.mjs")).href,
      resolve("src/cli.ts"),
      "session",
      "start",
      "--session",
      sessionId,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: "",
        UT_TDD_PROJECT_DIR: root,
        UT_TDD_SKIP_UPDATE_CHECK: "1",
        UT_TDD_TEST_GH_MODE: ghMode,
        GIT_CONFIG_COUNT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 60_000,
    },
  );
  if (start.error) throw start.error;
  const commands = readFileSync(join(root, "session-start-commands.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Command);
  return { root, sessionId, start, commands, inbox };
}

function inboxMarkerPath(entryPath: string, suffix: ".claim" | ".terminal.json"): string {
  return join(dirname(dirname(entryPath)), basename(entryPath, ".json") + suffix);
}

function summarizeRootReads(commands: Command[]): string[][] {
  const resolutions: string[][] = [];
  for (const { file, args } of commands) {
    if (file !== "git" || args[0] !== "-C") continue;
    const git = args.slice(2);
    const command = git.join(" ");
    if (command === TOPOLOGY[0]) resolutions.push([]);
    const current = resolutions.at(-1);
    if (!current) continue;
    const signature = git[0] === "ls-tree" || git[0] === "show" ? git[0] : command;
    if (TOPOLOGY.includes(signature) || IDENTITY_READ.includes(signature)) {
      current.push(signature);
    }
  }
  return resolutions;
}

describe("SessionStart project identity reads", () => {
  let root: string;
  let commandLog: Command[];
  let start: ReturnType<typeof startSession>;
  const observationRuns: SessionRun[] = [];

  function startSession(cwd: string) {
    return spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("tests/support/session-start-identity-preload.mjs")).href,
        resolve("src/cli.ts"),
        "session",
        "start",
        "--session",
        SESSION_ID,
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: "",
          UT_TDD_PROJECT_DIR: cwd,
          UT_TDD_SKIP_UPDATE_CHECK: "1",
          GIT_CONFIG_COUNT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 60_000,
      },
    );
  }

  heavyBeforeAll("db", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ut-session-start-identity-")));
    ensureTrackedProjectIdentity(root, "fixture/session-start-identity");
    const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
    try {
      migrate(db);
    } finally {
      db.close();
    }
    start = startSession(root);
    if (start.error) throw start.error;
    if (start.status !== 0) throw new Error(`SessionStart exit ${start.status}: ${start.stderr}`);
    commandLog = readFileSync(join(root, "session-start-commands.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Command);
  });

  for (const count of [0, 1, 3]) {
    heavyBeforeAll("db", () => {
      observationRuns.push(sessionRun(count, `pending-${count}`));
    });
  }
  heavyBeforeAll("db", () => {
    observationRuns.push(sessionRun(1, "github-unavailable", "unavailable"));
  });

  heavyAfterAll("teardown", () => {
    if (root) removeTestTree(root);
    for (const run of observationRuns) removeTestTree(run.root);
  });

  it("P-PMEMROOT-006: retains the session event and digest", () => {
    expect({ status: start.status, signal: start.signal, stderr: start.stderr }).toMatchObject({
      status: 0,
      signal: null,
    });
    expect(start.stdout).toContain(`session-log: start ${SESSION_ID}`);
    expect(start.stdout).toContain(
      "session-start digest (source=harness.db + HEAD + HARNESS memory)",
    );
    expect(start.stdout).toContain("test: seed project identity");
    expect(start.stdout).toContain("inbox: no unclaimed Claude payload");
    const log = readFileSync(
      join(root, ".ut-tdd", "logs", "session", `${SESSION_ID}.jsonl`),
      "utf8",
    );
    const events = log
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({ event_type: "session_start", session_id: SESSION_ID }),
    );

    const resolutions = summarizeRootReads(commandLog);
    expect(resolutions).toHaveLength(3);
    for (const git of resolutions) {
      expect(git.slice(0, 2 + IDENTITY_READ.length)).toEqual([...TOPOLOGY, ...IDENTITY_READ]);
    }
  });

  it("CANDIDATE-U-SSOBS-001 fixture: pending inbox and GitHub-unavailable SessionStart remain valid", () => {
    for (const run of observationRuns) {
      expect(run.start.status).toBe(0);
      expect(run.start.signal).toBeNull();
      expect(run.start.stdout).toContain(`session-log: start ${run.sessionId}`);
      expect(run.start.stdout).toContain(
        "session-start digest (source=harness.db + HEAD + HARNESS memory)",
      );
      const expectedInbox =
        run.inbox.length === 0
          ? "inbox: no unclaimed Claude payload"
          : `inbox: pending=${run.inbox.length}`;
      expect(run.start.stdout).toContain(expectedInbox);
      const backstopLine = run.start.stdout
        .split(/\r?\n/)
        .find((line) => line.includes("post-merge backstop:"));
      expect(backstopLine).toBeDefined();
      const eventPath = join(run.root, ".ut-tdd", "logs", "session", `${run.sessionId}.jsonl`);
      const events = readFileSync(eventPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({ event_type: "session_start", session_id: run.sessionId }),
      );
      for (const entry of run.inbox) {
        expect(existsSync(entry.path)).toBe(true);
        expect(readFileSync(entry.path)).toEqual(entry.bytes);
        expect(existsSync(inboxMarkerPath(entry.path, ".claim"))).toBe(false);
        expect(existsSync(inboxMarkerPath(entry.path, ".terminal.json"))).toBe(false);
      }
    }
  });

  it("CANDIDATE-U-SSOBS-001: SessionStart starts no GitHub commands and marks both reads unobserved", () => {
    const violations = observationRuns.flatMap((run) => {
      const issues: string[] = [];
      const ghCalls = run.commands.filter(({ file }) => file === "gh");
      if (ghCalls.length > 0) {
        issues.push(`${run.sessionId}: SessionStart launched gh: ${JSON.stringify(ghCalls)}`);
      }
      if (!run.start.stdout.includes("inbox PR state: not checked (pending reviews retained)")) {
        issues.push(`${run.sessionId}: inbox PR state is not marked unobserved`);
      }
      const backstopLine = run.start.stdout
        .split(/\r?\n/)
        .find((line) => line.includes("post-merge backstop:"));
      if (backstopLine !== "  post-merge backstop: not checked") {
        issues.push(`${run.sessionId}: post-merge status is not marked unobserved`);
      }
      if (/post-merge backstop:.*count=0/i.test(run.start.stdout)) {
        issues.push(`${run.sessionId}: digest reports a zero-detection backstop`);
      }
      return issues;
    });
    expect(violations).toEqual([]);
  });

  it("CANDIDATE-U-SSOBS-002: wake and feedback GitHub observations remain independent", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "ut-session-start-independent-observation-")),
    );
    ensureTrackedProjectIdentity(root, "fixture/session-start-independent-observation");
    const project = resolveProjectMemoryRoot(root);
    if (!project.ok) throw new Error(project.reason);
    const requestDigest = "a".repeat(16);
    const entry = buildClaudeProviderReviewInboxEntry({
      memory: SESSION_MEMORY,
      projectId: project.projectId,
      operationId: "session-start-independent-observation",
      workspaceId: claudeWorkspaceId(root),
      producer: { provider: "codex", sessionId: "codex-observation" },
      target: { scope: "session", provider: "claude", sessionId: "wake-observation" },
      requestDigest,
      requestPath: `.ut-tdd/review/requests/${requestDigest}.json`,
      pr: 1998,
      exactHead: "c".repeat(40),
      reviewRevision: "wake-observation",
      authorFamily: "codex",
    });
    const entryPath = publishClaudeInboxEntry(root, entry);
    try {
      let observedPr = 0;
      const wake = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "wake-observation",
        pollIntervalMs: 10,
        maxWaitMs: 10,
        sleep: async () => undefined,
        pullRequestState: (pr) => {
          observedPr = pr;
          return { pr, state: "MERGED", headSha: entry.exactHead };
        },
      });
      expect(wake.kind).toBe("timeout");
      expect(observedPr).toBe(entry.pr);
      const marker = JSON.parse(readFileSync(inboxMarkerPath(entryPath, ".terminal.json"), "utf8"));
      expect(marker).toMatchObject({
        entryId: entry.id,
        reason: "pr_merged",
        requestDigest,
        pr: entry.pr,
        exactHead: entry.exactHead,
      });

      const commands: Array<{ file: string; args: readonly string[] }> = [];
      const backstop = scanPostMergeBackstop({
        repoRoot: root,
        execFileSync: ((file: string, args: readonly string[]) => {
          commands.push({ file, args });
          return file === "git"
            ? "https://github.com/fixture/session-start-independent-observation.git"
            : "[]";
        }) as typeof import("node:child_process").execFileSync,
      });
      expect(backstop).toMatchObject({ ok: true, pagesScanned: 1 });
      expect(commands.filter(({ file }) => file === "gh")).toEqual([
        {
          file: "gh",
          args: ["api", expect.stringMatching(/\/pulls\?state=closed.*&page=1$/)],
        },
      ]);
    } finally {
      removeTestTree(root);
    }
  });

  it("P-PMEMROOT-006: reads identity once in each of the three resolutions", () => {
    const resolutions = summarizeRootReads(commandLog);
    expect(resolutions.map((git) => git.filter((command) => command === "show").length)).toEqual([
      1, 1, 1,
    ]);
  });
});

const win = process.platform === "win32";
const primary = win ? "C:\\dev\\product" : "/dev/product";
const linked = win ? "C:\\dev\\product-worker" : "/dev/product-worker";
const common = win ? `${primary}\\.git` : `${primary}/.git`;

function ports(overrides: Partial<Parameters<typeof resolveProjectMemoryRootWithPorts>[1]> = {}) {
  return {
    gitTopLevel: () => linked,
    gitCommonDir: () => common,
    realpath: (path: string) => path,
    isDirectory: () => true,
    isSafeDescendant: () => true,
    projectIdentity: () => "owner/product",
    ...overrides,
  };
}

describe("Project identity read boundaries", () => {
  it("U-PMEMROOT-010: revalidates identity on a separate root resolution", () => {
    const identityReads: string[] = [];
    let identity: string | null = "owner/product";
    const resolverPorts = ports({
      gitTopLevel: () => primary,
      projectIdentity: (path) => {
        identityReads.push(path);
        return identity;
      },
    });

    const first = resolveProjectMemoryRootWithPorts(primary, resolverPorts);
    const firstReads = identityReads.splice(0);
    expect(first).toMatchObject({
      ok: true,
      projectId: "owner/product",
      canonicalProjectRoot: primary,
      currentWorktreeRoot: primary,
      authoredMemoryRoot: join(primary, ".ut-tdd", "memory"),
    });
    if (!first.ok) throw new Error(first.reason);
    const linkedResult = resolveProjectMemoryRootWithPorts(linked, ports());
    if (!linkedResult.ok) throw new Error(linkedResult.reason);
    expect(first.projectNamespace).toBe(linkedResult.projectNamespace);
    expect(first.runtimeBusRoot).toBe(linkedResult.runtimeBusRoot);

    identity = null;
    expect(resolveProjectMemoryRootWithPorts(primary, resolverPorts)).toEqual({
      ok: false,
      reason: "project_identity_unavailable",
    });
    expect({ first: firstReads, second: identityReads }).toEqual({
      first: [primary],
      second: [primary],
    });
  });

  it.each([
    { canonicalIdentity: "owner/product", expected: { ok: true, projectId: "owner/product" } },
    { canonicalIdentity: "owner/other", expected: { ok: false, reason: "project_identity_drift" } },
    { canonicalIdentity: null, expected: { ok: false, reason: "project_identity_unavailable" } },
  ])("U-PMEMROOT-011: verifies both distinct paths (canonical identity: $canonicalIdentity)", ({
    canonicalIdentity,
    expected,
  }) => {
    const identityReads: string[] = [];
    const result = resolveProjectMemoryRootWithPorts(
      linked,
      ports({
        projectIdentity: (path) => {
          identityReads.push(path);
          return path === linked ? "owner/product" : canonicalIdentity;
        },
      }),
    );
    expect(result).toMatchObject(expected);
    expect(identityReads).toEqual([linked, primary]);
  });
});
