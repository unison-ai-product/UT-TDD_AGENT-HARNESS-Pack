import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/memory/index.ts";
import {
  buildClaudeInboxEntry,
  buildClaudeProviderReviewInboxEntry,
  claudeWorkspaceId,
  evaluateClaudeInboxTerminal,
  parseClaudeInboxPullRequestObservation,
  publishClaudeInboxEntry,
  recoverClaudeInboxBacklog,
  summarizeUnclaimedInbox,
  waitForClaudeMemory,
} from "../src/runtime/claude-memory-wake.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";

const memory: MemoryEntry = {
  memory_id: "memory:project:terminal-gc",
  kind: "project",
  title: "terminal gc",
  body: "terminal gc",
  tags: ["claude"],
  source_path: ".ut-tdd/memory/project-terminal-gc.md",
  updated_at: "2026-08-27T00:00:00.000Z",
  content_hash: "a".repeat(64),
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-terminal-gc-"));
  ensureTrackedProjectIdentity(root, "fixture/claude-terminal-gc");
  return root;
}

function review(root: string, operationId = "review", exactHead = "c".repeat(40)) {
  const digest = "b".repeat(16);
  const project = resolveProjectMemoryRoot(root);
  if (!project.ok) throw new Error(project.reason);
  return buildClaudeProviderReviewInboxEntry({
    memory,
    projectId: project.projectId,
    operationId,
    workspaceId: claudeWorkspaceId(root),
    producer: { provider: "codex", sessionId: "codex-terminal-gc" },
    target: { scope: "session", provider: "claude", sessionId: "claude-terminal-gc" },
    requestDigest: digest,
    requestPath: `.ut-tdd/review/requests/${digest}.json`,
    pr: 444,
    exactHead,
    reviewRevision: "rv1-terminal-gc",
    authorFamily: "codex",
  });
}

describe("Claude inbox terminal GC", () => {
  it("U-MEMTERM-001: claims, merged/closed PRs, and replaced heads are typed terminal states", () => {
    const entry = review(fixture());
    expect(evaluateClaudeInboxTerminal({ entry, claimed: true })).toEqual({
      terminal: true,
      reason: "claimed",
    });
    expect(
      evaluateClaudeInboxTerminal({
        entry,
        pullRequest: { pr: 444, state: "MERGED", headSha: entry.exactHead },
      }),
    ).toMatchObject({
      terminal: true,
      reason: "pr_merged",
      receipt: { requestDigest: entry.requestDigest },
    });
    expect(
      evaluateClaudeInboxTerminal({
        entry,
        pullRequest: { pr: 444, state: "CLOSED", headSha: entry.exactHead },
      }),
    ).toMatchObject({ terminal: true, reason: "pr_closed" });
    expect(
      evaluateClaudeInboxTerminal({
        entry,
        pullRequest: { pr: 444, state: "OPEN", headSha: "d".repeat(40) },
        replacementExists: true,
      }),
    ).toMatchObject({ terminal: true, reason: "stale_head_replaced" });
  });

  it("U-MEMTERM-002: memory and legacy envelopes do not infer PR/head terminality", () => {
    const root = fixture();
    const entry = buildClaudeInboxEntry({
      memory,
      operationId: "memory",
      workspaceId: claudeWorkspaceId(root),
    });
    expect(
      evaluateClaudeInboxTerminal({
        entry,
        pullRequest: { pr: 444, state: "MERGED", headSha: "d".repeat(40) },
      }),
    ).toEqual({ terminal: false });
    expect(parseClaudeInboxPullRequestObservation(444, "{not-json")).toBeUndefined();
    expect(
      parseClaudeInboxPullRequestObservation(
        444,
        JSON.stringify({ state: "OPEN", headRefOid: "not-a-sha" }),
      ),
    ).toBeUndefined();
    expect(
      parseClaudeInboxPullRequestObservation(
        444,
        JSON.stringify({ state: "CLOSED", headRefOid: "d".repeat(40) }),
      ),
    ).toMatchObject({ pr: 444, state: "CLOSED", headSha: "d".repeat(40) });
    const legacy = { ...entry, schemaVersion: "ut-tdd.claude-inbox/v2" } as unknown as typeof entry;
    expect(
      evaluateClaudeInboxTerminal({
        entry: legacy,
        pullRequest: { pr: 444, state: "MERGED", headSha: "d".repeat(40) },
      }),
    ).toEqual({ terminal: false });
    rmSync(root, { recursive: true, force: true });
  });

  it("U-MEMTERM-003: dry-run predicts recovery and apply writes markers without deleting inbox evidence", async () => {
    const root = fixture();
    try {
      const entry = review(root);
      const path = publishClaudeInboxEntry(root, entry);
      const observation = { pr: entry.pr, state: "MERGED" as const, headSha: entry.exactHead };
      const dryRun = recoverClaudeInboxBacklog({
        repoRoot: root,
        pullRequests: [observation],
        dryRun: true,
      });
      expect(dryRun).toMatchObject({
        dryRun: true,
        terminalized: 1,
        entries: [{ reason: "pr_merged" }],
      });
      expect(dryRun.entries[0]?.markerPath).toBeUndefined();
      expect(existsSync(path)).toBe(true);
      const applied = recoverClaudeInboxBacklog({
        repoRoot: root,
        pullRequests: [observation],
        dryRun: false,
      });
      expect(applied.terminalized).toBe(1);
      expect(applied.entries[0]?.markerPath).toContain(".terminal.json");
      expect(existsSync(path)).toBe(true);
      const markerPath = applied.entries[0]?.markerPath;
      expect(markerPath).toBeDefined();
      expect(JSON.parse(readFileSync(markerPath ?? "", "utf8"))).toMatchObject({
        reason: "pr_merged",
        requestDigest: entry.requestDigest,
      });
      expect(summarizeUnclaimedInbox(root, entry.targetWorkspaceId).pending).toBe(0);

      // Retention cleanup is bounded: once the retained inbox evidence is gone,
      // an old marker cannot accumulate forever across future wake polls.
      unlinkSync(path);
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
      utimesSync(markerPath ?? "", old, old);
      await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "retention",
        pollIntervalMs: 10,
        maxWaitMs: 10,
        sleep: async () => undefined,
      });
      expect(existsSync(markerPath ?? "")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMTERM-004: poll observations are cached and terminal markers retain receipt evidence", async () => {
    const cliSource = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(cliSource).toMatch(/recoverClaudeInboxForSessionStart\(repoRoot\)/);
    expect(cliSource).toMatch(
      /pullRequestState: \(pr\) => observeClaudeInboxPullRequest\(repoRoot, pr\)/,
    );
    const root = fixture();
    try {
      const entry = review(root);
      const replacement = review(root, "replacement", "d".repeat(40));
      const path = publishClaudeInboxEntry(root, entry);
      const replacementPath = publishClaudeInboxEntry(root, replacement);
      let observationCalls = 0;
      const result = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "gc",
        pollIntervalMs: 10,
        maxWaitMs: 20,
        sleep: async () => undefined,
        pullRequestState: (pr) => {
          observationCalls += 1;
          return pr === entry.pr ? { pr, state: "MERGED", headSha: entry.exactHead } : undefined;
        },
      });
      expect(result.kind).toBe("timeout");
      expect(observationCalls).toBe(1);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(replacementPath)).toBe(true);

      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const runtime = join(project.runtimeBusRoot, "claude-memory-wake");
      const markers = readdirSync(runtime).filter((name) => name.endsWith(".terminal.json"));
      expect(markers).toHaveLength(2);
      const markerPath = markers
        .map((name) => join(runtime, name))
        .find((candidate) => {
          try {
            return JSON.parse(readFileSync(candidate, "utf8")).entryId === entry.id;
          } catch {
            return false;
          }
        });
      const marker = JSON.parse(readFileSync(markerPath ?? "", "utf8"));
      expect(marker).toMatchObject({
        reason: "pr_merged",
        requestDigest: entry.requestDigest,
        requestPath: entry.requestPath,
        memoryPath: entry.memoryPath,
        pr: entry.pr,
        exactHead: entry.exactHead,
        reviewRevision: entry.reviewRevision,
        authorFamily: entry.authorFamily,
      });
      const summary = summarizeUnclaimedInbox(root, entry.targetWorkspaceId);
      expect(summary.pending).toBe(0);
      expect(summary.terminalized).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
