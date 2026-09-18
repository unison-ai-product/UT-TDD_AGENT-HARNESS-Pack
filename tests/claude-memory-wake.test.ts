import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/memory/index.ts";
import {
  buildClaudeInboxEntry,
  buildClaudeProviderInboxEntry,
  buildClaudeProviderReviewInboxEntry,
  buildClaudeReviewInboxEntry,
  CLAUDE_INBOX_SCHEMA,
  CLAUDE_WAKE_GENERATION_SCHEMA,
  claudeWorkspaceId,
  computeClaudeProviderEntryId,
  computeClaudeProviderEnvelopeDigest,
  isClaudeMemoryWakeTarget,
  publishClaudeInboxEntry,
  renderClaudeWakeMessage,
  resolveClaudeWakeDelay,
  resolveLiveClaudeWorkspace,
  summarizeUnclaimedInbox,
  validateClaudeProviderEnvelope,
  waitForClaudeMemory,
} from "../src/runtime/claude-memory-wake.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";

const memory: MemoryEntry = {
  memory_id: "memory:project:review-218",
  kind: "project",
  title: "review 218",
  body: "Issue #218をレビューする。",
  tags: ["claude"],
  source_path: ".ut-tdd/memory/project-review-218.md",
  updated_at: "2026-08-03T09:00:00.000Z",
  content_hash: "a".repeat(64),
};

function inboxFileStem(entryId: string): string {
  const safeId = entryId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return `${safeId.slice(0, 147)}_${createHash("sha256").update(entryId).digest("hex").slice(0, 12)}`;
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-claude-wake-"));
  ensureTrackedProjectIdentity(root, "fixture/claude-memory-wake");
  return root;
}

function wakeRuntimeRoot(root: string): string {
  const project = resolveProjectMemoryRoot(root);
  if (!project.ok) throw new Error(project.reason);
  return join(project.runtimeBusRoot, "claude-memory-wake");
}

describe("Claude HARNESS memory async wake", () => {
  it("U-PMEMROOT-007: provider envelope rejects each binding axis independently", async () => {
    const root = fixture();
    try {
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const entry = buildClaudeProviderInboxEntry({
        memory,
        projectId: project.projectId,
        operationId: "pmemroot-007",
        workspaceId: claudeWorkspaceId(root),
        producer: { provider: "codex", sessionId: "codex-session" },
        target: { scope: "session", provider: "claude", sessionId: "claude-session" },
      });
      const expected = {
        projectId: project.projectId,
        memoryId: memory.memory_id,
        operationId: "pmemroot-007",
        producer: { provider: "codex" as const, sessionId: "codex-session" },
        target: {
          scope: "session" as const,
          provider: "claude" as const,
          sessionId: "claude-session",
        },
      };
      const mutations = [
        ["project_id", { ...entry, projectId: "foreign/project" }],
        ["memory_id", { ...entry, memoryId: "memory:project:foreign" }],
        ["operation_id", { ...entry, operationId: "different-operation" }],
        [
          "producer_provider",
          { ...entry, producer: { ...entry.producer, provider: "claude" as const } },
        ],
        [
          "producer_session",
          { ...entry, producer: { ...entry.producer, sessionId: "other-producer" } },
        ],
        ["target_provider", { ...entry, target: { ...entry.target, provider: "codex" as const } }],
        ["target_session", { ...entry, target: { ...entry.target, sessionId: "other-target" } }],
      ] as const;
      let entryPath = publishClaudeInboxEntry(root, entry);
      const bindingPath = join(
        wakeRuntimeRoot(root),
        "envelope-bindings",
        `${inboxFileStem(entry.id)}.json`,
      );
      expect(existsSync(bindingPath)).toBe(true);
      for (const [axis, mutated] of mutations) {
        const reboundFields = {
          ...mutated,
          envelopeDigest: computeClaudeProviderEnvelopeDigest(mutated),
        };
        const rebound = {
          ...reboundFields,
          // Keep the immutable inbox filename stable so the consumer reaches
          // the publisher-owned sidecar and reports the semantic axis.
          id: entry.id,
        };
        const result = validateClaudeProviderEnvelope(rebound, expected);
        expect(result.ok, axis).toBe(false);
        if (!result.ok) expect(result.reason, axis).toBe(`${axis}_mismatch`);
        rmSync(entryPath);
        entryPath = join(wakeRuntimeRoot(root), "inbox", `${inboxFileStem(entry.id)}.json`);
        writeFileSync(entryPath, `${JSON.stringify(rebound)}\n`, "utf8");
        const wake = await waitForClaudeMemory({
          repoRoot: root,
          sessionId: "claude-session",
          provider: "claude",
          pollIntervalMs: 10,
          maxWaitMs: 30,
        });
        expect(wake.kind, axis).toBe("denied");
        expect(wake.reason, axis).toBe(`${axis}_mismatch`);
        expect(existsSync(entryPath), axis).toBe(true);
        expect(
          existsSync(join(wakeRuntimeRoot(root), `${inboxFileStem(rebound.id)}.claim`)),
          axis,
        ).toBe(false);
        expect(existsSync(bindingPath), axis).toBe(true);
      }
      const spoofFields = {
        ...entry,
        memoryId: "memory:project:spoofed",
      };
      const spoof = {
        ...spoofFields,
        envelopeDigest: computeClaudeProviderEnvelopeDigest(spoofFields),
      };
      spoof.id = computeClaudeProviderEntryId(spoof);
      rmSync(entryPath);
      const spoofPath = join(wakeRuntimeRoot(root), "inbox", `${inboxFileStem(spoof.id)}.json`);
      writeFileSync(spoofPath, `${JSON.stringify(spoof)}\n`, "utf8");
      const spoofWake = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "claude-session",
        provider: "claude",
        pollIntervalMs: 10,
        maxWaitMs: 30,
      });
      expect(spoofWake.kind).toBe("denied");
      expect(spoofWake.reason).toBe("envelope_binding_missing");
      expect(existsSync(spoofPath)).toBe(true);
      expect(existsSync(bindingPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PMEMROOT-007 review composition: v4 review claims through the same guard", async () => {
    const root = fixture();
    try {
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const digest = "e".repeat(16);
      const entry = buildClaudeProviderReviewInboxEntry({
        memory,
        projectId: project.projectId,
        operationId: "review-pmemroot-007",
        workspaceId: claudeWorkspaceId(root),
        producer: { provider: "codex", sessionId: "codex-review" },
        target: { scope: "session", provider: "claude", sessionId: "claude-review" },
        requestDigest: digest,
        requestPath: `.ut-tdd/review/requests/${digest}.json`,
        pr: 528,
        exactHead: "f".repeat(40),
        reviewRevision: "pmemroot-007-r1",
        authorFamily: "codex",
      });
      const path = publishClaudeInboxEntry(root, entry);
      const result = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "claude-review",
        provider: "claude",
        pollIntervalMs: 10,
        maxWaitMs: 30,
      });
      expect(result.kind).toBe("delivered");
      expect(result.entry?.purpose).toBe("review");
      expect(existsSync(path)).toBe(false);
      expect(
        existsSync(
          join(wakeRuntimeRoot(root), "envelope-bindings", `${inboxFileStem(entry.id)}.json`),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-007: live-dispatch from a subject worktree resolves the active main workspace", () => {
    const main = fixture();
    const subject = mkdtempSync(join(tmpdir(), "ut-tdd-claude-wake-subject-"));
    try {
      writeFileSync(join(main, "README.md"), "fixture\n", "utf8");
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: main });
      execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: main });
      execFileSync("git", ["add", "README.md"], { cwd: main });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: main });
      execFileSync("git", ["worktree", "add", "-q", "-b", "subject", subject, "HEAD"], {
        cwd: main,
      });

      const mainWorkspaceId = claudeWorkspaceId(main);
      const runtime = wakeRuntimeRoot(main);
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, "main-vscode.generation"),
        `${JSON.stringify({
          schema: CLAUDE_WAKE_GENERATION_SCHEMA,
          generation: "main-live",
          workspaceId: mainWorkspaceId,
          inboxSchema: CLAUDE_INBOX_SCHEMA,
        })}\n`,
        "utf8",
      );

      expect(resolveLiveClaudeWorkspace(subject)).toEqual({
        ok: true,
        workspaceId: mainWorkspaceId,
      });
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", subject], { cwd: main });
      rmSync(subject, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });

  it.each([
    ["no live workspace", "no_live_claude_workspace"],
    ["stale workspace", "stale_claude_workspace"],
    ["incompatible workspace schema", "incompatible_claude_workspace_schema"],
  ] as const)("U-MEMWAKE-007: %s is typed fail-close", (_label, reason) => {
    const root = fixture();
    try {
      const runtime = wakeRuntimeRoot(root);
      if (reason !== "no_live_claude_workspace") {
        mkdirSync(runtime, { recursive: true });
        writeFileSync(
          join(runtime, "session.generation"),
          `${JSON.stringify({
            schema: CLAUDE_WAKE_GENERATION_SCHEMA,
            generation: "session",
            workspaceId: claudeWorkspaceId(root),
            ...(reason === "incompatible_claude_workspace_schema"
              ? { inboxSchema: "ut-tdd.claude-inbox/v2" }
              : { inboxSchema: CLAUDE_INBOX_SCHEMA }),
          })}\n`,
          "utf8",
        );
        if (reason === "stale_claude_workspace") {
          const old = new Date(Date.now() - 16 * 60 * 1_000);
          utimesSync(join(runtime, "session.generation"), old, old);
        }
      }
      expect(resolveLiveClaudeWorkspace(root)).toMatchObject({ ok: false, reason });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-007: multiple live workspace targets are typed ambiguous", () => {
    const root = fixture();
    try {
      const runtime = wakeRuntimeRoot(root);
      mkdirSync(runtime, { recursive: true });
      for (const [name, workspaceId] of [
        ["main", "a".repeat(64)],
        ["subject", "b".repeat(64)],
      ] as const) {
        writeFileSync(
          join(runtime, `${name}.generation`),
          `${JSON.stringify({
            schema: CLAUDE_WAKE_GENERATION_SCHEMA,
            generation: name,
            workspaceId,
            inboxSchema: CLAUDE_INBOX_SCHEMA,
          })}\n`,
          "utf8",
        );
      }
      expect(resolveLiveClaudeWorkspace(root)).toEqual({
        ok: false,
        reason: "ambiguous_live_claude_workspace",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-023: producerはv3 memoryを発行し、review文言をtyped reviewへ昇格しない", () => {
    const entry = buildClaudeInboxEntry({
      memory: { ...memory, body: "PR #218 review request", tags: ["review", "claude"] },
      operationId: "memory-review-text",
      workspaceId: "a".repeat(64),
    });
    expect(entry).toMatchObject({ schemaVersion: "ut-tdd.claude-inbox/v3", purpose: "memory" });
    expect(entry).not.toHaveProperty("requestDigest");
  });

  it("U-RVATT-023: typed reviewはcanonical request identityを必須fieldへ束縛する", () => {
    const entry = buildClaudeReviewInboxEntry({
      memory,
      operationId: "review-218-head",
      workspaceId: "a".repeat(64),
      requestDigest: "b".repeat(16),
      requestPath: `.ut-tdd/review/requests/${"b".repeat(16)}.json`,
      pr: 218,
      exactHead: "c".repeat(40),
      reviewRevision: "review-218-r1",
      authorFamily: "codex",
    });
    expect(entry).toMatchObject({
      schemaVersion: "ut-tdd.claude-inbox/v3",
      purpose: "review",
      memoryPath: memory.source_path,
      pr: 218,
      exactHead: "c".repeat(40),
      authorFamily: "codex",
    });
    expect(renderClaudeWakeMessage(entry)).toContain('"purpose":"review"');
  });

  it("U-RVATT-023: invalid review identityはmemoryへdowngradeせず拒否する", () => {
    expect(() =>
      buildClaudeReviewInboxEntry({
        memory,
        operationId: "invalid-review",
        workspaceId: "a".repeat(64),
        requestDigest: "not-a-digest",
        requestPath: "request.json",
        pr: 218,
        exactHead: "c".repeat(40),
        reviewRevision: "review-218-r1",
        authorFamily: "codex",
      }),
    ).toThrow("claude_inbox_review_identity_invalid");
  });

  it("U-RVATT-025: v2はmemory互換だけ、unknown/invalid v3はfail-closeする", async () => {
    const root = fixture();
    try {
      const workspaceId = claudeWorkspaceId(root);
      const v3 = buildClaudeInboxEntry({ memory, operationId: "schema-seed", workspaceId });
      const inbox = join(wakeRuntimeRoot(root), "inbox");
      publishClaudeInboxEntry(root, v3);
      rmSync(join(inbox, `${inboxFileStem(v3.id)}.json`));
      const legacy = { ...v3, schemaVersion: "ut-tdd.claude-inbox/v2" } as Record<string, unknown>;
      delete legacy.purpose;
      writeFileSync(join(inbox, "legacy.json"), `${JSON.stringify(legacy)}\n`, "utf8");
      writeFileSync(
        join(inbox, "unknown.json"),
        `${JSON.stringify({ ...v3, schemaVersion: "ut-tdd.claude-inbox/v99" })}\n`,
        "utf8",
      );
      writeFileSync(
        join(inbox, "invalid-review.json"),
        `${JSON.stringify({ ...v3, purpose: "review" })}\n`,
        "utf8",
      );
      const result = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "legacy-only",
        pollIntervalMs: 10,
        maxWaitMs: 30,
      });
      expect(result.kind).toBe("denied");
      expect(result.reason).toBe("legacy_schema_unbound");
      expect(result.entry).toMatchObject({
        schemaVersion: "ut-tdd.claude-inbox/v2",
        purpose: "memory",
      });
      expect(existsSync(join(inbox, "legacy.json"))).toBe(true);
      const noInvalidFallback = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "invalid-not-memory",
        pollIntervalMs: 10,
        maxWaitMs: 20,
      });
      expect(noInvalidFallback.kind).toBe("denied");
      expect(noInvalidFallback.reason).toBe("legacy_schema_unbound");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-025: retryは同じpurpose別operation identityへ収束する", () => {
    const root = fixture();
    try {
      const input = {
        memory,
        operationId: "review-idempotent",
        workspaceId: claudeWorkspaceId(root),
        requestDigest: "d".repeat(16),
        requestPath: `.ut-tdd/review/requests/${"d".repeat(16)}.json`,
        pr: 218,
        exactHead: "e".repeat(40),
        reviewRevision: "review-idempotent-r1",
        authorFamily: "codex" as const,
        now: "2026-08-14T00:00:00.000Z",
      };
      const first = buildClaudeReviewInboxEntry(input);
      const second = buildClaudeReviewInboxEntry(input);
      expect(first.id).toBe(second.id);
      expect(publishClaudeInboxEntry(root, first)).toBe(publishClaudeInboxEntry(root, second));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "docs/plans/evil.md",
    "src/cli.ts",
    ".git/config",
    "../outside.md",
  ])("U-RVATT-024: review envelopeのmemoryPath %s はcanonical memory外として拒否する", (memoryPath) => {
    expect(() =>
      buildClaudeReviewInboxEntry({
        memory: { ...memory, source_path: memoryPath },
        operationId: "review-path-boundary",
        workspaceId: "a".repeat(64),
        requestDigest: "d".repeat(16),
        requestPath: `.ut-tdd/review/requests/${"d".repeat(16)}.json`,
        pr: 218,
        exactHead: "e".repeat(40),
        reviewRevision: "review-path-r1",
        authorFamily: "codex",
      }),
    ).toThrow("claude_inbox_review_identity_invalid");
  });

  it("U-MEMWAKE-006: VS Code extension entrypointだけをpositiveにwake対象化する", () => {
    expect(isClaudeMemoryWakeTarget({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" })).toBe(true);
    expect(isClaudeMemoryWakeTarget({})).toBe(false);
    expect(isClaudeMemoryWakeTarget({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(false);
    expect(
      isClaudeMemoryWakeTarget({
        CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
        UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE: "1",
      }),
    ).toBe(false);
  });

  it("U-MEMWAKE-001: Git共通dirの通知を同一sessionへ一度だけ配送する", async () => {
    const root = fixture();
    try {
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "218-head",
        workspaceId: claudeWorkspaceId(root),
      });
      const path = publishClaudeInboxEntry(root, entry);
      expect(path).toContain(join("ut-tdd-runtime", "projects"));
      expect(path).toContain(join("claude-memory-wake", "inbox"));
      const first = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "claude-live",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 20,
      });
      const second = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "claude-live",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 20,
      });
      expect(first.kind).toBe("delivered");
      expect(second.kind).toBe("timeout");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-004: Git共通dirを解決できないrootは通知成功にしない", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-claude-wake-no-git-"));
    try {
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "no-git",
        workspaceId: "a".repeat(64),
      });
      expect(() => publishClaudeInboxEntry(root, entry)).toThrow(
        "project_memory_root_git_topology_unavailable",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-005: 非数値または非正の待機値をfail-closeする", async () => {
    const root = fixture();
    try {
      await expect(
        waitForClaudeMemory({ repoRoot: root, sessionId: "invalid", pollIntervalMs: Number.NaN }),
      ).rejects.toThrow("claude_wake_poll_interval_invalid");
      await expect(
        waitForClaudeMemory({ repoRoot: root, sessionId: "invalid", maxWaitMs: 0 }),
      ).rejects.toThrow("claude_wake_max_wait_invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-005: 未設定と空白envは既定値へ戻し、非空値だけを数値化する", () => {
    expect(resolveClaudeWakeDelay(undefined, 2_000)).toBe(2_000);
    expect(resolveClaudeWakeDelay("", 2_000)).toBe(2_000);
    expect(resolveClaudeWakeDelay("  ", 900_000)).toBe(900_000);
    expect(resolveClaudeWakeDelay("25", 2_000)).toBe(25);
    expect(resolveClaudeWakeDelay("invalid", 2_000)).toBeNaN();
  });

  it("U-MEMWAKE-002: 同一operationは冪等、異内容は競合として拒否する", () => {
    const root = fixture();
    try {
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "218-head",
        workspaceId: claudeWorkspaceId(root),
        now: "2026-08-03T09:00:00.000Z",
      });
      const path = publishClaudeInboxEntry(root, entry);
      expect(publishClaudeInboxEntry(root, entry)).toBe(path);
      expect(() => publishClaudeInboxEntry(root, { ...entry, body: "forged" })).toThrow(
        "claude_inbox_projection_conflict",
      );
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entry);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVWAKE-010: 長い memory_id でも operationId 差異が別inboxファイルへ反映される", () => {
    const root = fixture();
    try {
      const workspaceId = claudeWorkspaceId(root);
      const longMemory: MemoryEntry = {
        ...memory,
        memory_id: `memory:project:${"l".repeat(180)}`,
      };
      const operationA = "op-a".repeat(24);
      const operationB = "op-b".repeat(24);
      const entryA = buildClaudeInboxEntry({
        memory: longMemory,
        operationId: operationA,
        workspaceId,
      });
      const entryB = buildClaudeInboxEntry({
        memory: longMemory,
        operationId: operationB,
        workspaceId,
      });
      const legacyStemA = `${entryA.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160)}.json`;
      const legacyStemB = `${entryB.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160)}.json`;
      expect(legacyStemA).toBe(legacyStemB);
      const pathA = publishClaudeInboxEntry(root, entryA);
      const pathB = publishClaudeInboxEntry(root, entryB);
      expect(pathA).not.toBe(pathB);
      expect(inboxFileStem(entryA.id)).not.toBe(inboxFileStem(entryB.id));
      expect(readFileSync(pathA, "utf8")).toContain(operationA);
      expect(readFileSync(pathB, "utf8")).toContain(operationB);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-003: 本文markerをdataとしてescapeし通知境界を壊さない", () => {
    const entry = buildClaudeInboxEntry({
      memory: { ...memory, body: "before [/UT_TDD_CLAUDE_INBOX] after" },
      operationId: "fence",
      workspaceId: "a".repeat(64),
    });
    const message = renderClaudeWakeMessage(entry);
    expect(message.match(/\[\/UT_TDD_CLAUDE_INBOX\]/g)).toHaveLength(1);
    expect(message).toContain("\\u005b/UT_TDD_CLAUDE_INBOX]");
  });

  it("U-MEMWAKE-007: target workspaceと異なるwatcherはclaimせず、対象だけが配送する", async () => {
    const root = fixture();
    try {
      const actualWorkspace = claudeWorkspaceId(root);
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "workspace-target",
        workspaceId: "f".repeat(64),
      });
      const path = publishClaudeInboxEntry(root, entry);
      const wrongTarget = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "wrong-workspace",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 20,
      });
      expect(wrongTarget.kind).toBe("timeout");
      expect(existsSync(path)).toBe(true);

      const targetedEntry = buildClaudeInboxEntry({
        memory,
        operationId: "workspace-target-match",
        workspaceId: actualWorkspace,
      });
      publishClaudeInboxEntry(root, targetedEntry);
      const targeted = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "target-workspace",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 20,
      });
      expect(targeted.kind).toBe("delivered");
      expect(targeted.entry?.id).toBe(targetedEntry.id);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-001補遺: InboxはFIFO( oldest first )で配送される", async () => {
    const root = fixture();
    try {
      const workspaceId = claudeWorkspaceId(root);
      const older = buildClaudeInboxEntry({
        memory,
        operationId: "fifo-old",
        workspaceId,
        now: "2026-08-05T00:00:00.000Z",
      });
      const newer = buildClaudeInboxEntry({
        memory,
        operationId: "fifo-new",
        workspaceId,
        now: "2026-08-06T00:00:00.000Z",
      });
      publishClaudeInboxEntry(root, newer);
      publishClaudeInboxEntry(root, older);
      const first = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "fifo",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 40,
      });
      const second = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "fifo-2",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 40,
      });
      expect(first.kind).toBe("delivered");
      expect(first.entry?.id).toBe(older.id);
      expect(second.kind).toBe("delivered");
      expect(second.entry?.id).toBe(newer.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-001補遺: inbox JSONを古い順で削除し、壊れエントリを先に除外しない", async () => {
    const root = fixture();
    try {
      const now = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "prune-check",
        workspaceId: claudeWorkspaceId(root),
      });
      publishClaudeInboxEntry(root, entry);
      const stale = join(wakeRuntimeRoot(root), "inbox", "stale.json");
      writeFileSync(stale, `${JSON.stringify({ invalid: true })}\n`, "utf8");
      utimesSync(stale, now, now);

      expect(existsSync(stale)).toBe(true);
      const result = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "prune",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 40,
      });
      expect(result.kind).toBe("delivered");
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-006補遺: generation ファイル喪失は superseded として早期収束する", async () => {
    const root = fixture();
    try {
      const generation = join(wakeRuntimeRoot(root), "session-id.generation");
      const result = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "session-id",
        pollIntervalMs: 5,
        maxWaitMs: 5_000,
        sleep: async (ms: number) => {
          await new Promise<void>((resolve) => setTimeout(resolve, ms));
          rmSync(generation, { force: true });
        },
      });
      expect(result.kind).toBe("superseded");
      rmSync(generation, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-007補遺: originRuntime は未指定時に system へ既定化される", () => {
    const root = fixture();
    try {
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "origin-default",
        workspaceId: claudeWorkspaceId(root),
      });
      expect(entry.originRuntime).toBe("system");
      expect(entry.originRuntime).not.toBe("codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-008: 監査jsonlが publish / claim の証跡を残す", async () => {
    const root = fixture();
    try {
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "audit",
        workspaceId: claudeWorkspaceId(root),
      });
      publishClaudeInboxEntry(root, entry);
      await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "audit",
        allowLegacy: true,
        pollIntervalMs: 10,
        maxWaitMs: 40,
      });
      const logPath = join(root, ".ut-tdd", "logs", "claude-memory-wake.jsonl");
      const raw = readFileSync(logPath, "utf8").trim().split("\n");
      const events = raw.map((line) => JSON.parse(line)).map((row) => row.event);
      expect(events).toContain("publish");
      expect(events).toContain("claim");
      expect(events.some((row) => row === "claim")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-MEMWAKE-009: summarizeUnclaimedInbox がワークスペース別 backlog を返す", () => {
    const root = fixture();
    try {
      const workspaceId = claudeWorkspaceId(root);
      const entry = buildClaudeInboxEntry({
        memory,
        operationId: "summary-1",
        workspaceId,
        now: "2026-08-01T00:00:00.000Z",
      });
      publishClaudeInboxEntry(root, entry);
      const summary = summarizeUnclaimedInbox(root, workspaceId);
      expect(summary.pending).toBe(1);
      expect(summary.workspaceId).toBe(workspaceId);
      expect(summary.oldestEntryId).toBe(entry.id);
      expect(summary.oldestCreatedAt).toBe(entry.createdAt);
      expect(summary.oldestAgeMs).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
