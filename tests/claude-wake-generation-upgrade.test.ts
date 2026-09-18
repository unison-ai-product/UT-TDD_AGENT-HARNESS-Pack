import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../src/memory/index.ts";
import {
  buildClaudeProviderInboxEntry,
  claudeWorkspaceId,
  publishClaudeInboxEntry,
  waitForClaudeMemory,
} from "../src/runtime/claude-memory-wake.ts";
import {
  activateClaudeWakeGeneration,
  CLAUDE_WAKE_CAPABILITY_SCHEMA,
  CLAUDE_WAKE_GENERATION_SCHEMA,
  inspectClaudeWakeGeneration,
  parseClaudeWakeCapability,
  parseClaudeWakeGeneration,
  resolveRequiredClaudeWakeCapability,
  validateClaudeWakeClaimAuthority,
} from "../src/runtime/claude-wake-generation-upgrade.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import {
  admitHistoricalFixturePayload,
  type ClaudeWakeUpgradeFixtureIdentity,
  fixtureIdentityMatches,
} from "./support/claude-wake-upgrade-fixture.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";

const workspaceId = "a".repeat(64);
const runtimeSourceRevision = "1".repeat(40);

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "ut-tdd-claude-generation-upgrade-"));
}

function gitFixture(): string {
  const root = fixture();
  ensureTrackedProjectIdentity(root, "fixture/claude-wake-generation");
  return root;
}

function wakeRuntimeRoot(root: string): string {
  const project = resolveProjectMemoryRoot(root);
  if (!project.ok) throw new Error(project.reason);
  return join(project.runtimeBusRoot, "claude-memory-wake");
}

function digest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function generation(generationId = "generation-1") {
  return {
    schema: CLAUDE_WAKE_GENERATION_SCHEMA,
    generation: generationId,
    workspaceId,
    inboxSchema: "ut-tdd.claude-inbox/v3" as const,
  };
}

describe("Claude wake generation rolling upgrade", () => {
  it("U-CHSCHEMA-001 U-CHSCHEMA-002: generation/profile are closed records", () => {
    const marker = generation();
    expect(parseClaudeWakeGeneration(JSON.stringify(marker))).toEqual(marker);
    expect(parseClaudeWakeGeneration(JSON.stringify({ ...marker, unknown: true }))).toBeUndefined();
    expect(
      parseClaudeWakeGeneration(JSON.stringify({ ...marker, workspaceId: undefined })),
    ).toBeUndefined();

    const markerBytes = `${JSON.stringify(marker)}\n`;
    const required = resolveRequiredClaudeWakeCapability();
    const profile = {
      schema: CLAUDE_WAKE_CAPABILITY_SCHEMA,
      generation: marker.generation,
      workspaceId,
      markerDigest: digest(markerBytes),
      runtimeSourceRevision,
      capabilityRevision: required.minimumCompatibleRevision,
      policyDigest: required.requiredPolicyDigest,
      authorityEpoch: 1,
    };
    expect(parseClaudeWakeCapability(JSON.stringify(profile))).toEqual(profile);
    expect(parseClaudeWakeCapability(JSON.stringify({ ...profile, extra: 1 }))).toBeUndefined();
    expect(
      parseClaudeWakeCapability(JSON.stringify({ ...profile, authorityEpoch: 0 })),
    ).toBeUndefined();
  });

  it("U-CHSCHEMA-004 U-CHSCHEMA-007 U-CHSCHEMA-010: legacy marker is preserved as typed handoff and one generation becomes active", () => {
    const root = fixture();
    try {
      writeFileSync(join(root, "old.generation"), "8992:1787797435601\n", "utf8");
      const activated = activateClaudeWakeGeneration({
        root,
        sessionId: "current",
        workspaceId,
        generation: "generation-2",
        runtimeSourceRevision,
        leaseToken: "lease-current",
      });
      expect(activated.ok).toBe(true);
      expect(readdirSync(root).filter((name) => name.endsWith(".generation"))).toEqual([
        "current.generation",
      ]);
      expect(existsSync(join(root, "superseded", "1-old.generation"))).toBe(true);
      const handoffs = readdirSync(join(root, "handoffs"));
      expect(handoffs).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(root, "handoffs", handoffs[0]), "utf8"))).toMatchObject({
        state: "restart_required",
        reason: "legacy_generation_marker",
        workspaceId,
      });
      expect(inspectClaudeWakeGeneration(root, workspaceId)).toMatchObject({
        ok: true,
        generation: "generation-2",
        authorityEpoch: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CHSCHEMA-003 U-CHSCHEMA-006 U-CHSCHEMA-008: multiple or foreign active generations fail closed before mutation", () => {
    const root = fixture();
    try {
      for (const id of ["one", "two"]) {
        writeFileSync(
          join(root, `${id}.generation`),
          `${JSON.stringify(generation(id))}\n`,
          "utf8",
        );
      }
      const before = readdirSync(root).sort();
      expect(
        activateClaudeWakeGeneration({
          root,
          sessionId: "next",
          workspaceId,
          generation: "next-generation",
          runtimeSourceRevision,
          leaseToken: "lease-next",
        }),
      ).toEqual({ ok: false, reason: "multiple_active_generations" });
      expect(readdirSync(root).sort()).toEqual(before);

      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "foreign.generation"),
        `${JSON.stringify({ ...generation("foreign"), workspaceId: "b".repeat(64) })}\n`,
        "utf8",
      );
      expect(
        activateClaudeWakeGeneration({
          root,
          sessionId: "next",
          workspaceId,
          generation: "next-generation",
          runtimeSourceRevision,
          leaseToken: "lease-next",
        }),
      ).toEqual({ ok: false, reason: "foreign_workspace_generation" });
      expect(readdirSync(root)).toEqual(["foreign.generation"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CHSCHEMA-005 U-CHSCHEMA-011: policy compatibility and current epoch/token are an AND gate", () => {
    const root = fixture();
    try {
      const first = activateClaudeWakeGeneration({
        root,
        sessionId: "one",
        workspaceId,
        generation: "generation-1",
        runtimeSourceRevision,
        leaseToken: "lease-one",
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(validateClaudeWakeClaimAuthority(root, first.authority, "lease-one")).toEqual({
        ok: true,
      });

      const second = activateClaudeWakeGeneration({
        root,
        sessionId: "two",
        workspaceId,
        generation: "generation-2",
        runtimeSourceRevision: "2".repeat(40),
        leaseToken: "lease-two",
      });
      expect(second.ok).toBe(true);
      expect(validateClaudeWakeClaimAuthority(root, first.authority, "lease-one")).toEqual({
        ok: false,
        reason: "claim_authority_revoked",
      });
      if (!second.ok) return;
      expect(validateClaudeWakeClaimAuthority(root, second.authority, "wrong-token")).toEqual({
        ok: false,
        reason: "claim_lease_token_mismatch",
      });

      const profilePath = join(root, "capabilities", "two.capability.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      writeFileSync(
        profilePath,
        `${JSON.stringify({ ...profile, policyDigest: `sha256:${"0".repeat(64)}` })}\n`,
      );
      expect(inspectClaudeWakeGeneration(root, workspaceId)).toEqual({
        ok: false,
        reason: "capability_policy_mismatch",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CHSCHEMA-009: interrupted activation rolls back before replay", () => {
    const root = fixture();
    try {
      const first = activateClaudeWakeGeneration({
        root,
        sessionId: "one",
        workspaceId,
        generation: "generation-1",
        runtimeSourceRevision,
        leaseToken: "lease-one",
      });
      expect(first.ok).toBe(true);
      expect(() =>
        activateClaudeWakeGeneration({
          root,
          sessionId: "two",
          workspaceId,
          generation: "generation-2",
          runtimeSourceRevision,
          leaseToken: "lease-two",
          beforeStep: (step) => {
            if (step === "marker_written") throw new Error("injected_crash");
          },
        }),
      ).toThrow("injected_crash");

      const replay = activateClaudeWakeGeneration({
        root,
        sessionId: "two",
        workspaceId,
        generation: "generation-2",
        runtimeSourceRevision,
        leaseToken: "lease-two",
      });
      expect(replay.ok).toBe(true);
      expect(inspectClaudeWakeGeneration(root, workspaceId)).toMatchObject({
        ok: true,
        generation: "generation-2",
        authorityEpoch: 3,
      });

      expect(() =>
        activateClaudeWakeGeneration({
          root,
          sessionId: "three",
          workspaceId,
          generation: "generation-3",
          runtimeSourceRevision,
          leaseToken: "lease-three",
          beforeStep: (step) => {
            if (step === "journal_planned") throw new Error("injected_pre_supersede_crash");
          },
        }),
      ).toThrow("injected_pre_supersede_crash");
      expect(inspectClaudeWakeGeneration(root, workspaceId)).toMatchObject({
        ok: true,
        generation: "generation-2",
        authorityEpoch: 3,
      });
      expect(
        activateClaudeWakeGeneration({
          root,
          sessionId: "three",
          workspaceId,
          generation: "generation-3",
          runtimeSourceRevision,
          leaseToken: "lease-three",
        }).ok,
      ).toBe(true);
      const journals = readdirSync(join(root, "activation-journal")).map((name) =>
        JSON.parse(readFileSync(join(root, "activation-journal", name), "utf8")),
      );
      expect(journals.map((entry) => entry.state)).toEqual([
        "active",
        "rolled_back",
        "active",
        "rolled_back",
        "active",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CHSCHEMA-009: retention does not orphan a planned activation rollback", async () => {
    const repoRoot = gitFixture();
    try {
      const root = wakeRuntimeRoot(repoRoot);
      mkdirSync(root, { recursive: true });
      expect(
        activateClaudeWakeGeneration({
          root,
          sessionId: "retained",
          workspaceId: claudeWorkspaceId(repoRoot),
          generation: "retained-generation",
          runtimeSourceRevision,
          leaseToken: "retained-lease",
        }).ok,
      ).toBe(true);
      expect(() =>
        activateClaudeWakeGeneration({
          root,
          sessionId: "interrupted",
          workspaceId: claudeWorkspaceId(repoRoot),
          generation: "interrupted-generation",
          runtimeSourceRevision,
          leaseToken: "interrupted-lease",
          beforeStep: (step) => {
            if (step === "journal_planned") throw new Error("injected_planned_crash");
          },
        }),
      ).toThrow("injected_planned_crash");

      const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
      utimesSync(join(root, "retained.generation"), expired, expired);
      const result = await waitForClaudeMemory({
        repoRoot,
        sessionId: "replacement",
        pollIntervalMs: 10,
        maxWaitMs: 20,
      });

      expect(result.kind).toBe("timeout");
      expect(inspectClaudeWakeGeneration(root, claudeWorkspaceId(repoRoot))).toMatchObject({
        ok: true,
        authority: { sessionId: "replacement" },
      });
      const journals = readdirSync(join(root, "activation-journal")).map((name) =>
        JSON.parse(readFileSync(join(root, "activation-journal", name), "utf8")),
      );
      expect(journals.some((entry) => entry.state === "rolled_back")).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-CHSCHEMA-012 U-CHSCHEMA-013 U-CHSCHEMA-015 U-CHSCHEMA-016: captured claims remain immutable and claimed replay creates no inbox", async () => {
    const captureRoot = join(
      process.cwd(),
      "tests",
      "fixtures",
      "claude-hook-schema-rolling-upgrade",
    );
    const inventory = JSON.parse(readFileSync(join(captureRoot, "inventory.json"), "utf8"));
    expect(existsSync(join(captureRoot, "pr-423-envelope.json"))).toBe(false);
    expect(
      admitHistoricalFixturePayload({
        ...inventory.observations.find((observation: { pr: number }) => observation.pr === 423),
        requestedEnvelope: "pr-423-envelope.json",
      }),
    ).toEqual({ ok: false, reason: "historical_payload_unavailable" });
    for (const observation of inventory.observations) {
      for (const kind of ["request", "claim"] as const) {
        expect(digest(readFileSync(join(captureRoot, observation[kind]), "utf8"))).toBe(
          `sha256:${observation[`${kind}Sha256`]}`,
        );
      }
    }

    const root = gitFixture();
    try {
      const memory: MemoryEntry = {
        memory_id: "memory:fixture:claude-hook-schema-unclaimed-v1",
        kind: "project",
        title: "fixture-only unclaimed envelope",
        body: "fixture identity does not copy production payload",
        tags: ["fixture"],
        source_path: ".ut-tdd/memory/fixture-claude-hook-schema.md",
        updated_at: "2026-08-28T00:00:00.000Z",
        content_hash: "c".repeat(64),
      };
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const entry = buildClaudeProviderInboxEntry({
        memory,
        projectId: project.projectId,
        producer: { provider: "codex", sessionId: "fixture-producer" },
        target: { scope: "session", provider: "claude", sessionId: "fixture-claude-session-v1" },
        operationId: "fixture-unclaimed-consume-v1",
        workspaceId: claudeWorkspaceId(root),
      });
      publishClaudeInboxEntry(root, entry);
      expect(
        await waitForClaudeMemory({
          repoRoot: root,
          sessionId: "fixture-claude-session-v1",
          pollIntervalMs: 10,
          maxWaitMs: 100,
        }),
      ).toMatchObject({ kind: "delivered", entry: { id: entry.id } });

      const runtime = wakeRuntimeRoot(root);
      const inbox = join(runtime, "inbox");
      const before = existsSync(inbox) ? readdirSync(inbox) : [];
      const replayPath = publishClaudeInboxEntry(root, entry);
      expect(replayPath.endsWith(".claim")).toBe(true);
      expect(existsSync(inbox) ? readdirSync(inbox) : []).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CHSCHEMA-011: authority revocation between validation and claim commit writes no claim", async () => {
    const root = gitFixture();
    let clockMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    try {
      const memory: MemoryEntry = {
        memory_id: "memory:fixture:claim-cas-revocation",
        kind: "project",
        title: "claim CAS revocation",
        body: "revocation must win",
        tags: ["fixture"],
        source_path: ".ut-tdd/memory/fixture-claim-cas-revocation.md",
        updated_at: "2026-08-28T00:00:00.000Z",
        content_hash: "d".repeat(64),
      };
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(project.reason);
      const entry = buildClaudeProviderInboxEntry({
        memory,
        projectId: project.projectId,
        producer: { provider: "codex", sessionId: "fixture-producer" },
        target: { scope: "session", provider: "claude", sessionId: "old-session" },
        operationId: "claim-cas-revocation",
        workspaceId: claudeWorkspaceId(root),
      });
      publishClaudeInboxEntry(root, entry);
      let revoked = false;
      const result = await waitForClaudeMemory({
        repoRoot: root,
        sessionId: "old-session",
        pollIntervalMs: 10,
        maxWaitMs: 5_000,
        // Git validation latency is not the oracle; only poll advances time.
        now: () => new Date(clockMs).toISOString(),
        sleep: async (ms) => {
          clockMs += ms;
        },
        beforeClaimCommit: () => {
          if (revoked) return;
          revoked = true;
          activateClaudeWakeGeneration({
            root: wakeRuntimeRoot(root),
            sessionId: "replacement-session",
            workspaceId: claudeWorkspaceId(root),
            generation: "replacement-generation",
            runtimeSourceRevision,
            leaseToken: "replacement-lease",
          });
        },
      });
      expect(revoked).toBe(true);
      expect(result).toEqual({ kind: "superseded" });
      const runtime = wakeRuntimeRoot(root);
      expect(readdirSync(runtime).filter((name) => name.endsWith(".claim"))).toEqual([]);
      expect(readdirSync(join(runtime, "inbox"))).toHaveLength(1);
    } finally {
      clock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CHSCHEMA-014: every fixture identity axis is independently bound", () => {
    const expected = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "tests",
          "fixtures",
          "claude-hook-schema-rolling-upgrade",
          "fixture-unclaimed-request.json",
        ),
        "utf8",
      ),
    ) as ClaudeWakeUpgradeFixtureIdentity;
    expect(fixtureIdentityMatches(expected, expected)).toBe(true);
    const mutations: Record<keyof ClaudeWakeUpgradeFixtureIdentity, string> = {
      projectId: "fixture/foreign",
      memoryId: "memory:fixture:foreign",
      operationId: "foreign-operation",
      producerProvider: "foreign",
      consumerProvider: "foreign",
      sessionId: "foreign-session",
      exactHead: "5".repeat(40),
      reviewRevision: `rv1-${"6".repeat(64)}`,
    };
    for (const [axis, value] of Object.entries(mutations)) {
      expect(
        fixtureIdentityMatches(
          { ...expected, [axis]: value } as ClaudeWakeUpgradeFixtureIdentity,
          expected,
        ),
        axis,
      ).toBe(false);
    }
  });
});
