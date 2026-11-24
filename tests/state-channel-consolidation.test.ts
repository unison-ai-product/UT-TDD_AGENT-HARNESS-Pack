/**
 * Issue #1062 Red oracles. Candidate IDs and expected behavior are frozen in
 * docs/test-design/harness/L7-state-channel-consolidation-test-design.md.
 * Unimplemented candidate oracles are intentionally `it.fails` until the
 * later promotion and Green PRs; 004/005 remain ordinary tests because the
 * current CLI already satisfies those acceptance cases.
 * Candidate 017 remains incomplete; these Red oracles do not claim that the
 * corresponding implementation work is complete.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildDoctorCheckDefinitionGroups } from "../src/doctor/check-definition-groups.ts";
import type { DoctorDeps } from "../src/doctor/runtime-state.ts";
import { loadCanonicalLiveReviewRequest } from "../src/feedback/live-review-projection.ts";
import { scanPostMergeBackstop } from "../src/feedback/post-merge-backstop.ts";
import { issueReviewRequest } from "../src/feedback/review-attestation.ts";
import { canonicalize, computeReviewRevision } from "../src/feedback/review-custody-canonical.ts";
import {
  issueCustodyReceipt,
  type RunnerEnvironment,
} from "../src/feedback/review-custody-runner.ts";
import { analyzeReviewDispatch } from "../src/feedback/review-dispatch.ts";
import { runPrMerge } from "../src/feedback/review-merge-gate.ts";
import { checkHandoverBypass, type HandoverDeps, readPointer } from "../src/handover/index.ts";
import type { MemoryEntry } from "../src/memory/index.ts";
import { readMemory, writeMemory } from "../src/memory/service.ts";
import { buildClaudeProviderReviewInboxEntry } from "../src/runtime/claude-provider-envelope.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import { defaultHarnessDbPath, openReadOnlyHarnessDb } from "../src/state-db/index.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { denyDirectoryRead, restoreDirectoryRead } from "./support/permission-denied-fixture.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");
const tempRoots: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-state-channel-"));
  tempRoots.push(root);
  ensureTrackedProjectIdentity(root, "example/repo");
  return root;
}

function runCli(cwd: string, args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function expectStarted(result: ReturnType<typeof runCli>): void {
  expect(result.error?.message ?? "", "CLI process must start").toBe("");
  expect(result.signal, "CLI must exit normally").toBeNull();
}

function requireDefined<T>(value: T | undefined, context: string): T {
  if (value === undefined) throw new Error(`${context}: expected a defined value`);
  return value;
}

function requireOnly<T>(values: readonly T[], context: string): T {
  if (values.length !== 1)
    throw new Error(`${context}: expected one value, received ${values.length}`);
  return requireDefined(values[0], context);
}

function notificationEnvelopeDigest(projectId: string, operationId: string): string {
  const preimage = JSON.stringify({
    schemaVersion: "ut-tdd.notification/v1",
    projectId,
    operationId,
    producer: { provider: "codex", sessionId: "producer" },
    target: { scope: "session", provider: "claude", sessionId: "target" },
  });
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function notificationFileStem(entryId: string): string {
  const safeId = entryId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  const suffix = createHash("sha256").update(entryId).digest("hex").slice(0, 12);
  return `${safeId.slice(0, 147)}_${suffix}`;
}

function writeRawNotificationEntry(
  repoRoot: string,
  entry: Record<string, unknown>,
  binding?: Record<string, unknown>,
): void {
  const project = resolveProjectMemoryRoot(repoRoot);
  if (!project.ok) throw new Error(`notification fixture project root: ${project.reason}`);
  const runtimeRoot = join(project.runtimeBusRoot, "claude-memory-wake");
  const stem = notificationFileStem(String(entry.id));
  const inbox = join(runtimeRoot, "inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, `${stem}.json`), `${JSON.stringify(entry)}\n`, "utf8");
  if (binding) {
    const bindings = join(runtimeRoot, "envelope-bindings");
    mkdirSync(bindings, { recursive: true });
    writeFileSync(join(bindings, `${stem}.json`), `${JSON.stringify(binding)}\n`, "utf8");
  }
}

function readRawNotificationEntry(repoRoot: string, operationId: string): Record<string, unknown> {
  const project = resolveProjectMemoryRoot(repoRoot);
  if (!project.ok) throw new Error(`notification fixture project root: ${project.reason}`);
  const inbox = join(project.runtimeBusRoot, "claude-memory-wake", "inbox");
  const entries = readdirSync(inbox)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(inbox, file), "utf8")) as Record<string, unknown>);
  return requireOnly(
    entries.filter((entry) => entry.operationId === operationId),
    `notification entry ${operationId}`,
  );
}

function expectNotificationClaimAbsent(repoRoot: string, entry: Record<string, unknown>): void {
  const project = resolveProjectMemoryRoot(repoRoot);
  if (!project.ok) throw new Error(`notification fixture project root: ${project.reason}`);
  const runtimeRoot = join(project.runtimeBusRoot, "claude-memory-wake");
  expect(existsSync(join(runtimeRoot, `${notificationFileStem(String(entry.id))}.claim`))).toBe(
    false,
  );
}

function notificationBinding(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "ut-tdd.notification-binding/v1",
    entryId: entry.id,
    projectId: entry.projectId,
    operationId: entry.operationId,
    producer: entry.producer,
    target: entry.target,
    envelopeDigest: entry.envelopeDigest,
  };
}

function snapshotTree(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory())
        return [`dir:${entry.name}`, ...snapshotTree(path).map((item) => `${entry.name}/${item}`)];
      if (entry.isFile()) {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        return [`file:${entry.name}:${digest}`];
      }
      return [`other:${entry.name}`];
    });
}

function trackedPaths(cwd: string, ...paths: string[]): string[] {
  const result = spawnSync("git", ["ls-files", "--", ...paths], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(result.status).toBe(0);
  return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}

function expectAcceptedDecision(decision: unknown): void {
  // L6 §6 pseudocode names the pure classifier's accept result literally.
  // This is an internal classifier oracle, not a CLI or receipt schema.
  expect(decision).toBe("accept");
}

function addDurableReason(root: string, sourcePath: string, reason: string): void {
  const path = join(root, sourcePath);
  const source = readFileSync(path, "utf8");
  const separator = source.indexOf("\n---\n", source.indexOf("---\n") + 4);
  expect(separator).toBeGreaterThan(0);
  writeFileSync(
    path,
    `${source.slice(0, separator)}\ndurable_reason: ${JSON.stringify(reason)}${source.slice(separator)}`,
  );
}

function freezeTargetSnapshot(
  root: string,
  entries: readonly { memory_id: string; source_path: string }[],
): void {
  const rows = entries
    .map((entry) => {
      const content = readFileSync(join(root, entry.source_path));
      const canonical = canonicalize({
        content_sha256: createHash("sha256").update(content).digest("hex"),
        memory_id: entry.memory_id,
      });
      expect(canonical.ok).toBe(true);
      return { memory_id: entry.memory_id, bytes: canonical.ok ? canonical.value : "" };
    })
    .sort((left, right) => left.memory_id.localeCompare(right.memory_id));
  const snapshotBytes = rows.length === 0 ? "" : `${rows.map((row) => row.bytes).join("\n")}\n`;
  const snapshotPath = join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl");
  const evidencePath = join(root, "docs", "migration", "state-channel-target-snapshot.json");
  mkdirSync(join(root, ".ut-tdd", "archive", "memory-episodes"), { recursive: true });
  mkdirSync(join(root, "docs", "migration"), { recursive: true });
  writeFileSync(snapshotPath, snapshotBytes, "utf8");
  const evidence = canonicalize({
    schema: "ut-tdd.state-channel-target-snapshot/v1",
    sha256: createHash("sha256").update(snapshotBytes, "utf8").digest("hex"),
    count: rows.length,
    recorded_at: "2026-10-16T00:00:00.000Z",
  });
  expect(evidence.ok).toBe(true);
  writeFileSync(evidencePath, `${evidence.ok ? evidence.value : ""}\n`, "utf8");
  const stagedEvidence = spawnSync(
    "git",
    ["add", "docs/migration/state-channel-target-snapshot.json"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  expect(stagedEvidence.status).toBe(0);
}

function readIndexedMemoryRows(root: string): Record<string, unknown>[] {
  const path = join(root, ".ut-tdd", "harness.db");
  if (!existsSync(path)) return [];
  const db = openReadOnlyHarnessDb(path, { repoRoot: root });
  try {
    return db.prepare("SELECT * FROM memory_entries ORDER BY memory_id").all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

function rewriteTargetSnapshotRows(
  root: string,
  rows: readonly { memory_id: string; content_sha256: string }[],
): void {
  const lines = [...rows]
    .sort((left, right) => left.memory_id.localeCompare(right.memory_id))
    .map((row) => {
      const encoded = canonicalize(row);
      if (!encoded.ok) throw new Error("snapshot fixture row must canonicalize");
      return encoded.value;
    });
  writeFileSync(
    join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
    lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) removeTestTree(root);
});

describe("Issue #1062: memory becomes lesson-only", () => {
  it.fails("U-STCHAN-001: episodic project memory is rejected before any file is written", () => {
    const root = tempRepo();
    const result = runCli(root, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "PR 1055 CI と control merge",
      "--body",
      "lane state",
    ]);
    expectStarted(result);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("episodic_memory_rejected");
    expect(result.stderr).toContain("GitHub");
    expect(result.stderr).toContain("ut-tdd notify claude");
    expect(existsSync(join(root, ".ut-tdd", "memory"))).toBe(false);
  });

  it.fails("U-STCHAN-002: a durable reason admits project memory and is persisted", () => {
    const root = tempRepo();
    const result = runCli(root, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "Durable constraint",
      "--body",
      "A permanent rule.",
      "--durable-reason",
      "変わらない制約",
    ]);
    expectStarted(result);
    expect(result.status).toBe(0);
    const files = readdirSync(join(root, ".ut-tdd", "memory"));
    expect(files).toHaveLength(1);
    const memoryFile = requireOnly(files, "durable memory file");
    expect(readFileSync(join(root, ".ut-tdd", "memory", memoryFile), "utf8")).toContain(
      "durable_reason: 変わらない制約",
    );
  });

  it.fails("U-STCHAN-003: whitespace-only durable reason is rejected", () => {
    const root = tempRepo();
    const result = runCli(root, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "Blank reason",
      "--body",
      "A rule.",
      "--durable-reason",
      "   ",
    ]);
    expectStarted(result);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("episodic_memory_rejected");
    expect(existsSync(join(root, ".ut-tdd", "memory"))).toBe(false);
  });

  it("U-STCHAN-004: feedback with a PR number remains accepted", () => {
    const root = tempRepo();
    const result = runCli(root, [
      "memory",
      "add",
      "--kind",
      "feedback",
      "--title",
      "PR #700 の重複 request は merge を塞ぐ",
      "--body",
      "Keep this lesson searchable.",
    ]);
    expectStarted(result);
    expect(result.status).toBe(0);
    const files = readdirSync(join(root, ".ut-tdd", "memory"));
    expect(files).toHaveLength(1);
    const memoryFile = requireOnly(files, "feedback memory file");
    expect(readFileSync(join(root, ".ut-tdd", "memory", memoryFile), "utf8")).toContain(
      "kind: feedback",
    );
  });

  it("U-STCHAN-005: reference and user lessons containing an issue number remain accepted", () => {
    for (const kind of ["reference", "user"] as const) {
      const root = tempRepo();
      const result = runCli(root, [
        "memory",
        "add",
        "--kind",
        kind,
        "--title",
        `Issue 898 ${kind} lesson`,
        "--body",
        "Keep this canonical lesson.",
      ]);
      expectStarted(result);
      expect(result.status).toBe(0);
      const files = readdirSync(join(root, ".ut-tdd", "memory"));
      expect(files).toHaveLength(1);
      const memoryFile = requireOnly(files, `${kind} memory file`);
      expect(readFileSync(join(root, ".ut-tdd", "memory", memoryFile), "utf8")).toContain(
        `kind: ${kind}`,
      );
    }
  });

  it.fails("U-STCHAN-006: every tracked memory record is accepted by the classifier", async () => {
    const module = await import("../src/memory/service.ts");
    const classify = (module as Record<string, unknown>).classifyMemoryAdd;
    expect(typeof classify).toBe("function");
    if (typeof classify !== "function") return;
    const tracked = spawnSync("git", ["ls-files", ".ut-tdd/memory"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(tracked.status).toBe(0);
    const paths = tracked.stdout.split(/\r?\n/).filter(Boolean);
    expect(paths).toHaveLength(46);
    const records = paths.map((path) => {
      const text = readFileSync(join(repoRoot, path), "utf8");
      const kind = /^kind:\s*(feedback|reference|user|project)\s*$/m.exec(text)?.[1];
      const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? path;
      return { path, kind, title };
    });
    expect(records.every((record) => record.kind !== undefined)).toBe(true);
    expect(records.filter((record) => record.kind === "project")).toHaveLength(0);
    const decisions = records.map(({ kind, title }) =>
      (classify as (input: unknown) => unknown)({ kind, title }),
    );
    expect(decisions).toHaveLength(46);
    for (const decision of decisions) expectAcceptedDecision(decision);
  });
});

describe("Issue #1062: review custody no longer depends on memory", () => {
  it.fails("U-STCHAN-007: v2 identity has four keys and an independently derived stable digest", async () => {
    const identityInput = { pr: 283, exactHead: "a".repeat(40), authorFamily: "codex" as const };
    const identity = {
      schemaVersion: "review-request/v2",
      pr: identityInput.pr,
      exactHead: identityInput.exactHead,
      authorFamily: identityInput.authorFamily,
    };
    const independentExpected = `rv1-${createHash("sha256")
      .update(
        JSON.stringify({
          authorFamily: "codex",
          exactHead: "a".repeat(40),
          pr: 283,
          schemaVersion: "review-request/v2",
        }),
      )
      .digest("hex")}`;
    const root = tempRepo();
    const first = issueReviewRequest({
      repoRoot: root,
      request: {
        ...identityInput,
        schemaVersion: "review-request/v2",
        reviewRevision: independentExpected,
        requestedAt: "2026-10-16T00:00:00.000Z",
        invocationNonce: "nonce-first",
      } as never,
      strict: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const module = await import("../src/feedback/review-custody-canonical.ts");
    const buildIdentity = (module as Record<string, unknown>).reviewIdentityObjectV2;
    expect(typeof buildIdentity).toBe("function");
    if (typeof buildIdentity !== "function") return;
    expect(
      (buildIdentity as (value: typeof identityInput) => Record<string, unknown>)(identityInput),
    ).toEqual(identity);
    const second = issueReviewRequest({
      repoRoot: root,
      request: {
        ...identityInput,
        schemaVersion: "review-request/v2",
        reviewRevision: independentExpected,
        requestedAt: "2026-10-16T00:01:00.000Z",
        invocationNonce: "nonce-second",
      } as never,
      strict: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.digest).toBe(independentExpected.replace(/^rv1-/, ""));
    expect(second.path).toBe(first.path);
    expect(first.request.requestedAt).not.toBe(second.request.requestedAt);
    expect(first.request.invocationNonce).not.toBe(second.request.invocationNonce);
    expect(first.request).not.toHaveProperty("memoryId");
    expect(second.request).not.toHaveProperty("memoryId");
    const dispatch = analyzeReviewDispatch({
      requests: [first.request, second.request] as never,
      receipts: [],
      prs: [{ pr: 283, headSha: identityInput.exactHead, state: "OPEN", checksGreen: true }],
      now: "2026-10-16T00:02:00.000Z",
    });
    expect(dispatch.diagnostics).not.toEqual(
      expect.arrayContaining([expect.stringContaining("duplicate_request_conflict")]),
    );
    expect(dispatch.entries.flatMap((entry) => entry.reasons)).not.toContain(
      "duplicate_request_conflict",
    );
  });

  it.fails("U-STCHAN-008: changing exactHead changes the v2 identity digest", async () => {
    const module = await import("../src/feedback/review-custody-canonical.ts");
    const buildIdentity = (module as Record<string, unknown>).reviewIdentityObjectV2;
    expect(typeof buildIdentity).toBe("function");
    if (typeof buildIdentity !== "function") return;
    const base = { pr: 283, exactHead: "a".repeat(40), authorFamily: "codex" as const };
    const changed = { ...base, exactHead: "b".repeat(40) };
    const derive = (value: typeof base) => {
      const identity = (buildIdentity as (input: typeof base) => Record<string, unknown>)(value);
      const canonical = canonicalize(identity);
      expect(canonical.ok).toBe(true);
      return canonical.ok ? createHash("sha256").update(canonical.value).digest("hex") : "";
    };
    expect(derive(base)).not.toBe(derive(changed));
  });

  it("U-STCHAN-009: fixed historical v1 terminal evidence remains readable beside a v2 request", () => {
    const root = tempRepo();
    const head = "b".repeat(40);
    const legacyIdentity = {
      schemaVersion: "review-request/v1" as const,
      memoryId: "memory:project:legacy-review-283",
      pr: 283,
      exactHead: head,
      authorFamily: "codex" as const,
    };
    const revision = computeReviewRevision(legacyIdentity);
    expect(revision).toEqual({
      ok: true,
      value: "rv1-b915b3989d72d66eb7d17c388beab9eabec19743ffa4d0186e6dea0f9c96c9e9",
    });
    if (!revision.ok) throw new Error(`historical identity fixture invalid: ${revision.reason}`);
    const requests = join(root, ".ut-tdd", "review", "requests");
    const receipts = join(root, ".ut-tdd", "review", "receipts");
    for (const dir of [requests, receipts]) mkdirSync(dir, { recursive: true });
    const historicalRequestBytes = `{
  "memoryId": "memory:project:legacy-review-283",
  "pr": 283,
  "exactHead": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reviewRevision": "rv1-b915b3989d72d66eb7d17c388beab9eabec19743ffa4d0186e6dea0f9c96c9e9",
  "authorFamily": "codex",
  "requestedAt": "2026-10-16T00:00:00.000Z",
  "invocationNonce": "nonce-historical-v1"
}\n`;
    const historicalReceiptBytes = `{
  "memoryId": "memory:project:legacy-review-283",
  "pr": 283,
  "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reviewRevision": "rv1-b915b3989d72d66eb7d17c388beab9eabec19743ffa4d0186e6dea0f9c96c9e9",
  "reviewerFamily": "claude",
  "kind": "verdict",
  "verdict": "PASS",
  "blockingFindings": [],
  "at": "2026-10-16T00:01:00.000Z"
}\n`;
    const v1Request = JSON.parse(historicalRequestBytes) as Record<string, unknown>;
    const v1Receipt = JSON.parse(historicalReceiptBytes) as Record<string, unknown>;
    expect(v1Request.memoryId).toBe(legacyIdentity.memoryId);
    expect(v1Receipt.memoryId).toBe(v1Request.memoryId);
    expect(v1Receipt.kind).toBe("verdict");
    writeFileSync(join(requests, "historical-v1.json"), historicalRequestBytes);
    writeFileSync(join(receipts, "historical-v1.json"), historicalReceiptBytes);
    // Mix a real four-key v2 identity at another head; do not invent a v2 receipt schema.
    const v2Identity = {
      schemaVersion: "review-request/v2",
      pr: 283,
      exactHead: "cccccccccccccccccccccccccccccccccccccccc",
      authorFamily: "codex",
    } as const;
    const v2Digest = createHash("sha256")
      .update(
        JSON.stringify({
          authorFamily: v2Identity.authorFamily,
          exactHead: v2Identity.exactHead,
          pr: v2Identity.pr,
          schemaVersion: v2Identity.schemaVersion,
        }),
      )
      .digest("hex");
    const v2Request = {
      ...v2Identity,
      reviewRevision: `rv1-${v2Digest}`,
      requestedAt: "2026-10-16T00:00:00.000Z",
      invocationNonce: "nonce-v2-other-head",
    };
    expect(v2Request.reviewRevision).toBe(`rv1-${v2Digest}`);
    expect(Object.keys(v2Request).sort()).toEqual([
      "authorFamily",
      "exactHead",
      "invocationNonce",
      "pr",
      "requestedAt",
      "reviewRevision",
      "schemaVersion",
    ]);
    writeFileSync(join(requests, "current-v2-other-head.json"), `${JSON.stringify(v2Request)}\n`);
    const mergeResult = runPrMerge({
      repoRoot: root,
      pr: 283,
      now: () => "2026-10-16T00:02:00.000Z",
      ports: {
        getPullRequest: () => ({
          pr: 283,
          headSha: head,
          evaluatedHeadSha: head,
          state: "OPEN",
          checksGreen: true,
        }),
        mergePullRequest: () => undefined,
        checkBaselineConflict: () => null,
      },
    });
    expect(mergeResult.ok).toBe(true);
    expect(mergeResult.decision).toBe("merge");

    const backstop = scanPostMergeBackstop({
      repoRoot: root,
      now: "2026-10-16T00:03:00.000Z",
      fetchMergedPrPage: (page) =>
        page === 1
          ? [
              {
                number: 283,
                merged_at: "2026-10-16T00:02:30.000Z",
                merge_commit_sha: "e".repeat(40),
                head: { sha: head },
              },
            ]
          : [],
    });
    expect(backstop.ok).toBe(true);
    expect(backstop.detections).toEqual([]);
  });

  it.fails("U-STCHAN-010: deprecated review memory id is ignored with a warning", () => {
    const root = tempRepo();
    const result = runCli(root, [
      "codex",
      "--role",
      "se",
      "--task",
      "review fixture",
      "--dry-run",
      "--review-memory-id",
      "legacy-memory",
      "--review-pr",
      "283",
      "--review-head",
      "a".repeat(40),
      "--review-author-family",
      "claude",
    ]);
    expectStarted(result);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("review_memory_id_deprecated");
    expect(result.stdout).toContain('"schemaVersion":"review-request/v2"');
    expect(result.stdout).not.toContain('"memoryId"');
  });

  it.fails("U-STCHAN-011: retired review memory id fails before creating a request", () => {
    const root = tempRepo();
    const result = runCli(root, [
      "codex",
      "--role",
      "se",
      "--task",
      "review fixture",
      "--dry-run",
      "--review-memory-id",
      "legacy-memory",
      "--review-pr",
      "283",
      "--review-head",
      "a".repeat(40),
      "--review-author-family",
      "claude",
    ]);
    expectStarted(result);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("review_memory_id_retired");
    expect(existsSync(join(root, ".ut-tdd", "review", "requests"))).toBe(false);
  });

  it.fails("U-STCHAN-012: live dispatch identity excludes task prose and preserves first task copy", () => {
    const root = tempRepo();
    const taskOne = join(root, "review-task-one.md");
    const taskTwo = join(root, "review-task-two.md");
    const firstBody = "Review only the first supplied task body.\n";
    const secondBody = "A different task body, same canonical review identity.\n";
    writeFileSync(taskOne, firstBody);
    writeFileSync(taskTwo, secondBody);
    const identity = {
      schemaVersion: "review-request/v2",
      pr: 283,
      exactHead: "a".repeat(40),
      authorFamily: "codex",
    };
    const expectedDigest = createHash("sha256")
      .update(
        JSON.stringify({
          authorFamily: identity.authorFamily,
          exactHead: identity.exactHead,
          pr: identity.pr,
          schemaVersion: identity.schemaVersion,
        }),
      )
      .digest("hex");
    const dispatch = (taskFile: string) =>
      runCli(root, [
        "review",
        "live-dispatch",
        "--task-file",
        taskFile,
        "--pr",
        String(identity.pr),
        "--head",
        identity.exactHead,
        "--revision",
        `rv1-${expectedDigest}`,
        "--author-family",
        identity.authorFamily,
        "--operation-id",
        "same-review-identity",
        "--json",
      ]);
    const first = dispatch(taskOne);
    expectStarted(first);
    expect(first.status).toBe(0);
    const second = dispatch(taskTwo);
    expectStarted(second);
    expect(second.status).toBe(0);
    expect(`${second.stderr}\n${second.stdout}`).toMatch(/warn/i);
    expect(existsSync(join(root, ".ut-tdd", "memory"))).toBe(false);
    const requestPath = join(root, ".ut-tdd", "review", "requests", `${expectedDigest}.json`);
    const taskCopyPath = join(root, ".ut-tdd", "review", "requests", `${expectedDigest}.task.md`);
    expect(existsSync(requestPath)).toBe(true);
    expect(existsSync(taskCopyPath)).toBe(true);
    expect(readFileSync(taskCopyPath, "utf8")).toBe(firstBody);
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject(identity);
    expect(request).not.toHaveProperty("memoryId");
    expect(request).not.toHaveProperty("memoryPath");
    expect(request).not.toHaveProperty("task");
    expect(request).not.toHaveProperty("taskFile");
    expect(
      readdirSync(join(root, ".ut-tdd", "review", "requests")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toEqual([`${expectedDigest}.json`]);
    expect(
      readdirSync(join(root, ".ut-tdd", "review", "requests")).filter((name) =>
        name.endsWith(".task.md"),
      ),
    ).toEqual([`${expectedDigest}.task.md`]);
    const project = resolveProjectMemoryRoot(root);
    if (!project.ok) throw new Error(`notification inbox root: ${project.reason}`);
    const inbox = join(project.runtimeBusRoot, "claude-memory-wake", "inbox");
    const notifications = readdirSync(inbox).filter((name) => name.endsWith(".json"));
    expect(notifications.length).toBeGreaterThan(0);
    const entries = notifications.map(
      (name) => JSON.parse(readFileSync(join(inbox, name), "utf8")) as Record<string, unknown>,
    );
    const reviewNotification = entries.find(
      (entry) =>
        entry.schemaVersion === "ut-tdd.notification/v1" &&
        entry.purpose === "review" &&
        entry.requestDigest === expectedDigest &&
        entry.requestPath === `.ut-tdd/review/requests/${expectedDigest}.json` &&
        entry.pr === identity.pr &&
        entry.exactHead === identity.exactHead &&
        entry.authorFamily === identity.authorFamily &&
        entry.reviewRevision === `rv1-${expectedDigest}`,
    );
    expect(reviewNotification).toBeDefined();
    expect(reviewNotification).not.toHaveProperty("memoryId");
    expect(reviewNotification).not.toHaveProperty("memoryPath");
  });

  it.fails("U-STCHAN-013: v2 request rejects an added memoryId key but accepts the exact request", async () => {
    const root = tempRepo();
    const identity = {
      schemaVersion: "review-request/v2",
      pr: 283,
      exactHead: "b".repeat(40),
      authorFamily: "codex",
    } as const;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          authorFamily: identity.authorFamily,
          exactHead: identity.exactHead,
          pr: identity.pr,
          schemaVersion: identity.schemaVersion,
        }),
      )
      .digest("hex");
    const requestPath = `.ut-tdd/review/requests/${digest}.json`;
    mkdirSync(join(root, ".ut-tdd", "review", "requests"), { recursive: true });
    const request = {
      ...identity,
      reviewRevision: `rv1-${digest}`,
      requestedAt: "2026-10-16T00:00:00.000Z",
      invocationNonce: "nonce-v2",
    };
    const memory = writeMemory({
      repoRoot: root,
      input: {
        kind: "feedback",
        title: "Review task fixture",
        body: "A real tracked task memory supplies the current v4 envelope producer.",
      },
    });
    const envelope = buildClaudeProviderReviewInboxEntry({
      memory,
      projectId: "example/repo",
      operationId: "issue-1062-candidate-013",
      workspaceId: "d".repeat(64),
      producer: { provider: "codex", sessionId: "codex-review" },
      target: { scope: "session", provider: "claude", sessionId: "claude-review" },
      requestDigest: digest,
      requestPath,
      pr: identity.pr,
      exactHead: identity.exactHead,
      reviewRevision: request.reviewRevision,
      authorFamily: identity.authorFamily,
      now: "2026-10-16T00:00:00.000Z",
    });
    writeFileSync(join(root, requestPath), `${JSON.stringify(request)}\n`);
    expect(Object.keys(request).sort()).toEqual([
      "authorFamily",
      "exactHead",
      "invocationNonce",
      "pr",
      "requestedAt",
      "reviewRevision",
      "schemaVersion",
    ]);
    expect.soft(loadCanonicalLiveReviewRequest({ repoRoot: root, envelope })).toEqual(request);
    writeFileSync(
      join(root, requestPath),
      `${JSON.stringify({ ...request, memoryId: "legacy" })}\n`,
    );
    expect(loadCanonicalLiveReviewRequest({ repoRoot: root, envelope })).toBeNull();
  });

  it.fails("U-STCHAN-014: custody runner accepts a v2 request without memory identity env", async () => {
    const values: Record<string, string> = {
      GITHUB_REPOSITORY: "example/repo",
      UT_TDD_CUSTODY_PR: "283",
      UT_TDD_CUSTODY_PLAN_ID: "PLAN-L7-465",
      UT_TDD_CUSTODY_PLAN_REVISION: "a".repeat(64),
      UT_TDD_CUSTODY_JUDGMENT_DIGEST: "b".repeat(64),
      UT_TDD_CUSTODY_PROVIDER_EVIDENCE_REF: `d3b:${"3".repeat(64)}`,
      UT_TDD_CUSTODY_REVIEWER_FAMILY: "claude",
      UT_TDD_CUSTODY_AUTHOR_FAMILY: "codex",
      UT_TDD_CUSTODY_VERDICT: "PASS",
      GITHUB_WORKFLOW_REF: "example/repo/.github/workflows/review.yml@refs/heads/main",
      GITHUB_SHA: "c".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
      UT_TDD_CUSTODY_RECEIPT_PATH: "receipt.json",
    };
    expect(values).not.toHaveProperty("UT_TDD_CUSTODY_MEMORY_ID");
    const pullRequest = {
      number: 283,
      state: "open",
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      base: { ref: "main" },
      head: { sha: "d".repeat(40), repo: { full_name: "example/repo" } },
    };
    let written = "";
    let writeCount = 0;
    const env: RunnerEnvironment = {
      get: (name) => values[name],
      runGh: () => ({ status: 0, stdout: JSON.stringify(pullRequest) }),
      readFile: () => {
        throw new Error("issue must not read an existing receipt");
      },
      writeFile: (_path, content) => {
        written = content;
        writeCount += 1;
      },
      log: () => undefined,
    };
    values.UT_TDD_CUSTODY_MEMORY_ID = "project-review-pr-283-exact-head";
    const withMemoryId = issueCustodyReceipt(env);
    expect(withMemoryId.exitCode).toBe(0);
    expect(writeCount).toBe(1);
    expect(JSON.parse(written)).toMatchObject({
      requestIdentity: { memoryId: "project-review-pr-283-exact-head" },
    });

    delete values.UT_TDD_CUSTODY_MEMORY_ID;
    written = "";
    writeCount = 0;
    let outcome: ReturnType<typeof issueCustodyReceipt> | undefined;
    let runnerError: string | undefined;
    try {
      outcome = issueCustodyReceipt(env);
    } catch (error) {
      runnerError = error instanceof Error ? error.message : String(error);
    }
    expect.soft(runnerError, "custody runner must not require memory identity env").toBeUndefined();
    expect.soft(outcome).toMatchObject({ exitCode: 0 });
    if (!outcome || outcome.exitCode !== 0) return;
    expect(writeCount).toBe(1);
    const receipt = JSON.parse(written) as Record<string, unknown>;
    expect(receipt).not.toHaveProperty("memoryId");
    expect(JSON.stringify(receipt)).not.toContain("memoryId");
  });
});

describe("Issue #1062: runtime notifications are memory-free", () => {
  it.fails("U-STCHAN-015: notify claude writes a memory-free notification v1 entry", () => {
    const root = tempRepo();
    const result = runCli(root, [
      "notify",
      "claude",
      "--ref",
      "https://github.com/example/repo/pull/283#issuecomment-1",
      "--body",
      "review is ready",
      "--operation-id",
      "notify-test",
      "--json",
    ]);
    expectStarted(result);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ut-tdd.notification/v1");
    expect(result.stdout).toContain('"purpose":"note"');
    expect(result.stdout).not.toMatch(/memory_id|memoryPath/);
    const project = resolveProjectMemoryRoot(root);
    if (!project.ok) throw new Error(`notification inbox root: ${project.reason}`);
    const inbox = join(project.runtimeBusRoot, "claude-memory-wake", "inbox");
    const files = readdirSync(inbox).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const inboxFile = requireOnly(files, "notification inbox entry");
    const entry = JSON.parse(readFileSync(join(inbox, inboxFile), "utf8")) as Record<
      string,
      unknown
    >;
    expect(entry).toMatchObject({
      schemaVersion: "ut-tdd.notification/v1",
      purpose: "note",
      ref: "https://github.com/example/repo/pull/283#issuecomment-1",
      body: "review is ready",
    });
    expect(entry).not.toHaveProperty("memory_id");
    expect(entry).not.toHaveProperty("memoryId");
    expect(entry).not.toHaveProperty("memoryPath");
  });

  it.fails("U-STCHAN-016: notify rejects a missing, foreign-repository, or non-GitHub ref", () => {
    for (const ref of [
      undefined,
      "https://github.com/other/repo/pull/1",
      "https://example.com/x",
    ]) {
      const root = tempRepo();
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(`notification inbox root: ${project.reason}`);
      const inbox = join(project.runtimeBusRoot, "claude-memory-wake", "inbox");
      const args = ["notify", "claude", "--body", "x"];
      if (ref) args.push("--ref", ref);
      const result = runCli(root, args);
      expectStarted(result);
      expect(result.status).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).not.toMatch(/unknown command|unknown option/i);
      expect(existsSync(inbox)).toBe(false);
    }
  });

  it("U-STCHAN-017: legacy v3/v4 inbox entries remain readable", async () => {
    const module = await import("../src/runtime/claude-memory-wake.ts");
    const decode = module.decodeClaudeInboxEntry;
    const select = module.selectClaudeInboxEntry;
    const terminal = module.evaluateClaudeInboxTerminal;
    const workspaceId = "a".repeat(64);
    const memory = {
      memory_id: "memory:feedback:legacy-inbox",
      kind: "feedback",
      title: "legacy inbox fixture",
      body: "legacy memory entry",
      tags: [],
      source_path: ".ut-tdd/memory/feedback-legacy-inbox.md",
      updated_at: "2026-10-15T00:00:00.000Z",
      content_hash: createHash("sha256").update("legacy memory entry").digest("hex"),
    } as MemoryEntry;
    const oldV3 = module.buildClaudeInboxEntry({
      memory,
      operationId: "op-v3",
      workspaceId,
      originRuntime: "codex",
      now: "2026-10-15T00:00:00.000Z",
    });
    const providerModule = await import("../src/runtime/claude-provider-envelope.ts");
    const oldV4 = providerModule.buildClaudeProviderInboxEntry({
      memory,
      projectId: "fixture-project",
      operationId: "op-v4",
      workspaceId,
      producer: { provider: "codex", sessionId: "producer" },
      target: { scope: "session", provider: "claude", sessionId: "target" },
      now: "2026-10-15T00:00:01.000Z",
    });
    const entries = [oldV3, oldV4].map((entry) => decode(JSON.stringify(entry)));
    expect(entries.every((entry) => entry !== undefined)).toBe(true);
    if (entries.some((entry) => entry === undefined)) return;
    const decoded = entries as NonNullable<(typeof entries)[number]>[];
    expect(select(decoded, new Set())?.id).toBe(oldV3.id);
    const legacyDecision = terminal({
      entry: requireDefined(decoded[0], "v3 entry"),
      claimed: true,
    });
    expect(legacyDecision).toEqual({ terminal: true, reason: "claimed" });
    expect(select(decoded, new Set([oldV3.id]))?.id).toBe(oldV4.id);
    expect(terminal({ entry: requireDefined(decoded[1], "v4 entry"), claimed: true })).toEqual({
      terminal: true,
      reason: "claimed",
    });
  });

  it.fails("U-STCHAN-017: mixed v3/v4/v1 selection preserves legacy order and leaves v1 nonterminal before claim", async () => {
    const module = await import("../src/runtime/claude-memory-wake.ts");
    const workspaceId = "a".repeat(64);
    const memory = {
      memory_id: "memory:feedback:mixed-inbox",
      kind: "feedback",
      title: "mixed inbox fixture",
      body: "mixed version memory entry",
      tags: [],
      source_path: ".ut-tdd/memory/feedback-mixed-inbox.md",
      updated_at: "2026-10-15T00:00:00.000Z",
      content_hash: createHash("sha256").update("mixed version memory entry").digest("hex"),
    } as MemoryEntry;
    const oldV3 = module.buildClaudeInboxEntry({
      memory,
      operationId: "op-mixed-v3",
      workspaceId,
      originRuntime: "codex",
      now: "2026-10-15T00:00:00.000Z",
    });
    const providerModule = await import("../src/runtime/claude-provider-envelope.ts");
    const oldV4 = providerModule.buildClaudeProviderInboxEntry({
      memory,
      projectId: "fixture-project",
      operationId: "op-mixed-v4",
      workspaceId,
      producer: { provider: "codex", sessionId: "producer" },
      target: { scope: "session", provider: "claude", sessionId: "target" },
      now: "2026-10-15T00:00:01.000Z",
    });
    const digest = notificationEnvelopeDigest("fixture-project", "op-mixed-v1");
    const v1 = {
      schemaVersion: "ut-tdd.notification/v1",
      purpose: "note",
      id: `note:${digest}:workspace:${workspaceId}:op:op-mixed-v1`,
      body: "mixed inbox v1 note",
      originRuntime: "codex",
      operationId: "op-mixed-v1",
      targetWorkspaceId: workspaceId,
      createdAt: "2026-10-15T00:00:02.000Z",
      projectId: "fixture-project",
      producer: { provider: "codex", sessionId: "producer" },
      target: { scope: "session", provider: "claude", sessionId: "target" },
      envelopeDigest: digest,
      ref: "https://github.com/example/repo/issues/1062#issuecomment-1",
    };
    const decoded = [oldV3, oldV4, v1].map((entry) =>
      module.decodeClaudeInboxEntry(JSON.stringify(entry)),
    );
    expect(decoded.every((entry) => entry !== undefined)).toBe(true);
    if (decoded.some((entry) => entry === undefined)) return;
    const entries = decoded as NonNullable<(typeof decoded)[number]>[];
    const decodedV1 = requireDefined(
      entries.find((entry) => entry.id === v1.id),
      "mixed v1 entry",
    );

    expect(module.selectClaudeInboxEntry(entries, new Set())?.id).toBe(oldV3.id);
    expect(module.selectClaudeInboxEntry(entries, new Set([oldV3.id]))?.id).toBe(oldV4.id);
    expect(module.selectClaudeInboxEntry(entries, new Set([oldV3.id, oldV4.id]))?.id).toBe(v1.id);
    expect(module.evaluateClaudeInboxTerminal({ entry: decodedV1, claimed: false })).toEqual({
      terminal: false,
    });
  });

  it("U-STCHAN-017: frozen v1 note digest fixture is independently reproducible", () => {
    const preimage =
      '{"schemaVersion":"ut-tdd.notification/v1","projectId":"fixture-project","operationId":"op-note","producer":{"provider":"codex","sessionId":"producer"},"target":{"scope":"session","provider":"claude","sessionId":"target"}}';
    expect(createHash("sha256").update(preimage, "utf8").digest("hex")).toBe(
      "97f5c919948ab92a1cfb4006674323b57a3609c0c3f4c5bf068196cf41c8f4e1",
    );
    const reviewPreimage =
      '{"schemaVersion":"ut-tdd.notification/v1","projectId":"fixture-project","operationId":"op-review","producer":{"provider":"codex","sessionId":"producer"},"target":{"scope":"session","provider":"claude","sessionId":"target"}}';
    expect(createHash("sha256").update(reviewPreimage, "utf8").digest("hex")).toBe(
      "1517dc861f07fc839ff5e17549a570081f462864de318227d3fd624837b3a623",
    );
  });

  it.fails("U-STCHAN-017: raw v1 note fixture decodes", async () => {
    const module = await import("../src/runtime/claude-memory-wake.ts");
    const digest = "97f5c919948ab92a1cfb4006674323b57a3609c0c3f4c5bf068196cf41c8f4e1";
    const workspaceId = "a".repeat(64);
    const notificationV1 = {
      schemaVersion: "ut-tdd.notification/v1",
      purpose: "note",
      id: `note:${digest}:workspace:${workspaceId}:op:op-note`,
      body: "fixture note",
      originRuntime: "codex",
      operationId: "op-note",
      targetWorkspaceId: workspaceId,
      createdAt: "2026-10-16T00:00:00.000Z",
      projectId: "fixture-project",
      producer: { provider: "codex", sessionId: "producer" },
      target: { scope: "session", provider: "claude", sessionId: "target" },
      envelopeDigest: digest,
      ref: "https://github.com/example/repo/issues/1062#issuecomment-1",
    };
    const decoded = module.decodeClaudeInboxEntry(JSON.stringify(notificationV1));
    expect(decoded).toBeDefined();
    expect(decoded).toEqual(notificationV1);
    expect(Object.keys(notificationV1).sort()).toEqual([
      "body",
      "createdAt",
      "envelopeDigest",
      "id",
      "operationId",
      "originRuntime",
      "producer",
      "projectId",
      "purpose",
      "ref",
      "schemaVersion",
      "target",
      "targetWorkspaceId",
    ]);
  });

  describe("U-STCHAN-017 v1 filesystem consumers", () => {
    const fixtureRoots: Record<string, string> = {};
    const terminalWorkspaceIds: Record<string, string> = {};
    const terminalMarkerPaths: Record<string, string> = {};
    const noteOperation = "op-note-integration";

    const makeNote = (repoRoot: string, operationId: string) => {
      const project = resolveProjectMemoryRoot(repoRoot);
      if (!project.ok) throw new Error(`notification fixture root: ${project.reason}`);
      const workspaceId = project.projectNamespace;
      const projectId = project.projectId;
      const digest = notificationEnvelopeDigest(projectId, operationId);
      return {
        schemaVersion: "ut-tdd.notification/v1",
        purpose: "note",
        id: `note:${digest}:workspace:${workspaceId}:op:${operationId}`,
        body: "isolated v1 notification fixture",
        originRuntime: "codex",
        operationId,
        targetWorkspaceId: workspaceId,
        createdAt: "2026-10-16T00:00:00.000Z",
        projectId,
        producer: { provider: "codex", sessionId: "producer" },
        target: { scope: "session", provider: "claude", sessionId: "target" },
        envelopeDigest: digest,
        ref: `https://github.com/${projectId}/issues/1062#issuecomment-1`,
      };
    };

    beforeAll(() => {
      for (const name of [
        "note",
        "note-memoryid",
        "note-entry-memoryid",
        "note-v4id",
        "note-project",
        "terminals",
        "terminal-missing-key",
        "terminal-bad-schema",
        "terminal-bad-purpose",
        "terminal-note-pr-merged",
      ]) {
        const root = mkdtempSync(join(tmpdir(), "ut-tdd-state-channel-v1-"));
        fixtureRoots[name] = root;
        ensureTrackedProjectIdentity(
          root,
          name === "note-project" ? "fixture/tampered-project" : "fixture/project",
        );
      }

      const valid = makeNote(fixtureRoots.note, noteOperation);
      writeRawNotificationEntry(fixtureRoots.note, valid, notificationBinding(valid));

      const memoryIdEntry = makeNote(fixtureRoots["note-memoryid"], noteOperation);
      const memoryIdControl = makeNote(fixtureRoots["note-memoryid"], "op-memoryid-control");
      memoryIdControl.createdAt = "2026-10-15T23:59:59.000Z";
      memoryIdEntry.createdAt = "2026-10-16T00:00:01.000Z";
      writeRawNotificationEntry(
        fixtureRoots["note-memoryid"],
        memoryIdControl,
        notificationBinding(memoryIdControl),
      );
      writeRawNotificationEntry(fixtureRoots["note-memoryid"], memoryIdEntry, {
        ...notificationBinding(memoryIdEntry),
        memoryId: "memory:must-not-be-bound",
      });

      const entryMemoryIdControl = makeNote(
        fixtureRoots["note-entry-memoryid"],
        "op-entry-memoryid-control",
      );
      entryMemoryIdControl.createdAt = "2026-10-15T23:59:59.000Z";
      writeRawNotificationEntry(
        fixtureRoots["note-entry-memoryid"],
        entryMemoryIdControl,
        notificationBinding(entryMemoryIdControl),
      );
      const entryMemoryIdEntry = makeNote(fixtureRoots["note-entry-memoryid"], "op-entry-memoryid");
      entryMemoryIdEntry.createdAt = "2026-10-16T00:00:01.000Z";
      const entryWithMemoryId = { ...entryMemoryIdEntry, memoryId: "memory:must-not-be-bound" };
      writeRawNotificationEntry(
        fixtureRoots["note-entry-memoryid"],
        entryWithMemoryId,
        notificationBinding(entryWithMemoryId),
      );

      const v4IdEntry = makeNote(fixtureRoots["note-v4id"], noteOperation);
      const v4IdControl = makeNote(fixtureRoots["note-v4id"], "op-v4id-control");
      v4IdControl.createdAt = "2026-10-15T23:59:59.000Z";
      v4IdEntry.createdAt = "2026-10-16T00:00:01.000Z";
      writeRawNotificationEntry(
        fixtureRoots["note-v4id"],
        v4IdControl,
        notificationBinding(v4IdControl),
      );
      const legacyId = "fixture-memory:project:fixture-project:op:op-note:env:c891c7d73afce9a3";
      const v4IdTamper = { ...v4IdEntry, id: legacyId };
      writeRawNotificationEntry(fixtureRoots["note-v4id"], v4IdTamper, {
        ...notificationBinding(v4IdTamper),
        entryId: legacyId,
      });

      const projectControl = makeNote(fixtureRoots["note-project"], "op-project-control");
      projectControl.createdAt = "2026-10-15T23:59:59.000Z";
      writeRawNotificationEntry(
        fixtureRoots["note-project"],
        projectControl,
        notificationBinding(projectControl),
      );
      const projectEntry = makeNote(fixtureRoots["note-project"], noteOperation);
      projectEntry.createdAt = "2026-10-16T00:00:01.000Z";
      const originalDigest = notificationEnvelopeDigest("fixture/project", noteOperation);
      const projectTamper = {
        ...projectEntry,
        id: `note:${originalDigest}:workspace:${projectEntry.targetWorkspaceId}:op:${noteOperation}`,
        envelopeDigest: originalDigest,
      };
      writeRawNotificationEntry(
        fixtureRoots["note-project"],
        projectTamper,
        notificationBinding(projectTamper),
      );

      const project = resolveProjectMemoryRoot(fixtureRoots.terminals);
      if (!project.ok) throw new Error(`notification terminal fixture root: ${project.reason}`);
      const workspaceId = "a".repeat(64);
      const noteDigest = "97f5c919948ab92a1cfb4006674323b57a3609c0c3f4c5bf068196cf41c8f4e1";
      const note = {
        schemaVersion: "ut-tdd.notification/v1",
        purpose: "note",
        id: `note:${noteDigest}:workspace:${workspaceId}:op:op-note`,
        body: "fixture note",
        originRuntime: "codex",
        operationId: "op-note",
        targetWorkspaceId: workspaceId,
        createdAt: "2026-10-16T00:00:01.000Z",
        projectId: "fixture-project",
        producer: { provider: "codex", sessionId: "producer" },
        target: { scope: "session", provider: "claude", sessionId: "target" },
        envelopeDigest: noteDigest,
        ref: "https://github.com/example/repo/issues/1062#issuecomment-1",
      };
      const reviewDigest = "1517dc861f07fc839ff5e17549a570081f462864de318227d3fd624837b3a623";
      const review = {
        schemaVersion: "ut-tdd.notification/v1",
        purpose: "review",
        id: `review:${reviewDigest}:workspace:${workspaceId}:op:op-review`,
        body: "fixture review",
        originRuntime: "codex",
        operationId: "op-review",
        targetWorkspaceId: workspaceId,
        createdAt: "2026-10-16T00:00:02.000Z",
        projectId: "fixture-project",
        producer: { provider: "codex", sessionId: "producer" },
        target: { scope: "session", provider: "claude", sessionId: "target" },
        envelopeDigest: reviewDigest,
        requestDigest: "b".repeat(64),
        requestPath: `.ut-tdd/review/requests/${"b".repeat(64)}.json`,
        pr: 283,
        exactHead: "c".repeat(40),
        reviewRevision: "revision-1",
        authorFamily: "claude",
      };
      const claimedReviewDigest = notificationEnvelopeDigest(
        "fixture-project",
        "op-review-claimed",
      );
      const claimedReview = {
        ...review,
        id: `review:${claimedReviewDigest}:workspace:${workspaceId}:op:op-review-claimed`,
        operationId: "op-review-claimed",
        envelopeDigest: claimedReviewDigest,
      };

      for (const [name, operationId] of [
        ["terminal-missing-key", "op-terminal-missing-key"],
        ["terminal-bad-schema", "op-terminal-bad-schema"],
        ["terminal-bad-purpose", "op-terminal-bad-purpose"],
        ["terminal-note-pr-merged", "op-terminal-note-pr-merged"],
      ] as const) {
        const root = fixtureRoots[name];
        const entry = makeNote(root, operationId);
        writeRawNotificationEntry(root, entry, notificationBinding(entry));
        const terminalProject = resolveProjectMemoryRoot(root);
        if (!terminalProject.ok)
          throw new Error(`notification terminal reject fixture root: ${terminalProject.reason}`);
        terminalWorkspaceIds[name] = terminalProject.projectNamespace;
        const terminalRoot = join(terminalProject.runtimeBusRoot, "claude-memory-wake");
        const terminalPath = join(
          terminalRoot,
          `${notificationFileStem(String(entry.id))}.terminal.json`,
        );
        terminalMarkerPaths[name] = terminalPath;
        writeFileSync(
          terminalPath,
          `${JSON.stringify({
            schema: "ut-tdd.notification-terminal/v1",
            entryId: entry.id,
            reason: "claimed",
            terminalAt: "2026-10-16T00:00:03.000Z",
            purpose: "note",
          })}\n`,
        );
      }

      writeRawNotificationEntry(fixtureRoots.terminals, note, notificationBinding(note));
      writeRawNotificationEntry(fixtureRoots.terminals, review, notificationBinding(review));
      writeRawNotificationEntry(
        fixtureRoots.terminals,
        claimedReview,
        notificationBinding(claimedReview),
      );
      const runtimeRoot = join(project.runtimeBusRoot, "claude-memory-wake");
      mkdirSync(runtimeRoot, { recursive: true });
      writeFileSync(join(runtimeRoot, "note.claim"), `${JSON.stringify({ id: note.id })}\n`);
      writeFileSync(
        join(runtimeRoot, "review-claimed.claim"),
        `${JSON.stringify({ id: claimedReview.id })}\n`,
      );
    }, 300000); // file 163s, hook unmeasured, #1063

    afterAll(() => {
      for (const root of Object.values(fixtureRoots)) removeTestTree(root);
    }, 30_000);

    const readTerminalSummary = (name: string) => {
      const moduleRoot = fixtureRoots[name];
      const workspaceId = terminalWorkspaceIds[name];
      if (!moduleRoot || !workspaceId)
        throw new Error(`notification terminal fixture is incomplete: ${name}`);
      return import("../src/runtime/claude-memory-wake.ts").then((module) =>
        module.summarizeUnclaimedInbox(moduleRoot, workspaceId),
      );
    };

    it.fails("U-STCHAN-017: v1 claimed-note terminal controls are recognized before malformed-marker checks", async () => {
      for (const name of [
        "terminal-missing-key",
        "terminal-bad-schema",
        "terminal-bad-purpose",
        "terminal-note-pr-merged",
      ]) {
        const summary = await readTerminalSummary(name);
        expect(summary.terminalized, `${name} valid marker`).toBe(1);
        expect(summary.pending, `${name} valid marker`).toBe(0);
      }
    });

    const rejectMalformedNoteTerminal = async (
      name: string,
      mutate: (marker: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      const markerPath = terminalMarkerPaths[name];
      if (!markerPath) throw new Error(`notification terminal marker is missing: ${name}`);
      const before = await readTerminalSummary(name);
      expect(before.terminalized, `${name} valid marker control`).toBe(1);
      expect(before.pending, `${name} valid marker control`).toBe(0);
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      writeFileSync(markerPath, `${JSON.stringify(mutate(marker))}\n`);
      const after = await readTerminalSummary(name);
      expect(after.terminalized, `${name} malformed marker`).toBe(0);
      expect(after.pending, `${name} malformed marker`).toBe(1);
    };

    it.fails("U-STCHAN-017: v1 terminal rejects a missing required key", async () => {
      await rejectMalformedNoteTerminal("terminal-missing-key", (marker) => {
        const { terminalAt: _terminalAt, ...withoutTerminalAt } = marker;
        return withoutTerminalAt;
      });
    });

    it.fails("U-STCHAN-017: v1 terminal rejects an unsupported schema", async () => {
      await rejectMalformedNoteTerminal("terminal-bad-schema", (marker) => ({
        ...marker,
        schema: "ut-tdd.notification-terminal/v9",
      }));
    });

    it.fails("U-STCHAN-017: note terminal rejects the review purpose", async () => {
      await rejectMalformedNoteTerminal("terminal-bad-purpose", (marker) => ({
        ...marker,
        purpose: "review",
      }));
    });

    it.fails("U-STCHAN-017: note terminal rejects pr_merged", async () => {
      await rejectMalformedNoteTerminal("terminal-note-pr-merged", (marker) => ({
        ...marker,
        reason: "pr_merged",
      }));
    });

    it("017 integration fixture preconditions resolve identity, workspace, digest, and binding", () => {
      for (const name of [
        "note",
        "note-memoryid",
        "note-entry-memoryid",
        "note-v4id",
        "note-project",
      ]) {
        const root = fixtureRoots[name];
        const project = resolveProjectMemoryRoot(root);
        expect(project.ok, `${name} tracked project identity`).toBe(true);
        if (!project.ok) continue;
        const inbox = join(project.runtimeBusRoot, "claude-memory-wake", "inbox");
        const entries = readdirSync(inbox)
          .filter((file) => file.endsWith(".json"))
          .map(
            (file) =>
              JSON.parse(readFileSync(join(inbox, file), "utf8")) as Record<string, unknown>,
          );
        const control = requireOnly(
          entries.filter(
            (entry) =>
              entry.operationId ===
              (name === "note-project"
                ? "op-project-control"
                : name === "note-memoryid"
                  ? "op-memoryid-control"
                  : name === "note-entry-memoryid"
                    ? "op-entry-memoryid-control"
                    : name === "note-v4id"
                      ? "op-v4id-control"
                      : noteOperation),
          ),
          `${name} valid control entry`,
        );
        expect(control.projectId).toBe(project.projectId);
        expect(control.targetWorkspaceId).toBe(project.projectNamespace);
        expect(control.envelopeDigest).toBe(
          notificationEnvelopeDigest(project.projectId, String(control.operationId)),
        );
        const bindingPath = join(
          project.runtimeBusRoot,
          "claude-memory-wake",
          "envelope-bindings",
          `${notificationFileStem(String(control.id))}.json`,
        );
        const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
        expect(Object.keys(binding).sort()).toEqual([
          "entryId",
          "envelopeDigest",
          "operationId",
          "producer",
          "projectId",
          "schemaVersion",
          "target",
        ]);
        expect(binding).toEqual(notificationBinding(control));
      }
    });

    it.fails("U-STCHAN-017: v1 binding authorizes the valid memory-free note", async () => {
      const module = await import("../src/runtime/claude-memory-wake.ts");
      const result = await module.waitForClaudeMemory({
        repoRoot: fixtureRoots.note,
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(result.kind).toBe("delivered");
      expect(result.entry?.id).toBe(makeNote(fixtureRoots.note, noteOperation).id);
    });

    it.fails("U-STCHAN-017: changed preimage with coherent binding is rejected", async () => {
      const module = await import("../src/runtime/claude-memory-wake.ts");
      const validControl = await module.waitForClaudeMemory({
        repoRoot: fixtureRoots["note-project"],
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(validControl.kind).toBe("delivered");
      expect(validControl.entry?.id).toBe(
        readRawNotificationEntry(fixtureRoots["note-project"], "op-project-control").id,
      );
      const badEntry = readRawNotificationEntry(fixtureRoots["note-project"], noteOperation);
      expect(module.decodeClaudeInboxEntry(JSON.stringify(badEntry))).toBeDefined();
      const result = await module.waitForClaudeMemory({
        repoRoot: fixtureRoots["note-project"],
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(result.kind).toBe("denied");
      expectNotificationClaimAbsent(fixtureRoots["note-project"], badEntry);
    });

    it.fails("U-STCHAN-017: v1 binding rejects an added memoryId key", async () => {
      const module = await import("../src/runtime/claude-memory-wake.ts");
      const validControl = await module.waitForClaudeMemory({
        repoRoot: fixtureRoots["note-memoryid"],
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(validControl.kind).toBe("delivered");
      expect(validControl.entry?.id).toBe(
        readRawNotificationEntry(fixtureRoots["note-memoryid"], "op-memoryid-control").id,
      );
      const badEntry = readRawNotificationEntry(fixtureRoots["note-memoryid"], noteOperation);
      expect(module.decodeClaudeInboxEntry(JSON.stringify(badEntry))).toBeDefined();
      const result = await module.waitForClaudeMemory({
        repoRoot: fixtureRoots["note-memoryid"],
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(result.kind).toBe("denied");
      expectNotificationClaimAbsent(
        fixtureRoots["note-memoryid"],
        readRawNotificationEntry(fixtureRoots["note-memoryid"], noteOperation),
      );
    });

    it.fails("U-STCHAN-017: v1 entry rejects an added memoryId key", async () => {
      const module = await import("../src/runtime/claude-memory-wake.ts");
      const repoRoot = fixtureRoots["note-entry-memoryid"];
      const validControl = await module.waitForClaudeMemory({
        repoRoot,
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(validControl.kind).toBe("delivered");
      expect(validControl.entry?.id).toBe(
        readRawNotificationEntry(repoRoot, "op-entry-memoryid-control").id,
      );
      const badEntry = readRawNotificationEntry(repoRoot, "op-entry-memoryid");
      expect(module.decodeClaudeInboxEntry(JSON.stringify(badEntry))).toBeUndefined();
      const result = await module.waitForClaudeMemory({
        repoRoot,
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(result.kind).not.toBe("delivered");
      expectNotificationClaimAbsent(repoRoot, badEntry);
    });

    it.fails("U-STCHAN-017: v1 rejects a v4-format id even when binding entryId agrees", async () => {
      const module = await import("../src/runtime/claude-memory-wake.ts");
      const validControl = await module.waitForClaudeMemory({
        repoRoot: fixtureRoots["note-v4id"],
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(validControl.kind).toBe("delivered");
      expect(validControl.entry?.id).toBe(
        readRawNotificationEntry(fixtureRoots["note-v4id"], "op-v4id-control").id,
      );
      const badEntry = readRawNotificationEntry(fixtureRoots["note-v4id"], noteOperation);
      expect(module.decodeClaudeInboxEntry(JSON.stringify(badEntry))).toBeUndefined();
      const result = await module.waitForClaudeMemory({
        repoRoot: fixtureRoots["note-v4id"],
        sessionId: "target",
        pollIntervalMs: 10,
        maxWaitMs: 100,
      });
      expect(result.kind).not.toBe("delivered");
      expectNotificationClaimAbsent(fixtureRoots["note-v4id"], badEntry);
    });

    it.fails("U-STCHAN-017: claimed and merged v1 terminal markers record, reload, and reject extra keys", async () => {
      const module = await import("../src/runtime/claude-memory-wake.ts");
      const root = fixtureRoots.terminals;
      const pullRequests = [{ pr: 283, state: "MERGED" as const, headSha: "c".repeat(40) }];
      const project = resolveProjectMemoryRoot(root);
      if (!project.ok) throw new Error(`notification terminal fixture root: ${project.reason}`);
      const runtimeRoot = join(project.runtimeBusRoot, "claude-memory-wake");
      const inbox = join(runtimeRoot, "inbox");
      const rawEntries = readdirSync(inbox)
        .filter((name) => name.endsWith(".json"))
        .map(
          (name) => JSON.parse(readFileSync(join(inbox, name), "utf8")) as Record<string, unknown>,
        );
      const noteEntry = requireOnly(
        rawEntries.filter((entry) => entry.operationId === "op-note"),
        "fixed v1 note",
      );
      const mergedReviewEntry = requireOnly(
        rawEntries.filter((entry) => entry.operationId === "op-review"),
        "fixed v1 review",
      );
      const claimedReviewEntry = requireOnly(
        rawEntries.filter((entry) => entry.operationId === "op-review-claimed"),
        "claimed v1 review",
      );
      const first = module.recoverClaudeInboxBacklog({
        repoRoot: root,
        pullRequests,
        dryRun: false,
        now: "2026-10-16T00:00:05.000Z",
      });
      expect(first.inspected).toBe(3);
      expect(first.terminalized).toBe(3);
      const markers = readdirSync(runtimeRoot)
        .filter((name) => name.endsWith(".terminal.json"))
        .map(
          (name) =>
            JSON.parse(readFileSync(join(runtimeRoot, name), "utf8")) as Record<string, unknown>,
        );
      const noteMarker = requireOnly(
        markers.filter((marker) => marker.entryId === noteEntry.id),
        "v1 note marker",
      );
      const claimedReviewMarker = requireOnly(
        markers.filter((marker) => marker.entryId === claimedReviewEntry.id),
        "v1 claimed review marker",
      );
      const mergedReviewMarker = requireOnly(
        markers.filter((marker) => marker.entryId === mergedReviewEntry.id),
        "v1 merged review marker",
      );
      expect(noteMarker.entryId).toBe(noteEntry.id);
      expect(claimedReviewMarker.entryId).toBe(claimedReviewEntry.id);
      expect(mergedReviewMarker.entryId).toBe(mergedReviewEntry.id);
      expect(Object.keys(noteMarker).sort()).toEqual([
        "entryId",
        "purpose",
        "reason",
        "schema",
        "terminalAt",
      ]);
      expect(noteMarker).toMatchObject({
        schema: "ut-tdd.notification-terminal/v1",
        purpose: "note",
        reason: "claimed",
        terminalAt: "2026-10-16T00:00:05.000Z",
      });
      for (const marker of [claimedReviewMarker, mergedReviewMarker]) {
        expect(Object.keys(marker).sort()).toEqual([
          "authorFamily",
          "entryId",
          "exactHead",
          "pr",
          "purpose",
          "reason",
          "requestDigest",
          "requestPath",
          "reviewRevision",
          "schema",
          "terminalAt",
        ]);
        expect(marker).toMatchObject({
          schema: "ut-tdd.notification-terminal/v1",
          purpose: "review",
          terminalAt: "2026-10-16T00:00:05.000Z",
          requestDigest: "b".repeat(64),
          requestPath: `.ut-tdd/review/requests/${"b".repeat(64)}.json`,
          pr: 283,
          exactHead: "c".repeat(40),
          reviewRevision: "revision-1",
          authorFamily: "claude",
        });
        expect(marker).not.toHaveProperty("memoryPath");
      }
      expect(claimedReviewMarker.reason).toBe("claimed");
      expect(mergedReviewMarker.reason).toBe("pr_merged");
      const reloaded = module.recoverClaudeInboxBacklog({
        repoRoot: root,
        pullRequests,
        dryRun: false,
      });
      expect(reloaded.inspected).toBe(3);
      expect(reloaded.terminalized).toBe(0);
      expect(readdirSync(inbox).filter((name) => name.endsWith(".json"))).toHaveLength(3);

      const noteMarkerPath = join(
        runtimeRoot,
        `${notificationFileStem(String(noteEntry.id))}.terminal.json`,
      );
      writeFileSync(
        noteMarkerPath,
        `${JSON.stringify({ ...noteMarker, memoryId: "unexpected" })}\n`,
      );
      const malformedReload = module.recoverClaudeInboxBacklog({
        repoRoot: root,
        pullRequests,
        dryRun: false,
      });
      expect(malformedReload.terminalized).toBe(1);
      expect(malformedReload.entries).toEqual([
        { entryId: noteEntry.id, reason: "claimed", markerPath: noteMarkerPath },
      ]);
      expect(JSON.parse(readFileSync(noteMarkerPath, "utf8"))).toHaveProperty(
        "memoryId",
        "unexpected",
      );
    });
  });

  describe.skipIf(!(process.platform === "win32" || process.getuid?.() !== 0))(
    "U-STCHAN-018 permission-denied fixture",
    () => {
      let root: string | undefined;
      let memoryPath: string | undefined;
      let memoryFile: string | undefined;
      let permissionMayBeConfigured = false;
      let notificationResult: ReturnType<typeof runCli> | undefined;
      const protectedBytes = "permission-denied memory fixture\n";
      heavyBeforeAll("git", () => {
        const setupRoot = mkdtempSync(join(tmpdir(), "ut-tdd-state-channel-"));
        const setupMemoryPath = join(setupRoot, ".ut-tdd", "memory");
        const setupMemoryFile = join(setupMemoryPath, "protected.md");
        root = setupRoot;
        memoryPath = setupMemoryPath;
        memoryFile = setupMemoryFile;
        permissionMayBeConfigured = false;
        ensureTrackedProjectIdentity(setupRoot, "example/repo");
        mkdirSync(setupMemoryPath, { recursive: true });
        writeFileSync(setupMemoryFile, protectedBytes);

        // Set the cleanup flag first: even a partially applied ACL is reset by
        // afterAll, and setup failures cannot be swallowed by `it.fails`.
        permissionMayBeConfigured = true;
        denyDirectoryRead(setupMemoryPath);

        expect(
          () => readdirSync(setupMemoryPath),
          "memory directory read must be denied",
        ).toThrow();
        notificationResult = runCli(setupRoot, [
          "notify",
          "claude",
          "--ref",
          "https://github.com/example/repo/pull/283#issuecomment-1",
          "--body",
          "review is ready",
        ]);
        // Process-spawn / signal failures are setup failures, not accepted Red.
        expectStarted(notificationResult);
        expect(notificationResult.status, "CLI must exit normally").not.toBeNull();
      });

      heavyAfterAll("teardown", () => {
        try {
          if (memoryPath && memoryFile && permissionMayBeConfigured) {
            restoreDirectoryRead(memoryPath);
            expect(readFileSync(memoryFile, "utf8")).toBe(protectedBytes);
          }
        } finally {
          if (root) removeTestTree(root);
        }
      });

      it.fails("U-STCHAN-018: notify succeeds with the memory directory unreadable", () => {
        // Before the notify command exists, this is only a command-surface Red:
        // the expected failure is this success assertion. Once implemented,
        // a zero exit under the verified deny fixture is the non-reference oracle.
        expect(notificationResult?.status).toBe(0);
      });
    },
  );
});

describe("Issue #1062: handover prose is retired", () => {
  it("U-STCHAN-019: handover writes only CURRENT.json and dry-run is non-mutating", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".ut-tdd", "handover", "provider"), { recursive: true });
    mkdirSync(join(root, ".ut-tdd", "handover", "archive"), { recursive: true });
    mkdirSync(join(root, "docs", "handover"), { recursive: true });
    writeFileSync(join(root, ".ut-tdd", "handover", ".gitkeep"), "");
    writeFileSync(
      join(root, ".ut-tdd", "handover", "CURRENT.json"),
      '{"active_plan":"PLAN-L7-04"}\n',
    );
    writeFileSync(join(root, ".ut-tdd", "handover", "provider", "current.json"), "{}\n");
    writeFileSync(join(root, "docs", "handover", "existing.md"), "tracked historical prose\n");
    const beforeDry = {
      runtime: snapshotTree(join(root, ".ut-tdd", "handover")),
      docs: snapshotTree(join(root, "docs", "handover")),
      tracked: trackedPaths(root, ".ut-tdd/handover", "docs/handover"),
    };
    const dry = runCli(root, ["handover", "--dry-run"]);
    expectStarted(dry);
    expect(dry.status).toBe(0);
    expect({
      runtime: snapshotTree(join(root, ".ut-tdd", "handover")),
      docs: snapshotTree(join(root, "docs", "handover")),
      tracked: trackedPaths(root, ".ut-tdd/handover", "docs/handover"),
    }).toEqual(beforeDry);
    const beforeRun = {
      runtime: snapshotTree(join(root, ".ut-tdd", "handover")),
      docs: snapshotTree(join(root, "docs", "handover")),
      tracked: trackedPaths(root, ".ut-tdd/handover", "docs/handover"),
    };
    const run = runCli(root, ["handover"]);
    expectStarted(run);
    expect(run.status).toBe(0);
    expect(existsSync(join(root, ".ut-tdd", "handover", "CURRENT.json"))).toBe(true);
    expect(snapshotTree(join(root, "docs", "handover"))).toEqual(beforeRun.docs);
    expect(trackedPaths(root, ".ut-tdd/handover", "docs/handover")).toEqual(beforeRun.tracked);
    const runtimeFilesAfter = snapshotTree(join(root, ".ut-tdd", "handover"));
    const runtimeEntriesWithoutCurrent = (entries: string[]) =>
      entries.filter((entry) => !entry.startsWith("file:CURRENT.json:"));
    expect(runtimeEntriesWithoutCurrent(runtimeFilesAfter)).toEqual(
      runtimeEntriesWithoutCurrent(beforeRun.runtime),
    );
    expect(runtimeFilesAfter).toHaveLength(beforeRun.runtime.length);
    expect(runtimeFilesAfter.find((entry) => entry.startsWith("file:CURRENT.json:"))).toMatch(
      /^file:CURRENT\.json:/,
    );
    const pointer = JSON.parse(
      readFileSync(join(root, ".ut-tdd", "handover", "CURRENT.json"), "utf8"),
    );
    expect(pointer).not.toHaveProperty("latest_doc");
    expect(pointer).not.toHaveProperty("doc_entry_count");
  });

  it("U-STCHAN-020: the isolated doctor handover-prose definition reports an advisory count", () => {
    const root = tempRepo();
    const handover = join(root, ".ut-tdd", "handover");
    mkdirSync(join(handover, "provider"), { recursive: true });
    mkdirSync(join(handover, "archive"), { recursive: true });
    writeFileSync(join(handover, "CURRENT.json"), "{}\n");
    writeFileSync(join(handover, ".gitkeep"), "");
    writeFileSync(join(handover, "close-20261009.md"), "old prose\n");
    writeFileSync(join(handover, "x.sh"), "# old\n");
    const deps: DoctorDeps = {
      repoRoot: root,
      now: "2026-10-16T00:00:00.000Z",
      readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      listDir: (path) => (existsSync(path) ? readdirSync(path) : []),
      worktreeTopology: { facts: [], adminEntries: [] },
    };
    const definition = buildDoctorCheckDefinitionGroups(deps)
      .flatMap((group) => group.definitions)
      .find((entry) => entry.id === "handover-prose");
    expect(
      definition,
      "the handover-prose check must be an isolated doctor definition",
    ).toBeDefined();
    if (!definition) return;
    const result = definition.run();
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.stringMatching(/handover-prose.*2.*advisory/)]),
    );
  });

  describe("U-STCHAN-021 pointer fixture", () => {
    const repoRoot = "/repo";
    const legacyDoc = join("docs", "handover", "session-handover-2026-10-15.md");
    const pointer = {
      active_plan: "PLAN-L7-04",
      generated_by: "ut-tdd-handover",
      latest_doc: legacyDoc,
    };
    const files = new Map<string, string>([
      [join(repoRoot, ".ut-tdd", "handover", "CURRENT.json"), `${JSON.stringify(pointer)}\n`],
      [join(repoRoot, legacyDoc), "# Session Handover — 2026-10-15\n"],
    ]);
    const deps: HandoverDeps = {
      repoRoot,
      now: () => "2026-10-16T00:00:00.000Z",
      readText: (path) => files.get(path) ?? null,
      writeText: (path, text) => files.set(path, text),
      listDir: (path) =>
        [...files.keys()]
          .filter((entry) => entry.startsWith(`${path}/`))
          .map((entry) => entry.slice(path.length + 1)),
    };

    beforeAll(() => {
      expect(readPointer(deps)).toEqual(pointer);
    });

    it("U-STCHAN-021: pointer without doc_entry_count does not trigger a handover bypass warning", () => {
      expect(checkHandoverBypass(deps)).toEqual([]);
      // 署名照合は残る: 署名欠落 / 不正値の pointer は md の有無に関係なく手書き警告になる。
      for (const unsigned of [
        { active_plan: "PLAN-L7-04" },
        { active_plan: "PLAN-L7-04", generated_by: "hand-written" },
      ]) {
        const signatureDeps: HandoverDeps = {
          ...deps,
          readText: (path) =>
            path === join(repoRoot, ".ut-tdd", "handover", "CURRENT.json")
              ? `${JSON.stringify(unsigned)}\n`
              : null,
        };
        const warnings = checkHandoverBypass(signatureDeps);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("handover bypass: CURRENT.json");
        expect(warnings[0]).toContain("手書き");
      }
    });
  });
});

describe("Issue #1062: migration is frozen, verifiable, and atomic", () => {
  it.fails("U-STCHAN-022: dry-run selects only frozen untracked project episodes", () => {
    const root = tempRepo();
    const add = (kind: "feedback" | "project", title: string, body: string) =>
      writeMemory({ repoRoot: root, input: { kind, title, body } });
    const trackedFeedback = add("feedback", "Tracked feedback PR 701", "Keep this lesson.");
    const staged = spawnSync("git", ["add", trackedFeedback.source_path], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(staged.status).toBe(0);
    const untrackedFeedback = add("feedback", "PR 700 durable feedback", "Do not migrate lessons.");
    const numbered = add(
      "project",
      "PR 702 episodic note",
      "Untracked project episode with a number.",
    );
    const unnumbered = add(
      "project",
      "Unnumbered episodic note",
      "Untracked project episode without a number.",
    );
    const referenced = add(
      "project",
      "Open review task anchor",
      "An open review task still references this memory.",
    );
    const durableBeforeFreeze = add(
      "project",
      "Frozen durable invariant",
      "A pre-cutover permanent constraint.",
    );
    addDurableReason(root, durableBeforeFreeze.source_path, "pre-existing durable invariant");
    freezeTargetSnapshot(root, [numbered, unnumbered, referenced, durableBeforeFreeze]);
    const durableAfterFreeze = add(
      "project",
      "Post-cutover durable invariant",
      "A later accepted permanent constraint.",
    );
    addDurableReason(root, durableAfterFreeze.source_path, "accepted after the frozen snapshot");
    mkdirSync(join(root, ".ut-tdd", "review", "requests"), { recursive: true });
    const openRequest = {
      schemaVersion: "review-request/v1",
      memoryId: referenced.memory_id,
      pr: 283,
      exactHead: "a".repeat(40),
      reviewRevision: "rv1-open-request",
      authorFamily: "codex",
      requestedAt: "2026-10-16T00:00:00.000Z",
    };
    writeFileSync(
      join(root, ".ut-tdd", "review", "requests", "legacy-open.json"),
      `${JSON.stringify(openRequest)}\n`,
      "utf8",
    );
    const indexed = runCli(root, ["memory", "list", "--query", "durable invariant"]);
    expectStarted(indexed);
    expect(indexed.status).toBe(0);
    expect(indexed.stdout).toContain(durableBeforeFreeze.title);
    expect(indexed.stdout).toContain(durableAfterFreeze.title);
    const snapshotText = readFileSync(
      join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
      "utf8",
    );
    const snapshotRows = snapshotText
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(snapshotRows.map((row: { memory_id: string }) => row.memory_id).sort()).toEqual(
      [
        numbered.memory_id,
        unnumbered.memory_id,
        referenced.memory_id,
        durableBeforeFreeze.memory_id,
      ].sort(),
    );
    expect(
      snapshotRows.every(
        (row: Record<string, unknown>) =>
          Object.keys(row).sort().join(",") === "content_sha256,memory_id" &&
          typeof row.content_sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(row.content_sha256),
      ),
    ).toBe(true);
    expect(snapshotRows.map((row: { memory_id: string }) => row.memory_id)).not.toContain(
      durableAfterFreeze.memory_id,
    );
    const evidence = JSON.parse(
      readFileSync(join(root, "docs", "migration", "state-channel-target-snapshot.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(evidence).sort()).toEqual(["count", "recorded_at", "schema", "sha256"]);
    expect(evidence).toMatchObject({
      schema: "ut-tdd.state-channel-target-snapshot/v1",
      count: 4,
      sha256: createHash("sha256").update(snapshotText, "utf8").digest("hex"),
    });
    const durableBeforeFreezeBytes = readFileSync(join(root, durableBeforeFreeze.source_path));
    const before = {
      memory: snapshotTree(join(root, ".ut-tdd", "memory")),
      tracked: trackedPaths(
        root,
        ".ut-tdd/memory",
        "docs/migration/state-channel-target-snapshot.json",
      ),
      snapshot: readFileSync(
        join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
        "utf8",
      ),
      evidence: readFileSync(
        join(root, "docs", "migration", "state-channel-target-snapshot.json"),
        "utf8",
      ),
      db: runCli(root, ["db", "status", "--json"]),
    };
    expectStarted(before.db);
    expect(before.db.status).toBe(0);

    const result = runCli(root, [
      "memory",
      "retire",
      "--selector",
      "state-channel-snapshot",
      "--dry-run",
      "--json",
    ]);
    expectStarted(result);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    const moved = report.moved as Array<{ memory_id: string }>;
    const preserved = report.preserved as Array<{ memory_id: string; reason: string }>;
    expect(moved.map((item) => item.memory_id)).toEqual(
      [numbered.memory_id, unnumbered.memory_id].sort(),
    );
    expect(preserved.map((item) => item.memory_id)).toEqual(
      [
        trackedFeedback.memory_id,
        untrackedFeedback.memory_id,
        referenced.memory_id,
        durableBeforeFreeze.memory_id,
        durableAfterFreeze.memory_id,
      ].sort(),
    );
    expect(
      preserved.every((item) => typeof item.reason === "string" && item.reason.length > 0),
    ).toBe(true);
    // L6 §7.1 fixes a nonempty preservation reason, not a literal reason token.
    expect(
      preserved.find((item) => item.memory_id === referenced.memory_id)?.reason.length,
    ).toBeGreaterThan(0);
    const reportText = JSON.stringify(report);
    expect(reportText).toContain(numbered.memory_id);
    expect(reportText).toContain(unnumbered.memory_id);
    expect(reportText).toContain(referenced.memory_id);
    expect(reportText).toContain(durableBeforeFreeze.memory_id);
    expect(reportText).toContain(durableAfterFreeze.memory_id);
    expect(reportText).toContain("feedback");
    expect(report.total).toBe(7);
    expect(report.categories).toBeInstanceOf(Array);
    const categories = report.categories as Array<{ count: number }>;
    expect(categories.reduce((sum, category) => sum + category.count, 0)).toBe(7);
    expect(
      existsSync(join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl")),
    ).toBe(true);
    expect(existsSync(join(root, numbered.source_path))).toBe(true);
    expect(existsSync(join(root, unnumbered.source_path))).toBe(true);
    expect(existsSync(join(root, durableBeforeFreeze.source_path))).toBe(true);
    expect(existsSync(join(root, durableAfterFreeze.source_path))).toBe(true);
    expect(readFileSync(join(root, durableBeforeFreeze.source_path))).toEqual(
      durableBeforeFreezeBytes,
    );
    expect(trackedPaths(root, trackedFeedback.source_path)).toEqual([trackedFeedback.source_path]);
    expect(trackedPaths(root, untrackedFeedback.source_path)).toEqual([]);
    for (const title of [durableBeforeFreeze.title, durableAfterFreeze.title]) {
      const search = runCli(root, ["memory", "list", "--query", title]);
      expectStarted(search);
      expect(search.status).toBe(0);
      expect(search.stdout).toContain(title);
    }
    const afterDb = runCli(root, ["db", "status", "--json"]);
    expectStarted(afterDb);
    expect(afterDb.status).toBe(0);
    expect({
      memory: snapshotTree(join(root, ".ut-tdd", "memory")),
      tracked: trackedPaths(
        root,
        ".ut-tdd/memory",
        "docs/migration/state-channel-target-snapshot.json",
      ),
      snapshot: readFileSync(
        join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
        "utf8",
      ),
      evidence: readFileSync(
        join(root, "docs", "migration", "state-channel-target-snapshot.json"),
        "utf8",
      ),
      db: afterDb.stdout,
    }).toEqual({
      memory: before.memory,
      tracked: before.tracked,
      snapshot: before.snapshot,
      evidence: before.evidence,
      db: before.db.stdout,
    });
  });

  it.fails("U-STCHAN-024: real-repository migration dry-run is read-only and accounts for all files", () => {
    const paths = [".ut-tdd/memory", ".ut-tdd/handover"] as const;
    const before = {
      memory: snapshotTree(join(repoRoot, paths[0])),
      handover: snapshotTree(join(repoRoot, paths[1])),
      tracked: trackedPaths(repoRoot, ...paths),
      db: runCli(repoRoot, ["db", "status", "--json"]),
    };
    expectStarted(before.db);
    expect(before.db.status).toBe(0);
    const memoryRun = runCli(repoRoot, [
      "memory",
      "retire",
      "--selector",
      "state-channel-snapshot",
      "--dry-run",
      "--json",
    ]);
    expectStarted(memoryRun);
    expect(memoryRun.status).toBe(0);
    const handoverRun = runCli(repoRoot, ["handover", "archive", "--dry-run", "--json"]);
    expectStarted(handoverRun);
    expect(handoverRun.status).toBe(0);
    const memoryReport = JSON.parse(memoryRun.stdout);
    const handoverReport = JSON.parse(handoverRun.stdout);
    expect(before.tracked.filter((path) => path.startsWith(".ut-tdd/memory/")).length).toBe(46);
    expect(memoryReport.total).toBe(
      memoryReport.categories.reduce((sum: number, row: { count: number }) => sum + row.count, 0),
    );
    expect(memoryReport.total).toBe(readdirSync(join(repoRoot, paths[0])).length);
    expect(memoryReport.categories).toEqual([
      { category: "moved", count: memoryReport.moved.length },
      { category: "preserved", count: memoryReport.preserved.length },
    ]);
    const trackedMemory = before.tracked.filter((path) => path.startsWith(".ut-tdd/memory/"));
    expect(
      memoryReport.moved.some((item: { source_path: string }) =>
        trackedMemory.includes(item.source_path),
      ),
    ).toBe(false);
    expect(
      trackedMemory.every((path) =>
        memoryReport.preserved.some((item: { source_path: string }) => item.source_path === path),
      ),
    ).toBe(true);
    expect(handoverReport.moved.length + handoverReport.preserved.length).toBe(
      readdirSync(join(repoRoot, paths[1])).length,
    );
    const reportedHandoverPaths = [
      ...handoverReport.moved.map((item: { sourcePath: string }) => item.sourcePath),
      ...handoverReport.preserved.map((item: { path: string }) => item.path),
    ];
    expect(new Set(reportedHandoverPaths).size).toBe(reportedHandoverPaths.length);
    const afterDb = runCli(repoRoot, ["db", "status", "--json"]);
    expectStarted(afterDb);
    expect(afterDb.status).toBe(0);
    expect({
      memory: snapshotTree(join(repoRoot, paths[0])),
      handover: snapshotTree(join(repoRoot, paths[1])),
      tracked: trackedPaths(repoRoot, ...paths),
      db: afterDb.stdout,
    }).toEqual({
      memory: before.memory,
      handover: before.handover,
      tracked: before.tracked,
      db: before.db.stdout,
    });
  });

  describe("U-STCHAN-023: handover prose archive", () => {
    let root: string;
    let month: string;
    let oldPath: string;
    let recentPath: string;
    let oldBytes: string;
    let dryRun: ReturnType<typeof runCli>;
    let beforeDryRun: string[];
    let afterDryRun: string[];
    let archiveRootExistsAfterDryRun: boolean;
    let archiveRun: ReturnType<typeof runCli>;
    let afterArchive: string[];

    beforeAll(() => {
      root = tempRepo();
      const handoverRoot = join(root, ".ut-tdd", "handover");
      mkdirSync(join(handoverRoot, "provider"), { recursive: true });
      mkdirSync(join(handoverRoot, "archive"), { recursive: true });
      writeFileSync(join(handoverRoot, "CURRENT.json"), '{"active_plan":"PLAN-L7-04"}\n');
      writeFileSync(join(handoverRoot, ".gitkeep"), "");
      writeFileSync(join(handoverRoot, "provider", "current.json"), "{}\n");
      writeFileSync(join(handoverRoot, "archive", "keep.md"), "nested files are not scanned\n");
      oldPath = join(handoverRoot, "closed-session.md");
      oldBytes = "historical handover prose\n";
      writeFileSync(oldPath, oldBytes);
      recentPath = join(handoverRoot, "running-watch.sh");
      writeFileSync(recentPath, "#!/bin/sh\nwhile true; do sleep 60; done\n");

      const now = new Date();
      month = now.toISOString().slice(0, 7);
      const oldTime = new Date(now.getTime() - 48 * 60 * 60 * 1000);
      const recentTime = new Date(now.getTime() - 60 * 60 * 1000);
      utimesSync(oldPath, oldTime, oldTime);
      utimesSync(recentPath, recentTime, recentTime);
      expect(statSync(oldPath).mtimeMs).toBeLessThan(now.getTime() - 24 * 60 * 60 * 1000);
      expect(statSync(recentPath).mtimeMs).toBeGreaterThan(now.getTime() - 24 * 60 * 60 * 1000);

      const archiveRoot = join(root, ".ut-tdd", "archive", "handover-prose");
      beforeDryRun = snapshotTree(handoverRoot);
      dryRun = runCli(root, ["handover", "archive", "--dry-run"]);
      expectStarted(dryRun);
      expect(dryRun.status).not.toBeNull();
      afterDryRun = snapshotTree(handoverRoot);
      archiveRootExistsAfterDryRun = existsSync(archiveRoot);

      archiveRun = runCli(root, ["handover", "archive", "--archive"]);
      expectStarted(archiveRun);
      expect(archiveRun.status).not.toBeNull();
      afterArchive = snapshotTree(root);
    }, 30_000);

    it.fails("U-STCHAN-023: moves only old direct prose with a done manifest and keeps dry-run read-only", () => {
      expect(dryRun.status).toBe(0);
      expect(afterDryRun).toEqual(beforeDryRun);
      expect(archiveRootExistsAfterDryRun).toBe(false);
      expect(archiveRun.status).toBe(0);

      const destination = join(
        root,
        ".ut-tdd",
        "archive",
        "handover-prose",
        month,
        "closed-session.md",
      );
      const manifestPath = join(root, ".ut-tdd", "archive", "handover-prose", "manifest.jsonl");
      expect(existsSync(oldPath)).toBe(false);
      expect(readFileSync(destination, "utf8")).toBe(oldBytes);
      expect(existsSync(recentPath)).toBe(true);
      expect(readFileSync(recentPath, "utf8")).toContain("while true");
      for (const path of [
        ".ut-tdd/handover/CURRENT.json",
        ".ut-tdd/handover/.gitkeep",
        ".ut-tdd/handover/provider/current.json",
        ".ut-tdd/handover/archive/keep.md",
      ])
        expect(existsSync(join(root, path))).toBe(true);
      const manifest = readFileSync(manifestPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(manifest).toHaveLength(2);
      expect(manifest.map((row) => row.state)).toEqual(["intent", "done"]);
      expect(
        manifest.every(
          (row) =>
            Object.keys(row).sort().join(",") ===
              "destination_path,recorded_at,schema,sha256,source_path,state" &&
            row.schema === "ut-tdd.handover-prose-archive/v1" &&
            row.sha256 === createHash("sha256").update(oldBytes, "utf8").digest("hex") &&
            row.source_path === ".ut-tdd/handover/closed-session.md" &&
            row.destination_path === `.ut-tdd/archive/handover-prose/${month}/closed-session.md` &&
            typeof row.recorded_at === "string" &&
            Number.isFinite(Date.parse(row.recorded_at)),
        ),
      ).toBe(true);
      expect(afterArchive).toContain(
        `.ut-tdd/archive/handover-prose/${month}/file:closed-session.md:${createHash("sha256").update(oldBytes, "utf8").digest("hex")}`,
      );
    });
  });

  function defineSnapshotMismatchCase(
    label: string,
    expectedReason: "target_snapshot_digest_mismatch" | "target_snapshot_missing",
    mutate: (root: string) => void,
  ): void {
    describe(label, () => {
      let root: string;
      let result: ReturnType<typeof runCli>;
      let before: Record<string, unknown>;
      let after: Record<string, unknown>;

      beforeAll(() => {
        root = tempRepo();
        const entries = ["One frozen episode", "Two frozen episode", "Three frozen episode"].map(
          (title) =>
            writeMemory({
              repoRoot: root,
              input: { kind: "project", title, body: `fixture body for ${title}` },
            }),
        );
        const rebuild = runCli(root, ["db", "rebuild", "--json"]);
        expectStarted(rebuild);
        expect(rebuild.status).toBe(0);
        expect(readIndexedMemoryRows(root)).toHaveLength(entries.length);
        freezeTargetSnapshot(root, entries);
        mutate(root);
        const snapshotPath = join(
          root,
          ".ut-tdd",
          "archive",
          "memory-episodes",
          "target-snapshot.jsonl",
        );
        const evidencePath = join(root, "docs", "migration", "state-channel-target-snapshot.json");
        before = {
          memory: snapshotTree(join(root, ".ut-tdd", "memory")),
          rows: readIndexedMemoryRows(root),
          snapshotExists: existsSync(snapshotPath),
          snapshot: existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : null,
          evidence: readFileSync(evidencePath, "utf8"),
          archive: snapshotTree(join(root, ".ut-tdd", "archive", "memory-episodes")),
          tracked: trackedPaths(
            root,
            ".ut-tdd/memory",
            ".ut-tdd/archive/memory-episodes",
            "docs/migration/state-channel-target-snapshot.json",
          ),
        };
        result = runCli(root, [
          "memory",
          "retire",
          "--selector",
          "state-channel-snapshot",
          "--archive",
        ]);
        expectStarted(result);
        expect(result.status).not.toBeNull();
        after = {
          memory: snapshotTree(join(root, ".ut-tdd", "memory")),
          rows: readIndexedMemoryRows(root),
          snapshotExists: existsSync(snapshotPath),
          snapshot: existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : null,
          evidence: readFileSync(evidencePath, "utf8"),
          archive: snapshotTree(join(root, ".ut-tdd", "archive", "memory-episodes")),
          tracked: trackedPaths(
            root,
            ".ut-tdd/memory",
            ".ut-tdd/archive/memory-episodes",
            "docs/migration/state-channel-target-snapshot.json",
          ),
        };
      }, 30_000);

      it.fails("U-STCHAN-025: rejects a frozen target snapshot before moving files or changing index rows", () => {
        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expectedReason);
        expect(after).toEqual(before);
      });
    });
  }

  function appendCanonicalSnapshotRow(root: string): void {
    const path = join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl");
    const rows = readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { memory_id: string; content_sha256: string });
    rewriteTargetSnapshotRows(root, [
      ...rows,
      { memory_id: "memory:project:added-after-freeze", content_sha256: "a".repeat(64) },
    ]);
  }

  function removeCanonicalSnapshotRow(root: string): void {
    const path = join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl");
    const rows = readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { memory_id: string; content_sha256: string });
    rewriteTargetSnapshotRows(root, rows.slice(1));
  }

  function replaceCanonicalSnapshotRow(root: string): void {
    const path = join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl");
    const rows = readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { memory_id: string; content_sha256: string });
    const first = rows[0];
    if (!first) throw new Error("snapshot fixture row missing");
    rewriteTargetSnapshotRows(root, [
      { ...first, content_sha256: "f".repeat(64) },
      ...rows.slice(1),
    ]);
  }

  defineSnapshotMismatchCase(
    "U-STCHAN-025 add row",
    "target_snapshot_digest_mismatch",
    appendCanonicalSnapshotRow,
  );
  defineSnapshotMismatchCase(
    "U-STCHAN-025 remove row",
    "target_snapshot_digest_mismatch",
    removeCanonicalSnapshotRow,
  );
  defineSnapshotMismatchCase(
    "U-STCHAN-025 replace row digest",
    "target_snapshot_digest_mismatch",
    replaceCanonicalSnapshotRow,
  );
  defineSnapshotMismatchCase("U-STCHAN-025 missing snapshot", "target_snapshot_missing", (root) => {
    const path = join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl");
    if (!existsSync(path)) throw new Error("snapshot fixture missing before mutation");
    unlinkSync(path);
  });

  function defineWriterExistsCase(
    label: string,
    setup: (root: string, base: ReturnType<typeof writeMemory>) => void,
  ): void {
    describe(label, () => {
      let root: string;
      let result: ReturnType<typeof runCli>;
      let before: Record<string, unknown>;
      let after: Record<string, unknown>;

      beforeAll(() => {
        root = tempRepo();
        const base = writeMemory({
          repoRoot: root,
          input: {
            kind: "project",
            title: "Frozen writer fixture",
            body: "A valid project memory before the writer retry.",
          },
        });
        setup(root, base);
        const rebuild = runCli(root, ["db", "rebuild", "--json"]);
        expectStarted(rebuild);
        expect(rebuild.status).toBe(0);
        before = {
          memory: snapshotTree(join(root, ".ut-tdd", "memory")),
          rows: readIndexedMemoryRows(root),
          snapshot: existsSync(
            join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
          )
            ? readFileSync(
                join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
                "utf8",
              )
            : null,
          evidence: existsSync(
            join(root, "docs", "migration", "state-channel-target-snapshot.json"),
          )
            ? readFileSync(
                join(root, "docs", "migration", "state-channel-target-snapshot.json"),
                "utf8",
              )
            : null,
          tracked: trackedPaths(
            root,
            ".ut-tdd/memory",
            ".ut-tdd/archive/memory-episodes",
            "docs/migration/state-channel-target-snapshot.json",
          ),
        };
        if (!base.memory_id) throw new Error("writer fixture memory was not created");
        result = runCli(root, [
          "memory",
          "retire",
          "--record-target-snapshot",
          "--recorded-at",
          "2026-10-16T00:10:00.000Z",
        ]);
        expectStarted(result);
        expect(result.status).not.toBeNull();
        after = {
          memory: snapshotTree(join(root, ".ut-tdd", "memory")),
          rows: readIndexedMemoryRows(root),
          snapshot: existsSync(
            join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
          )
            ? readFileSync(
                join(root, ".ut-tdd", "archive", "memory-episodes", "target-snapshot.jsonl"),
                "utf8",
              )
            : null,
          evidence: existsSync(
            join(root, "docs", "migration", "state-channel-target-snapshot.json"),
          )
            ? readFileSync(
                join(root, "docs", "migration", "state-channel-target-snapshot.json"),
                "utf8",
              )
            : null,
          tracked: trackedPaths(
            root,
            ".ut-tdd/memory",
            ".ut-tdd/archive/memory-episodes",
            "docs/migration/state-channel-target-snapshot.json",
          ),
        };
      }, 30_000);

      it.fails("U-STCHAN-026: refuses to replace an existing frozen snapshot or evidence file", () => {
        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain("target_snapshot_exists");
        expect(after).toEqual(before);
      });
    });
  }

  defineWriterExistsCase("U-STCHAN-026 same snapshot content", (root, base) => {
    freezeTargetSnapshot(root, [base]);
  });

  defineWriterExistsCase("U-STCHAN-026 new project memory after freeze", (root, base) => {
    freezeTargetSnapshot(root, [base]);
    writeMemory({
      repoRoot: root,
      input: {
        kind: "project",
        title: "Added after freeze",
        body: "A later episode must not permit re-freezing.",
      },
    });
  });

  defineWriterExistsCase("U-STCHAN-026 evidence without snapshot", (root) => {
    const evidencePath = join(root, "docs", "migration", "state-channel-target-snapshot.json");
    mkdirSync(join(root, "docs", "migration"), { recursive: true });
    const evidence = canonicalize({
      schema: "ut-tdd.state-channel-target-snapshot/v1",
      sha256: createHash("sha256").update("", "utf8").digest("hex"),
      count: 0,
      recorded_at: "2026-10-16T00:00:00.000Z",
    });
    if (!evidence.ok) throw new Error("snapshot evidence fixture must canonicalize");
    writeFileSync(evidencePath, `${evidence.value}\n`, "utf8");
  });

  function filesBelow(root: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : [];
    });
  }

  function defineChangedTargetBytesCase(
    label: string,
    targetIndex: number,
    mutate: (root: string, entry: ReturnType<typeof writeMemory>) => void,
  ): void {
    describe(label, () => {
      let root: string;
      let targets: ReturnType<typeof writeMemory>[];
      let originalBytes: Buffer;
      let targetBytes: Map<string, Buffer>;
      let result: ReturnType<typeof runCli>;
      let before: Record<string, unknown>;
      let afterFailure: Record<string, unknown>;

      beforeAll(() => {
        root = tempRepo();
        targets = [
          "First frozen byte target",
          "Second frozen byte target",
          "Third frozen byte target",
        ].map((title) =>
          writeMemory({
            repoRoot: root,
            input: { kind: "project", title, body: `fixture body for ${title}` },
          }),
        );
        const rebuild = runCli(root, ["db", "rebuild", "--json"]);
        expectStarted(rebuild);
        expect(rebuild.status).toBe(0);
        expect(readIndexedMemoryRows(root)).toHaveLength(targets.length);
        freezeTargetSnapshot(root, targets);
        targetBytes = new Map(
          targets.map((entry) => [entry.memory_id, readFileSync(join(root, entry.source_path))]),
        );
        const target = requireDefined(targets[targetIndex], "selected frozen target");
        originalBytes = requireDefined(targetBytes.get(target.memory_id), "original target bytes");
        mutate(root, target);
        expect(readFileSync(join(root, target.source_path))).not.toEqual(originalBytes);
        const snapshotPath = join(
          root,
          ".ut-tdd",
          "archive",
          "memory-episodes",
          "target-snapshot.jsonl",
        );
        const evidencePath = join(root, "docs", "migration", "state-channel-target-snapshot.json");
        before = {
          memory: snapshotTree(join(root, ".ut-tdd", "memory")),
          rows: readIndexedMemoryRows(root),
          snapshot: readFileSync(snapshotPath, "utf8"),
          evidence: readFileSync(evidencePath, "utf8"),
          archive: snapshotTree(join(root, ".ut-tdd", "archive", "memory-episodes")),
        };
        result = runCli(root, [
          "memory",
          "retire",
          "--selector",
          "state-channel-snapshot",
          "--archive",
        ]);
        expectStarted(result);
        expect(result.status).not.toBeNull();
        afterFailure = {
          memory: snapshotTree(join(root, ".ut-tdd", "memory")),
          rows: readIndexedMemoryRows(root),
          snapshot: readFileSync(snapshotPath, "utf8"),
          evidence: readFileSync(evidencePath, "utf8"),
          archive: snapshotTree(join(root, ".ut-tdd", "archive", "memory-episodes")),
        };
      }, 30_000);

      it.fails("U-STCHAN-027: fails closed on changed frozen bytes and succeeds after exact restore", () => {
        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain("target_bytes_changed");
        expect(afterFailure).toEqual(before);

        const target = requireDefined(targets[targetIndex], "selected frozen target");
        writeFileSync(join(root, target.source_path), originalBytes);
        const restoredRun = runCli(root, [
          "memory",
          "retire",
          "--selector",
          "state-channel-snapshot",
          "--archive",
        ]);
        expectStarted(restoredRun);
        expect(restoredRun.status).toBe(0);
        for (const entry of targets) {
          const source = join(root, entry.source_path);
          const expectedBytes = requireDefined(targetBytes.get(entry.memory_id), "target bytes");
          const expectedDigest = createHash("sha256").update(expectedBytes).digest("hex");
          expect(existsSync(source)).toBe(false);
          const archivedMatches = filesBelow(
            join(root, ".ut-tdd", "archive", "memory-episodes"),
          ).filter(
            (path) =>
              createHash("sha256").update(readFileSync(path)).digest("hex") === expectedDigest,
          );
          expect(archivedMatches).toHaveLength(1);
        }
        expect(readIndexedMemoryRows(root)).toHaveLength(0);
      });
    });
  }

  defineChangedTargetBytesCase("U-STCHAN-027 one-byte body mutation", 0, (root, entry) => {
    const path = join(root, entry.source_path);
    const bytes = readFileSync(path);
    const bodyOffset = bytes.indexOf(Buffer.from("fixture body for"));
    if (bodyOffset < 0) throw new Error("memory fixture body marker missing");
    bytes[bodyOffset] = bytes[bodyOffset] === 0x66 ? 0x67 : 0x66;
    writeFileSync(path, bytes);
  });

  defineChangedTargetBytesCase(
    "U-STCHAN-027 post-freeze durable reason mutation",
    1,
    (root, entry) => {
      addDurableReason(root, entry.source_path, "added after the frozen snapshot");
    },
  );

  describe("U-STCHAN-028: isolated actual archive keeps rows and search aligned", () => {
    let root: string;
    let targets: ReturnType<typeof writeMemory>[];
    let durableBeforeFreeze: ReturnType<typeof writeMemory>;
    let durableAfterFreeze: ReturnType<typeof writeMemory>;
    let untrackedFeedback: ReturnType<typeof writeMemory>;
    let trackedFeedback: ReturnType<typeof writeMemory>;
    let entries: ReturnType<typeof writeMemory>[];
    let originalBytes: Map<string, Buffer>;
    let beforeRows: Record<string, unknown>[];
    let archiveRun: ReturnType<typeof runCli>;
    let afterRows: Record<string, unknown>[];
    let statusRun: ReturnType<typeof runCli>;
    let sourceFilesAfter: string[];

    beforeAll(() => {
      root = tempRepo();
      targets = ["First archived episode", "Second archived episode"].map((title) =>
        writeMemory({
          repoRoot: root,
          input: { kind: "project", title, body: `episode body for ${title}` },
        }),
      );
      durableBeforeFreeze = writeMemory({
        repoRoot: root,
        input: {
          kind: "project",
          title: "R1 frozen durable",
          body: "Keep this frozen constraint.",
        },
      });
      addDurableReason(root, durableBeforeFreeze.source_path, "durable before snapshot");
      freezeTargetSnapshot(root, [...targets, durableBeforeFreeze]);

      // Candidate 028 exercises archive retention of R2's persisted shape only;
      // admission through the cutover memory-add policy is a separate oracle.
      durableAfterFreeze = writeMemory({
        repoRoot: root,
        input: { kind: "project", title: "R2 later durable", body: "Keep this later constraint." },
      });
      addDurableReason(root, durableAfterFreeze.source_path, "accepted after snapshot");
      untrackedFeedback = writeMemory({
        repoRoot: root,
        input: { kind: "feedback", title: "Untracked feedback lesson", body: "Keep searchable." },
      });
      trackedFeedback = writeMemory({
        repoRoot: root,
        input: {
          kind: "feedback",
          title: "Tracked feedback lesson",
          body: "Keep tracked and searchable.",
        },
      });
      const staged = spawnSync("git", ["add", trackedFeedback.source_path], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(staged.status).toBe(0);
      entries = [
        ...targets,
        durableBeforeFreeze,
        durableAfterFreeze,
        untrackedFeedback,
        trackedFeedback,
      ];
      originalBytes = new Map(
        entries.map((entry) => [entry.memory_id, readFileSync(join(root, entry.source_path))]),
      );

      const rebuild = runCli(root, ["db", "rebuild", "--json"]);
      expectStarted(rebuild);
      expect(rebuild.status).toBe(0);
      beforeRows = readIndexedMemoryRows(root);
      expect(beforeRows).toHaveLength(entries.length);
      const beforeDbStatus = runCli(root, ["db", "status", "--json"]);
      expectStarted(beforeDbStatus);
      expect(beforeDbStatus.status).toBe(0);

      archiveRun = runCli(root, [
        "memory",
        "retire",
        "--selector",
        "state-channel-snapshot",
        "--archive",
      ]);
      expectStarted(archiveRun);
      expect(archiveRun.status).not.toBeNull();
      afterRows = readIndexedMemoryRows(root);
      sourceFilesAfter = filesBelow(join(root, ".ut-tdd", "memory"));
      statusRun = runCli(root, ["db", "status", "--json"]);
      expectStarted(statusRun);
      expect(statusRun.status).not.toBeNull();
    }, 30_000);

    it.fails("U-STCHAN-028: archives two target rows while retained memories remain searchable", () => {
      expect(archiveRun.status).toBe(0);
      const movedIds = new Set(targets.map((entry) => entry.memory_id));
      const retainedEntries = entries.filter((entry) => !movedIds.has(entry.memory_id));
      const expectedRetainedRows = beforeRows.filter((row) => !movedIds.has(String(row.memory_id)));
      expect(afterRows).toEqual(expectedRetainedRows);
      expect(afterRows).toHaveLength(4);
      expect(sourceFilesAfter.sort()).toEqual(
        retainedEntries.map((entry) => join(root, entry.source_path)).sort(),
      );

      const archiveFiles = filesBelow(join(root, ".ut-tdd", "archive", "memory-episodes"));
      for (const entry of targets) {
        const source = join(root, entry.source_path);
        const bytes = requireDefined(originalBytes.get(entry.memory_id), "target source bytes");
        const digest = createHash("sha256").update(bytes).digest("hex");
        expect(existsSync(source)).toBe(false);
        expect(
          archiveFiles.filter(
            (path) => createHash("sha256").update(readFileSync(path)).digest("hex") === digest,
          ),
        ).toHaveLength(1);
      }

      for (const entry of retainedEntries) {
        const source = join(root, entry.source_path);
        expect(readFileSync(source)).toEqual(
          requireDefined(originalBytes.get(entry.memory_id), "retained source bytes"),
        );
        const search = runCli(root, ["memory", "list", "--query", entry.title]);
        expectStarted(search);
        expect(search.status).toBe(0);
        expect(search.stdout).toContain(entry.title);
      }
      for (const entry of targets) {
        const search = runCli(root, ["memory", "list", "--query", entry.title]);
        expectStarted(search);
        expect(search.status).toBe(0);
        expect(search.stdout).not.toContain(entry.title);
      }

      expect(trackedPaths(root, trackedFeedback.source_path)).toEqual([
        trackedFeedback.source_path,
      ]);
      expect(trackedPaths(root, untrackedFeedback.source_path)).toEqual([]);
      expect(durableBeforeFreeze.memory_id).not.toBe(durableAfterFreeze.memory_id);
      const dbStatus = JSON.parse(statusRun.stdout) as {
        initialized: boolean;
        schemaVersion: number;
        expectedVersion: number;
        missingTables: string[];
      };
      expect(dbStatus.initialized).toBe(true);
      expect(dbStatus.schemaVersion).toBe(dbStatus.expectedVersion);
      expect(dbStatus.missingTables).toEqual([]);
      const db = openReadOnlyHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      let memoryRead: ReturnType<typeof readMemory>;
      try {
        memoryRead = readMemory({ repoRoot: root, db });
      } finally {
        db.close();
      }
      expect(memoryRead.freshness).toBe("fresh");
      expect(memoryRead.entries.map((entry) => entry.memory_id).sort()).toEqual(
        retainedEntries.map((entry) => entry.memory_id).sort(),
      );
      expect(afterRows.length + movedIds.size).toBe(beforeRows.length);
    }, 30_000);
  });
});
