import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  CLAUDE_WAKE_GENERATION_SCHEMA,
  claudeWorkspaceId,
  inspectClaudeMemoryWakeHook,
  publishClaudeInboxEntry,
  summarizeUnclaimedInbox,
  waitForClaudeMemory,
} from "../src/runtime/claude-memory-wake.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";

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
