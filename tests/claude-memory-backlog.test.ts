import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  renderSessionStartDigest,
  selectSessionStartDigest,
} from "../src/handover/session-start-digest.ts";
import type { MemoryEntry } from "../src/memory/index.ts";
import {
  buildClaudeInboxEntry,
  buildClaudeProviderReviewInboxEntry,
  CLAUDE_WAKE_GENERATION_SCHEMA,
  claudeWorkspaceId,
  inspectClaudeMemoryWakeHook,
  publishClaudeInboxEntry,
  recoverAndSummarizeClaudeInboxForSessionStart,
  summarizeUnclaimedInbox,
  waitForClaudeMemory,
} from "../src/runtime/claude-memory-wake.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";

const projectMemoryRootResolution = vi.hoisted(() => ({ count: 0 }));
const directoryReadObservations = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../src/runtime/project-memory-root.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/project-memory-root.ts")>();
  return {
    ...actual,
    requireProjectMemoryRoot: vi.fn((repoRoot: string) => {
      projectMemoryRootResolution.count += 1;
      return actual.requireProjectMemoryRoot(repoRoot);
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    directoryReadObservations.paths.push(String(args[0]));
    return actual.readdirSync(...args);
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync };
});

const memory: MemoryEntry = {
  memory_id: "memory:project:backlog-227",
  kind: "project",
  title: "backlog 227",
  body: "配送backlog可視化",
  tags: ["claude", "backlog"],
  source_path: ".ut-tdd/memory/project-backlog-227.md",
  updated_at: "2026-08-21T00:00:00.000Z",
  content_hash: "b".repeat(64),
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-memory-backlog-"));
  ensureTrackedProjectIdentity(root, "fixture/claude-memory-backlog");
  return root;
}

function generationPath(root: string, sessionId: string): string {
  const project = resolveProjectMemoryRoot(root);
  if (!project.ok) throw new Error(project.reason);
  return join(project.runtimeBusRoot, "claude-memory-wake", `${sessionId}.generation`);
}

describe("Claude memory delivery backlog visibility", () => {
  it("SessionStart inbox route recovers before summarizing with two validated contexts", async () => {
    const root = fixture();
    try {
      const runSessionStart = recoverAndSummarizeClaudeInboxForSessionStart;
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const workspaceId = project.projectNamespace;
      const current = buildClaudeInboxEntry({
        memory,
        operationId: "session-current",
        workspaceId,
      });
      const foreign = buildClaudeInboxEntry({
        memory,
        operationId: "session-foreign",
        workspaceId: "f".repeat(64),
      });
      const digest = "c".repeat(16);
      const review = buildClaudeProviderReviewInboxEntry({
        memory,
        projectId: project.projectId,
        operationId: "session-terminal",
        workspaceId,
        producer: { provider: "codex", sessionId: "codex-session-start" },
        target: { scope: "session", provider: "claude", sessionId: "claude-session-start" },
        requestDigest: digest,
        requestPath: `.ut-tdd/review/requests/${digest}.json`,
        pr: 227,
        exactHead: "a".repeat(40),
        reviewRevision: "session-start-r1",
        authorFamily: "codex",
      });
      publishClaudeInboxEntry(root, current);
      publishClaudeInboxEntry(root, foreign);
      publishClaudeInboxEntry(root, review);

      projectMemoryRootResolution.count = 0;
      const summary = runSessionStart({
        repoRoot: root,
        pullRequestState: (pr) => ({ pr, state: "MERGED", headSha: review.exactHead }),
      });
      expect(projectMemoryRootResolution.count).toBe(2);
      expect(summary).toMatchObject({
        pending: 1,
        targetMismatchPending: 1,
        terminalized: 1,
        workspaceId,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SessionStart inbox route rejects unavailable identity before reading inbox files", async () => {
    const root = fixture();
    try {
      const runSessionStart = recoverAndSummarizeClaudeInboxForSessionStart;
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const inboxDirectory = join(project.runtimeBusRoot, "claude-memory-wake", "inbox");
      publishClaudeInboxEntry(
        root,
        buildClaudeInboxEntry({
          memory,
          operationId: "invalid-identity",
          workspaceId: project.projectNamespace,
        }),
      );
      writeFileSync(join(root, "ut-tdd.project.json"), '{"invalid":true}\n', "utf8");
      directoryReadObservations.paths.length = 0;
      expect(() => runSessionStart({ repoRoot: root })).toThrow(
        "project_memory_root_project_identity_unavailable",
      );
      expect(directoryReadObservations.paths).not.toContain(inboxDirectory);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SessionStart inbox route rejects unavailable identity after recovery before summary", async () => {
    const root = fixture();
    try {
      const runSessionStart = recoverAndSummarizeClaudeInboxForSessionStart;
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const digest = "d".repeat(16);
      const review = buildClaudeProviderReviewInboxEntry({
        memory,
        projectId: project.projectId,
        operationId: "drift-after-recovery",
        workspaceId: project.projectNamespace,
        producer: { provider: "codex", sessionId: "codex-session-start" },
        target: { scope: "session", provider: "claude", sessionId: "claude-session-start" },
        requestDigest: digest,
        requestPath: `.ut-tdd/review/requests/${digest}.json`,
        pr: 228,
        exactHead: "b".repeat(40),
        reviewRevision: "session-start-r2",
        authorFamily: "codex",
      });
      const inboxPath = publishClaudeInboxEntry(root, review);
      projectMemoryRootResolution.count = 0;
      expect(() =>
        runSessionStart({
          repoRoot: root,
          pullRequestState: (pr) => {
            writeFileSync(join(root, "ut-tdd.project.json"), '{"drift":true}\n', "utf8");
            return { pr, state: "MERGED", headSha: review.exactHead };
          },
        }),
      ).toThrow("project_memory_root_project_identity_unavailable");
      const runtimeRoot = join(project.runtimeBusRoot, "claude-memory-wake");
      expect(readdirSync(runtimeRoot).some((name) => name.endsWith(".terminal.json"))).toBe(true);
      expect(existsSync(inboxPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMBACKLOG-001/002: current backlogとforeign targetを同時に可視化する", () => {
    const root = fixture();
    try {
      const current = claudeWorkspaceId(root);
      publishClaudeInboxEntry(
        root,
        buildClaudeInboxEntry({
          memory,
          operationId: "current",
          workspaceId: current,
          now: "2026-08-20T00:00:00.000Z",
        }),
      );
      publishClaudeInboxEntry(
        root,
        buildClaudeInboxEntry({
          memory,
          operationId: "foreign",
          workspaceId: "f".repeat(64),
          now: "2026-08-20T00:01:00.000Z",
        }),
      );

      const summary = summarizeUnclaimedInbox(root, current);
      // U-MEMBACKLOG-002: foreign target backlog is retained as an explicit mismatch.
      expect(summary.pending).toBe(1);
      expect(summary.targetMismatchPending).toBe(1);
      expect(summary.targetMismatchOldestAgeMs).toBeGreaterThan(0);
      expect(summary.warningCodes).toContain("target_mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMBACKLOG-003: generation identity不明をactive扱いしない", async () => {
    const root = fixture();
    try {
      const workspaceId = claudeWorkspaceId(root);
      publishClaudeInboxEntry(
        root,
        buildClaudeInboxEntry({
          memory,
          operationId: "absent",
          workspaceId,
          now: "2026-08-20T00:00:00.000Z",
        }),
      );
      const absent = summarizeUnclaimedInbox(root, workspaceId);
      expect(absent.sessionStatus).toBe("absent");
      expect(absent.activeSessionCount).toBe(0);
      expect(absent.warningCodes).toContain("session_absent");

      const markerRoot = fixture();
      try {
        const markerWorkspaceId = claudeWorkspaceId(markerRoot);
        publishClaudeInboxEntry(
          markerRoot,
          buildClaudeInboxEntry({
            memory,
            operationId: "marker-foreign",
            workspaceId: "f".repeat(64),
          }),
        );
        let active: ReturnType<typeof summarizeUnclaimedInbox> | undefined;
        await waitForClaudeMemory({
          repoRoot: markerRoot,
          sessionId: "live",
          pollIntervalMs: 10,
          maxWaitMs: 100,
          sleep: async () => {
            active = summarizeUnclaimedInbox(markerRoot, markerWorkspaceId);
          },
        });
        expect(active?.sessionStatus).toBe("active");
        expect(active?.activeSessionCount).toBe(1);
        expect(active?.warningCodes).not.toContain("session_absent");

        writeFileSync(
          generationPath(markerRoot, "live"),
          `${JSON.stringify({
            schema: CLAUDE_WAKE_GENERATION_SCHEMA,
            generation: "foreign",
            workspaceId: "f".repeat(64),
          })}\n`,
          "utf8",
        );
        const foreign = summarizeUnclaimedInbox(markerRoot, markerWorkspaceId);
        expect(foreign.sessionStatus).toBe("unknown");
        expect(foreign.activeSessionCount).toBe(0);
        expect(foreign.warningCodes).toContain("session_unknown");
        expect(foreign.warningCodes).not.toContain("session_absent");

        writeFileSync(generationPath(markerRoot, "live"), "123:now:legacy\n", "utf8");
        const legacy = summarizeUnclaimedInbox(markerRoot, markerWorkspaceId);
        expect(legacy.sessionStatus).toBe("unknown");
        expect(legacy.activeSessionCount).toBe(0);
        expect(legacy.warningCodes).toContain("session_unknown");
      } finally {
        rmSync(markerRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMBACKLOG-004: Stop hook欠落/壊れをhook_missingとして可視化する", () => {
    const root = fixture();
    try {
      expect(inspectClaudeMemoryWakeHook(root)).toMatchObject({
        configured: false,
        reason: "settings_missing",
      });
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(join(root, ".claude", "settings.json"), "{broken\n", "utf8");
      expect(inspectClaudeMemoryWakeHook(root)).toMatchObject({
        configured: false,
        reason: "settings_invalid",
      });
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({ hooks: { PreToolUse: [{ command: "claude-memory-wake" }] } }),
        "utf8",
      );
      expect(inspectClaudeMemoryWakeHook(root)).toMatchObject({
        configured: false,
        reason: "stop_hook_missing",
      });
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ command: "node", args: ["hook", "claude-memory-wake"] }] }] },
        }),
        "utf8",
      );
      expect(inspectClaudeMemoryWakeHook(root)).toMatchObject({ configured: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMBACKLOG-005: publishはdelivery成功と表現せずpending監査を残す", () => {
    const root = fixture();
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const path = publishClaudeInboxEntry(
        root,
        buildClaudeInboxEntry({
          memory,
          operationId: "audit-pending",
          workspaceId: claudeWorkspaceId(root),
        }),
      );
      expect(existsSync(path)).toBe(true);
      const log = readFileSync(join(root, ".ut-tdd", "logs", "claude-memory-wake.jsonl"), "utf8");
      const event = JSON.parse(log.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
      expect(event.deliveryState).toBe("pending");
      expect(event.deliveryConfirmed).toBe(false);
      expect(event.warningCodes).toContain("hook_missing");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("delivery is unconfirmed"));
    } finally {
      warning.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMBACKLOG-006: oldest ageが15分を超えたらage warningを出す", () => {
    const root = fixture();
    try {
      const workspaceId = claudeWorkspaceId(root);
      publishClaudeInboxEntry(
        root,
        buildClaudeInboxEntry({
          memory,
          operationId: "age",
          workspaceId,
          now: "2020-01-01T00:00:00.000Z",
        }),
      );
      const summary = summarizeUnclaimedInbox(root, workspaceId);
      expect(summary.warningCodes).toContain("age");
      const database = openHarnessDb(":memory:");
      try {
        migrate(database);
        const rendered = renderSessionStartDigest(
          selectSessionStartDigest(database, [], { memory: [], unclaimedInbox: summary }),
        );
        expect(rendered).toContain("inbox warning: age");
      } finally {
        database.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
