import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryEntry } from "../memory/index.ts";
import { isCanonicalMemorySourcePath } from "../memory/service.ts";
import { ensureDir } from "../shared/fs.ts";
import {
  activateClaudeWakeGeneration,
  CLAUDE_WAKE_GENERATION_SCHEMA,
  type ClaudeWakeAuthority,
  inspectClaudeWakeGeneration,
  parseClaudeWakeGeneration,
  validateClaudeWakeClaimAuthority,
} from "./claude-wake-generation-upgrade.ts";
import { requireProjectMemoryRoot } from "./project-memory-root.ts";

export const CLAUDE_INBOX_SCHEMA = "ut-tdd.claude-inbox/v3" as const;
/** Project-bound provider envelopes are deliberately a new exact-key schema. */
export const CLAUDE_INBOX_LEGACY_SCHEMA = "ut-tdd.claude-inbox/v2" as const;
export const CLAUDE_WAKE_BODY_MAX_CHARS = 8_000;
export const CLAUDE_INBOX_BACKLOG_WARN_AGE_MS = 15 * 60 * 1_000;
export { CLAUDE_WAKE_GENERATION_SCHEMA };
export const CLAUDE_INBOX_TERMINAL_SCHEMA = "ut-tdd.claude-inbox-terminal/v1" as const;

function runtimeSourceRevision(): string {
  const override = process.env.UT_TDD_RUNTIME_SOURCE_REVISION?.trim();
  if (override) return override;
  const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const cwd of [moduleRoot, process.cwd()]) {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // A sealed consumer supplies the revision through the runtime receipt override.
    }
  }
  throw new Error("claude_wake_runtime_revision_required");
}
export type ClaudeLiveWorkspaceRoutingFailure =
  | "no_live_claude_workspace"
  | "ambiguous_live_claude_workspace"
  | "stale_claude_workspace"
  | "incompatible_claude_workspace_schema";

export type ClaudeLiveWorkspaceResolution =
  | { readonly ok: true; readonly workspaceId: string }
  | { readonly ok: false; readonly reason: ClaudeLiveWorkspaceRoutingFailure };
export type ClaudeLiveTargetResolution =
  | { readonly ok: true; readonly workspaceId: string; readonly sessionId: string }
  | { readonly ok: false; readonly reason: ClaudeLiveWorkspaceRoutingFailure };
export type ClaudeInboxWarningCode =
  | "age"
  | "target_mismatch"
  | "session_absent"
  | "session_unknown"
  | "hook_missing";

/** Pull request facts are an observation, never an inferred lifecycle state. */
export interface ClaudeInboxPullRequestObservation {
  readonly pr: number;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly headSha: string;
}

/** Parse one `gh pr view --json state,mergedAt,headRefOid` observation fail-closed. */
export function parseClaudeInboxPullRequestObservation(
  pr: number,
  raw: string,
): ClaudeInboxPullRequestObservation | undefined {
  try {
    const value = JSON.parse(raw) as {
      state?: unknown;
      mergedAt?: unknown;
      headRefOid?: unknown;
    };
    if (typeof value.headRefOid !== "string" || !/^[a-f0-9]{40}$/i.test(value.headRefOid)) {
      return undefined;
    }
    const state =
      typeof value.mergedAt === "string" && value.mergedAt.trim()
        ? "MERGED"
        : value.state === "OPEN" || value.state === "CLOSED"
          ? value.state
          : undefined;
    return state ? { pr, state, headSha: value.headRefOid } : undefined;
  } catch {
    return undefined;
  }
}

export type ClaudeInboxTerminalReason =
  | "claimed"
  | "pr_merged"
  | "pr_closed"
  | "stale_head_replaced";

export interface ClaudeInboxReviewReceiptIdentity {
  readonly requestDigest: string;
  readonly requestPath: string;
  readonly memoryPath: string;
  readonly pr: number;
  readonly exactHead: string;
  readonly reviewRevision: string;
  readonly authorFamily: "codex" | "claude";
}

export interface ClaudeInboxTerminalMarker {
  readonly schema: typeof CLAUDE_INBOX_TERMINAL_SCHEMA;
  readonly entryId: string;
  readonly reason: ClaudeInboxTerminalReason;
  readonly terminalAt: string;
  readonly purpose: "memory" | "review";
  readonly requestDigest?: string;
  readonly requestPath?: string;
  readonly memoryPath?: string;
  readonly pr?: number;
  readonly exactHead?: string;
  readonly reviewRevision?: string;
  readonly authorFamily?: "codex" | "claude";
}

export type ClaudeInboxTerminalDecision =
  | { readonly terminal: false }
  | {
      readonly terminal: true;
      readonly reason: ClaudeInboxTerminalReason;
      readonly receipt?: ClaudeInboxReviewReceiptIdentity;
    };

interface ClaudeInboxBase {
  readonly id: string;
  readonly memoryId: string;
  readonly body: string;
  readonly originRuntime: "codex" | "system";
  readonly operationId: string;
  readonly targetWorkspaceId: string;
  readonly createdAt: string;
}

const INBOX_SOURCE_FILE = Symbol("claudeInboxSourceFile");
type InboxEntryWithSource = ClaudeInboxEntry & { readonly [INBOX_SOURCE_FILE]?: string };

export type {
  ClaudeProvider,
  ClaudeProviderEnvelope,
  ClaudeProviderEnvelopeDenyReason,
  ClaudeProviderEnvelopeExpectation,
  ClaudeProviderEnvelopeValidation,
  ClaudeProviderInboxEntry,
  ClaudeProviderMemoryInboxEntry,
  ClaudeProviderReviewInboxEntry,
  ClaudeProviderTarget,
} from "./claude-provider-envelope.ts";
export {
  buildClaudeProviderInboxEntry,
  buildClaudeProviderReviewInboxEntry,
  CLAUDE_PROVIDER_INBOX_SCHEMA,
  computeClaudeProviderEntryId,
  computeClaudeProviderEnvelopeDigest,
  validateClaudeProviderEnvelope,
} from "./claude-provider-envelope.ts";

import {
  CLAUDE_PROVIDER_INBOX_SCHEMA,
  type ClaudeProvider,
  type ClaudeProviderEnvelopeDenyReason,
  type ClaudeProviderEnvelopeExpectation,
  type ClaudeProviderEnvelopeValidation,
  type ClaudeProviderInboxEntry,
  type ClaudeProviderMemoryInboxEntry,
  type ClaudeProviderReviewInboxEntry,
  computeClaudeProviderEntryId,
  computeClaudeProviderEnvelopeDigest,
  isValidClaudeProviderEnvelopeShape,
  validateClaudeProviderConsumerEnvelope,
} from "./claude-provider-envelope.ts";

export interface ClaudeMemoryInboxEntry extends ClaudeInboxBase {
  readonly schemaVersion: typeof CLAUDE_INBOX_SCHEMA;
  readonly purpose: "memory";
}

export interface ClaudeReviewInboxEntry extends ClaudeInboxBase {
  readonly schemaVersion: typeof CLAUDE_INBOX_SCHEMA;
  readonly purpose: "review";
  readonly requestDigest: string;
  readonly requestPath: string;
  readonly memoryPath: string;
  readonly pr: number;
  readonly exactHead: string;
  readonly reviewRevision: string;
  readonly authorFamily: "codex" | "claude";
}

export interface ClaudeLegacyInboxEntry extends ClaudeInboxBase {
  readonly schemaVersion: typeof CLAUDE_INBOX_LEGACY_SCHEMA;
  readonly purpose: "memory";
}

export type ClaudeInboxEntry =
  | ClaudeMemoryInboxEntry
  | ClaudeReviewInboxEntry
  | ClaudeProviderMemoryInboxEntry
  | ClaudeProviderReviewInboxEntry
  | ClaudeLegacyInboxEntry;

export interface ClaudeMemoryWakeResult {
  readonly kind: "delivered" | "timeout" | "superseded" | "denied";
  readonly entry?: ClaudeInboxEntry;
  readonly message?: string;
  readonly reason?: ClaudeProviderEnvelopeDenyReason | "legacy_schema_unbound";
}

const CLAUDE_PROVIDER_BINDING_SCHEMA = "ut-tdd.claude-provider-binding/v1" as const;
type ClaudeProviderEnvelopeBinding = ClaudeProviderEnvelopeExpectation & {
  readonly schemaVersion: typeof CLAUDE_PROVIDER_BINDING_SCHEMA;
  readonly entryId: string;
  readonly envelopeDigest: string;
};

type ClaudeProviderBindingReadResult =
  | { readonly ok: true; readonly binding: ClaudeProviderEnvelopeBinding }
  | {
      readonly ok: false;
      readonly reason: "envelope_binding_missing" | "envelope_binding_invalid";
    };

export interface ClaudeInboxBacklogSummary {
  readonly workspaceId: string;
  readonly pending: number;
  readonly oldestEntryId: string | null;
  readonly oldestCreatedAt: string | null;
  readonly oldestAgeMs: number | null;
  /** 共通runtime上の別workspace宛て未claim entry。strict filterで捨てない。 */
  readonly targetMismatchPending?: number;
  readonly targetMismatchOldestAgeMs?: number | null;
  /** workspace紐付けはmarkerに無い旧形式もあるため共有runtime単位の観測。 */
  readonly activeSessionCount?: number;
  readonly sessionStatus?: "active" | "absent" | "unknown";
  readonly hookConfigured?: boolean;
  readonly warningCodes?: readonly ClaudeInboxWarningCode[];
  /** terminal markerで再配信対象から除外したentry数（証跡は保持される）。 */
  readonly terminalized?: number;
}

export interface ClaudeMemoryWakeHookStatus {
  readonly configured: boolean;
  readonly reason: "configured" | "settings_missing" | "settings_invalid" | "stop_hook_missing";
}

export function isClaudeMemoryWakeTarget(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CLAUDE_CODE_ENTRYPOINT === "claude-vscode" && env.UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE !== "1"
  );
}

export function resolveClaudeWakeDelay(value: string | undefined, fallback: number): number {
  return value?.trim() ? Number(value) : fallback;
}

export function claudeWorkspaceId(repoRoot: string): string {
  return requireProjectMemoryRoot(repoRoot).projectNamespace;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}

function inboxFileStem(entryId: string): string {
  const stableHash = createHash("sha256").update(entryId).digest("hex").slice(0, 12);
  const safeId = safeFilePart(entryId);
  return `${safeId.slice(0, 147)}_${stableHash}`;
}

function runtimeRoot(repoRoot: string): string {
  return join(requireProjectMemoryRoot(repoRoot).runtimeBusRoot, "claude-memory-wake");
}

function providerBindingPath(repoRoot: string, entryId: string): string {
  return join(runtimeRoot(repoRoot), "envelope-bindings", `${inboxFileStem(entryId)}.json`);
}

function providerBindingFor(entry: ClaudeProviderInboxEntry): ClaudeProviderEnvelopeBinding {
  return {
    schemaVersion: CLAUDE_PROVIDER_BINDING_SCHEMA,
    entryId: entry.id,
    projectId: entry.projectId,
    memoryId: entry.memoryId,
    operationId: entry.operationId,
    producer: entry.producer,
    target: entry.target,
    envelopeDigest: entry.envelopeDigest,
  };
}

function writeProviderBinding(repoRoot: string, entry: ClaudeInboxEntry): void {
  if (entry.schemaVersion !== CLAUDE_PROVIDER_INBOX_SCHEMA) return;
  const binding = providerBindingFor(entry);
  const path = providerBindingPath(repoRoot, entry.id);
  ensureDir(dirname(path), { recursive: true });
  const serialized = JSON.stringify(binding);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8").trim() === serialized) return;
    throw new Error("claude_provider_binding_conflict");
  }
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${serialized}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function removeProviderBinding(repoRoot: string, entry: ClaudeInboxEntry): void {
  if (entry.schemaVersion !== CLAUDE_PROVIDER_INBOX_SCHEMA) return;
  try {
    unlinkSync(providerBindingPath(repoRoot, entry.id));
  } catch {
    // 既にterminal cleanupされた場合は冪等に扱う。
  }
}

function validateProviderBinding(input: {
  repoRoot: string;
  entry: ClaudeProviderInboxEntry;
  provider: ClaudeProvider;
  sessionId: string;
}): ClaudeProviderEnvelopeValidation {
  const { repoRoot, entry, provider, sessionId } = input;
  const bindingResult = readProviderBinding(repoRoot, entry);
  if (!bindingResult.ok) return bindingResult;
  return validateClaudeProviderConsumerEnvelope({
    entry,
    projectId: requireProjectMemoryRoot(repoRoot).projectId,
    provider,
    sessionId,
    expectedMemoryId: bindingResult.binding.memoryId,
    expectedOperationId: bindingResult.binding.operationId,
    expectedProducer: bindingResult.binding.producer,
  });
}

function readProviderBinding(
  repoRoot: string,
  entry: ClaudeProviderInboxEntry,
): ClaudeProviderBindingReadResult {
  const path = providerBindingPath(repoRoot, entry.id);
  if (!existsSync(path)) return { ok: false, reason: "envelope_binding_missing" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const expectedKeys = [
      "schemaVersion",
      "entryId",
      "projectId",
      "memoryId",
      "operationId",
      "producer",
      "target",
      "envelopeDigest",
    ];
    if (!hasExactKeys(parsed, expectedKeys))
      return { ok: false, reason: "envelope_binding_invalid" };
    const binding = parsed as unknown as ClaudeProviderEnvelopeBinding;
    const coherent = isValidClaudeProviderEnvelopeShape({
      ...entry,
      projectId: binding.projectId,
      producer: binding.producer,
      target: binding.target,
      envelopeDigest: binding.envelopeDigest,
    });
    if (
      binding.schemaVersion !== CLAUDE_PROVIDER_BINDING_SCHEMA ||
      binding.entryId !== computeClaudeProviderEntryId(binding) ||
      binding.envelopeDigest !== computeClaudeProviderEnvelopeDigest(binding) ||
      !coherent
    ) {
      return { ok: false, reason: "envelope_binding_invalid" };
    }
    return { ok: true, binding };
  } catch {
    return { ok: false, reason: "envelope_binding_invalid" };
  }
}

function logPath(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "logs", "claude-memory-wake.jsonl");
}

/**
 * Stop hookの配線はpublish成功からは導けない。settingsが壊れている場合も
 * configured扱いにせず、受信側が永遠に現れない可能性を警告面へ返す。
 */
export function inspectClaudeMemoryWakeHook(repoRoot: string): ClaudeMemoryWakeHookStatus {
  const settingsPath = join(repoRoot, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return { configured: false, reason: "settings_missing" };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks?: { Stop?: unknown };
    };
    const stop = parsed?.hooks?.Stop;
    if (stop === undefined || !JSON.stringify(stop).includes("claude-memory-wake")) {
      return { configured: false, reason: "stop_hook_missing" };
    }
    return { configured: true, reason: "configured" };
  } catch {
    return { configured: false, reason: "settings_invalid" };
  }
}

function warnPublishIsNotDelivery(hook: ClaudeMemoryWakeHookStatus): void {
  if (hook.configured) return;
  process.stderr.write(
    `claude-memory-wake warning: publish is pending, Stop hook unavailable (${hook.reason}); delivery is unconfirmed\n`,
  );
}

function writeAuditLog(repoRoot: string, event: Record<string, unknown>): void {
  try {
    const path = logPath(repoRoot);
    ensureDir(join(path, ".."), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // 監査は best effort
  }
}

export function buildClaudeInboxEntry(input: {
  memory: MemoryEntry;
  operationId: string;
  workspaceId: string;
  originRuntime?: "codex" | "system";
  now?: string;
}): ClaudeMemoryInboxEntry {
  if (!input.operationId.trim()) throw new Error("claude_inbox_operation_id_required");
  if (!/^[a-f0-9]{64}$/.test(input.workspaceId)) {
    throw new Error("claude_inbox_workspace_id_invalid");
  }
  return {
    schemaVersion: CLAUDE_INBOX_SCHEMA,
    purpose: "memory",
    id: `${input.memory.memory_id}:workspace:${input.workspaceId}:op:${input.operationId}`,
    memoryId: input.memory.memory_id,
    body: input.memory.body,
    originRuntime: input.originRuntime ?? "system",
    operationId: input.operationId,
    targetWorkspaceId: input.workspaceId,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function buildClaudeReviewInboxEntry(input: {
  memory: MemoryEntry;
  operationId: string;
  workspaceId: string;
  requestDigest: string;
  requestPath: string;
  pr: number;
  exactHead: string;
  reviewRevision: string;
  authorFamily: "codex" | "claude";
  originRuntime?: "codex" | "system";
  now?: string;
}): ClaudeReviewInboxEntry {
  const memoryEntry = buildClaudeInboxEntry(input);
  const review = {
    requestDigest: input.requestDigest,
    requestPath: input.requestPath,
    memoryPath: input.memory.source_path,
    pr: input.pr,
    exactHead: input.exactHead,
    reviewRevision: input.reviewRevision,
    authorFamily: input.authorFamily,
  };
  if (!isValidReviewIdentity(review)) throw new Error("claude_inbox_review_identity_invalid");
  return { ...memoryEntry, purpose: "review", ...review };
}

export function publishClaudeInboxEntry(repoRoot: string, entry: ClaudeInboxEntry): string {
  const claimedPath = join(runtimeRoot(repoRoot), `${inboxFileStem(entry.id)}.claim`);
  if (existsSync(claimedPath)) {
    removeProviderBinding(repoRoot, entry);
    writeAuditLog(repoRoot, {
      event: "publish",
      status: "idempotent_claimed",
      entryId: entry.id,
      operationId: entry.operationId,
      deliveryState: "claimed",
      deliveryConfirmed: true,
    });
    return claimedPath;
  }
  const directory = join(runtimeRoot(repoRoot), "inbox");
  ensureDir(directory, { recursive: true });
  const target = join(directory, `${inboxFileStem(entry.id)}.json`);
  const serialized = JSON.stringify(entry);
  // Persist the independently consumed expectation before exposing or
  // reusing the inbox entry. A consumer can never observe a new v4 entry
  // unbound, including an idempotent retry after a partial prior publish.
  writeProviderBinding(repoRoot, entry);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8").trim() === serialized) {
      const hook = inspectClaudeMemoryWakeHook(repoRoot);
      warnPublishIsNotDelivery(hook);
      writeAuditLog(repoRoot, {
        event: "publish",
        status: "idempotent",
        entryId: entry.id,
        operationId: entry.operationId,
        deliveryState: "pending",
        deliveryConfirmed: false,
        hookConfigured: hook.configured,
        warningCodes: hook.configured ? [] : ["hook_missing"],
      });
      return target;
    }
    writeAuditLog(repoRoot, {
      event: "publish",
      status: "conflict",
      entryId: entry.id,
      operationId: entry.operationId,
    });
    throw new Error("claude_inbox_projection_conflict");
  }
  const descriptor = openSync(target, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${serialized}\n`);
  } finally {
    closeSync(descriptor);
  }
  const hook = inspectClaudeMemoryWakeHook(repoRoot);
  warnPublishIsNotDelivery(hook);
  writeAuditLog(repoRoot, {
    event: "publish",
    status: "created",
    entryId: entry.id,
    operationId: entry.operationId,
    // projection fileの作成は受信sessionへの配送確認ではない。
    deliveryState: "pending",
    deliveryConfirmed: false,
    hookConfigured: hook.configured,
    warningCodes: hook.configured ? [] : ["hook_missing"],
  });
  return target;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  return (
    actual.length === orderedExpected.length &&
    actual.every((key, index) => key === orderedExpected[index])
  );
}

function isValidReviewIdentity(value: {
  requestDigest: string;
  requestPath: string;
  memoryPath: string;
  pr: number;
  exactHead: string;
  reviewRevision: string;
  authorFamily: "codex" | "claude";
}): boolean {
  const normalizedRequestPath = value.requestPath.replaceAll("\\", "/");
  return (
    /^[a-f0-9]{16,64}$/.test(value.requestDigest) &&
    (normalizedRequestPath.endsWith(`/.ut-tdd/review/requests/${value.requestDigest}.json`) ||
      normalizedRequestPath === `.ut-tdd/review/requests/${value.requestDigest}.json`) &&
    isCanonicalMemorySourcePath(value.memoryPath) &&
    Number.isInteger(value.pr) &&
    value.pr > 0 &&
    /^[a-f0-9]{40}$/.test(value.exactHead) &&
    value.reviewRevision.trim().length > 0 &&
    ["codex", "claude"].includes(value.authorFamily)
  );
}

export function decodeClaudeInboxEntry(value: string): ClaudeInboxEntry | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const legacy = parsed.schemaVersion === CLAUDE_INBOX_LEGACY_SCHEMA;
    const providerEnvelope = parsed.schemaVersion === CLAUDE_PROVIDER_INBOX_SCHEMA;
    const purpose = legacy ? "memory" : parsed.purpose;
    const baseKeys = [
      "schemaVersion",
      "id",
      "memoryId",
      "body",
      "originRuntime",
      "operationId",
      "targetWorkspaceId",
      "createdAt",
    ];
    const providerKeys = ["projectId", "producer", "target", "envelopeDigest"];
    const expectedKeys = legacy
      ? baseKeys
      : providerEnvelope
        ? purpose === "memory"
          ? [...baseKeys, "purpose", ...providerKeys]
          : purpose === "review"
            ? [
                ...baseKeys,
                "purpose",
                ...providerKeys,
                "requestDigest",
                "requestPath",
                "memoryPath",
                "pr",
                "exactHead",
                "reviewRevision",
                "authorFamily",
              ]
            : []
        : purpose === "memory"
          ? [...baseKeys, "purpose"]
          : purpose === "review"
            ? [
                ...baseKeys,
                "purpose",
                "requestDigest",
                "requestPath",
                "memoryPath",
                "pr",
                "exactHead",
                "reviewRevision",
                "authorFamily",
              ]
            : [];
    if (!hasExactKeys(parsed, expectedKeys)) return undefined;
    const entry = parsed as unknown as ClaudeInboxEntry;
    if (
      (!legacy && !providerEnvelope && entry.schemaVersion !== CLAUDE_INBOX_SCHEMA) ||
      (providerEnvelope && entry.schemaVersion !== CLAUDE_PROVIDER_INBOX_SCHEMA) ||
      !entry.id ||
      !entry.memoryId.startsWith("memory:") ||
      !entry.body.trim() ||
      !["codex", "system"].includes(entry.originRuntime) ||
      !entry.operationId.trim() ||
      !/^[a-f0-9]{64}$/.test(entry.targetWorkspaceId) ||
      !Number.isFinite(Date.parse(entry.createdAt))
    ) {
      return undefined;
    }
    if (legacy) return { ...entry, purpose: "memory" } as ClaudeLegacyInboxEntry;
    if (providerEnvelope) {
      if (!isValidClaudeProviderEnvelopeShape(entry as ClaudeProviderInboxEntry)) {
        return undefined;
      }
      if (entry.purpose === "memory") return entry as ClaudeProviderMemoryInboxEntry;
      if (entry.purpose !== "review" || !isValidReviewIdentity(entry)) return undefined;
      return entry as ClaudeProviderReviewInboxEntry;
    }
    if (entry.purpose === "memory") return entry;
    if (entry.purpose !== "review" || !isValidReviewIdentity(entry)) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

function reviewReceiptIdentity(
  entry: ClaudeReviewInboxEntry | ClaudeProviderReviewInboxEntry,
): ClaudeInboxReviewReceiptIdentity {
  return {
    requestDigest: entry.requestDigest,
    requestPath: entry.requestPath,
    memoryPath: entry.memoryPath,
    pr: entry.pr,
    exactHead: entry.exactHead,
    reviewRevision: entry.reviewRevision,
    authorFamily: entry.authorFamily,
  };
}

/**
 * Decide terminality from authenticated observations only.  Memory envelopes do not
 * acquire PR semantics from their prose, and malformed/unknown observations remain live.
 */
export function evaluateClaudeInboxTerminal(input: {
  entry: ClaudeInboxEntry;
  claimed?: boolean;
  pullRequest?: ClaudeInboxPullRequestObservation;
  replacementExists?: boolean;
}): ClaudeInboxTerminalDecision {
  if (input.claimed === true) return { terminal: true, reason: "claimed" };
  if (
    input.entry.purpose !== "review" ||
    (input.entry.schemaVersion !== CLAUDE_INBOX_SCHEMA &&
      input.entry.schemaVersion !== CLAUDE_PROVIDER_INBOX_SCHEMA)
  ) {
    return { terminal: false };
  }
  const observation = input.pullRequest;
  if (
    !observation ||
    observation.pr !== input.entry.pr ||
    !Number.isInteger(observation.pr) ||
    observation.pr <= 0 ||
    !/^[a-f0-9]{40}$/.test(observation.headSha)
  ) {
    return { terminal: false };
  }
  const receipt = reviewReceiptIdentity(
    input.entry as ClaudeReviewInboxEntry | ClaudeProviderReviewInboxEntry,
  );
  if (observation.state === "MERGED") {
    return { terminal: true, reason: "pr_merged", receipt };
  }
  if (observation.state === "CLOSED") {
    return { terminal: true, reason: "pr_closed", receipt };
  }
  if (observation.headSha !== input.entry.exactHead && input.replacementExists === true) {
    return { terminal: true, reason: "stale_head_replaced", receipt };
  }
  return { terminal: false };
}

function terminalMarkerPath(root: string, entryId: string): string {
  return join(root, `${inboxFileStem(entryId)}.terminal.json`);
}

function terminalMarkerFor(
  entry: ClaudeInboxEntry,
  decision: Extract<ClaudeInboxTerminalDecision, { terminal: true }>,
  at: string,
): ClaudeInboxTerminalMarker {
  const base = {
    schema: CLAUDE_INBOX_TERMINAL_SCHEMA,
    entryId: entry.id,
    reason: decision.reason,
    terminalAt: at,
    purpose: entry.purpose,
  } as ClaudeInboxTerminalMarker;
  return decision.receipt ? { ...base, ...decision.receipt } : base;
}

function readTerminalMarker(path: string): ClaudeInboxTerminalMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      !value ||
      Array.isArray(value) ||
      value.schema !== CLAUDE_INBOX_TERMINAL_SCHEMA ||
      typeof value.entryId !== "string" ||
      typeof value.reason !== "string" ||
      !["claimed", "pr_merged", "pr_closed", "stale_head_replaced"].includes(value.reason) ||
      typeof value.terminalAt !== "string" ||
      !Number.isFinite(Date.parse(value.terminalAt)) ||
      !["memory", "review"].includes(value.purpose as string)
    ) {
      return undefined;
    }
    if (value.purpose === "review") {
      const identity = {
        requestDigest: value.requestDigest,
        requestPath: value.requestPath,
        memoryPath: value.memoryPath,
        pr: value.pr,
        exactHead: value.exactHead,
        reviewRevision: value.reviewRevision,
        authorFamily: value.authorFamily,
      };
      if (
        typeof identity.requestDigest !== "string" ||
        typeof identity.requestPath !== "string" ||
        typeof identity.memoryPath !== "string" ||
        typeof identity.pr !== "number" ||
        typeof identity.exactHead !== "string" ||
        typeof identity.reviewRevision !== "string" ||
        (identity.authorFamily !== "codex" && identity.authorFamily !== "claude") ||
        !isValidReviewIdentity(identity as ClaudeInboxReviewReceiptIdentity)
      ) {
        return undefined;
      }
    }
    return value as unknown as ClaudeInboxTerminalMarker;
  } catch {
    return undefined;
  }
}

function terminalIds(root: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(root)) return ids;
  for (const name of readdirSync(root).filter((candidate) =>
    candidate.endsWith(".terminal.json"),
  )) {
    const marker = readTerminalMarker(join(root, name));
    if (marker) ids.add(marker.entryId);
  }
  return ids;
}

export interface ClaudeInboxRecoveryEntry {
  readonly entryId: string;
  readonly reason: ClaudeInboxTerminalReason;
  readonly markerPath?: string;
}

export interface ClaudeInboxRecoveryResult {
  readonly dryRun: boolean;
  readonly inspected: number;
  readonly terminalized: number;
  readonly entries: ClaudeInboxRecoveryEntry[];
}

/** Sweep inbox backlog.  Dry-run has no filesystem writes; apply retains inbox JSON as evidence. */
export function recoverClaudeInboxBacklog(input: {
  repoRoot: string;
  pullRequests?: readonly ClaudeInboxPullRequestObservation[];
  pullRequestState?: (pr: number) => ClaudeInboxPullRequestObservation | undefined;
  dryRun?: boolean;
  now?: string;
}): ClaudeInboxRecoveryResult {
  const root = runtimeRoot(input.repoRoot);
  const dryRun = input.dryRun ?? true;
  const now = input.now ?? new Date().toISOString();
  const entries = readInbox(input.repoRoot);
  const existingTerminals = terminalIds(root);
  const claimed = claimedIds(root);
  const observations = new Map((input.pullRequests ?? []).map((value) => [value.pr, value]));
  const getObservation = (pr: number) => input.pullRequestState?.(pr) ?? observations.get(pr);
  const results: ClaudeInboxRecoveryEntry[] = [];
  for (const entry of entries) {
    if (existingTerminals.has(entry.id)) continue;
    const observation = entry.purpose === "review" ? getObservation(entry.pr) : undefined;
    const replacementExists =
      entry.purpose === "review" &&
      entries.some(
        (candidate) =>
          candidate.purpose === "review" &&
          candidate.id !== entry.id &&
          candidate.pr === entry.pr &&
          observation?.state === "OPEN" &&
          candidate.exactHead === observation.headSha &&
          !existingTerminals.has(candidate.id),
      );
    const decision = evaluateClaudeInboxTerminal({
      entry,
      claimed: claimed.has(entry.id),
      pullRequest: observation,
      replacementExists,
    });
    if (!decision.terminal) continue;
    const result: ClaudeInboxRecoveryEntry = {
      entryId: entry.id,
      reason: decision.reason,
      ...(dryRun ? {} : { markerPath: terminalMarkerPath(root, entry.id) }),
    };
    results.push(result);
    if (!dryRun) {
      ensureDir(root, { recursive: true });
      const path = terminalMarkerPath(root, entry.id);
      if (!existsSync(path))
        writeFileSync(path, `${JSON.stringify(terminalMarkerFor(entry, decision, now))}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      existingTerminals.add(entry.id);
    }
  }
  return { dryRun, inspected: entries.length, terminalized: results.length, entries: results };
}

function claimedIds(root: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(root)) return ids;
  for (const name of readdirSync(root).filter((candidate) => candidate.endsWith(".claim"))) {
    try {
      const value = JSON.parse(readFileSync(join(root, name), "utf8")) as { id?: unknown };
      if (typeof value.id === "string") ids.add(value.id);
    } catch {
      // 破損claimは他entryをstarveさせない。
    }
  }
  return ids;
}

export function selectClaudeInboxEntry(
  entries: readonly ClaudeInboxEntry[],
  unavailableIds: ReadonlySet<string>,
): ClaudeInboxEntry | undefined {
  return entries
    .filter((entry) => !unavailableIds.has(entry.id))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .at(0);
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function activationRollbackMarkers(root: string): ReadonlySet<string> {
  const journalRoot = join(root, "activation-journal");
  if (!existsSync(journalRoot)) return new Set();
  const markers = new Set<string>();
  for (const name of readdirSync(journalRoot).filter((entry) => entry.endsWith(".json"))) {
    try {
      const journal = JSON.parse(readFileSync(join(journalRoot, name), "utf8")) as {
        state?: unknown;
        previousMarkerName?: unknown;
      };
      if (
        journal.state === "planned" &&
        typeof journal.previousMarkerName === "string" &&
        journal.previousMarkerName.endsWith(".generation")
      ) {
        markers.add(journal.previousMarkerName);
      }
    } catch {
      // Invalid journals fail closed during activation reconciliation.
    }
  }
  return markers;
}

function pruneRuntimeFiles(root: string, nowMs: number): void {
  if (!existsSync(root)) return;
  const rollbackMarkers = activationRollbackMarkers(root);
  for (const directory of [root, join(root, "inbox")]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (name.endsWith(".terminal.json")) {
        const path = join(directory, name);
        try {
          const stat = statSync(path);
          const marker = readTerminalMarker(path);
          const evidencePath = marker
            ? join(root, "inbox", `${inboxFileStem(marker.entryId)}.json`)
            : null;
          // A marker suppresses delivery while its inbox JSON is retained as
          // evidence. Only an old orphan marker is eligible for cleanup.
          if (
            stat.isFile() &&
            nowMs - stat.mtimeMs > RETENTION_MS &&
            (evidencePath === null || !existsSync(evidencePath))
          )
            unlinkSync(path);
        } catch {
          // 競合削除は次回GCへ委ねる。
        }
        continue;
      }
      if (!name.endsWith(".claim") && !name.endsWith(".generation") && !name.endsWith(".json"))
        continue;
      if (directory === root && rollbackMarkers.has(name)) continue;
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (stat.isFile() && nowMs - stat.mtimeMs > RETENTION_MS) unlinkSync(path);
      } catch {
        // 競合削除は次回GCへ委ねる。
      }
    }
  }
}

function readInbox(repoRoot: string): ClaudeInboxEntry[] {
  const directory = join(runtimeRoot(repoRoot), "inbox");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        const entry = decodeClaudeInboxEntry(readFileSync(join(directory, name), "utf8"));
        if (entry) Object.defineProperty(entry, INBOX_SOURCE_FILE, { value: name });
        return entry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is ClaudeInboxEntry => entry !== undefined);
}

function inboxSourceMatchesEntry(entry: ClaudeInboxEntry): boolean {
  const source = (entry as InboxEntryWithSource)[INBOX_SOURCE_FILE];
  return !source || source === `${inboxFileStem(entry.id)}.json`;
}

function summarizeEntries(
  entries: readonly ClaudeInboxEntry[],
  workspaceId: string,
): ClaudeInboxBacklogSummary {
  if (entries.length === 0) {
    return {
      workspaceId,
      pending: 0,
      oldestEntryId: null,
      oldestCreatedAt: null,
      oldestAgeMs: null,
      targetMismatchPending: 0,
      targetMismatchOldestAgeMs: null,
      activeSessionCount: 0,
      sessionStatus: "absent",
      hookConfigured: false,
      warningCodes: [],
      terminalized: 0,
    };
  }

  const ordered = [...entries].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const oldest = ordered[0];
  return {
    workspaceId,
    pending: entries.length,
    oldestEntryId: oldest.id,
    oldestCreatedAt: oldest.createdAt,
    oldestAgeMs: Date.now() - Date.parse(oldest.createdAt),
    targetMismatchPending: 0,
    targetMismatchOldestAgeMs: null,
    activeSessionCount: 0,
    sessionStatus: "absent",
    hookConfigured: false,
    warningCodes: [],
  };
}

interface ClaudeSessionObservation {
  readonly activeSessionCount: number;
  readonly sessionStatus: "active" | "absent" | "unknown";
}

function readGenerationMarker(path: string): {
  generation: string;
  workspaceId: string;
  inboxSchema?: string;
} | null {
  try {
    return parseClaudeWakeGeneration(readFileSync(path, "utf8")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a live Claude VS Code consumer independently from the subject
 * worktree that authored the canonical review request.  Generation markers
 * are runtime state in the shared git common dir; only one fresh, compatible
 * workspace may be selected.  The caller keeps the canonical request intact
 * when this returns a typed failure so it remains visible as backlog.
 */
export function resolveLiveClaudeWorkspace(repoRoot: string): ClaudeLiveWorkspaceResolution {
  const root = runtimeRoot(repoRoot);
  if (!existsSync(root)) return { ok: false, reason: "no_live_claude_workspace" };

  const workspaceIds = new Set<string>();
  let markerCount = 0;
  let staleMarkerCount = 0;
  let incompatibleMarker = false;
  for (const name of readdirSync(root).filter((entry) => entry.endsWith(".generation"))) {
    markerCount += 1;
    const path = join(root, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      incompatibleMarker = true;
      continue;
    }
    if (Date.now() - stat.mtimeMs > CLAUDE_INBOX_BACKLOG_WARN_AGE_MS) {
      staleMarkerCount += 1;
      continue;
    }
    const marker = readGenerationMarker(path);
    if (
      !marker ||
      !/^[a-f0-9]{64}$/.test(marker.workspaceId) ||
      marker.inboxSchema !== CLAUDE_INBOX_SCHEMA
    ) {
      incompatibleMarker = true;
      continue;
    }
    workspaceIds.add(marker.workspaceId);
  }

  if (incompatibleMarker) {
    return { ok: false, reason: "incompatible_claude_workspace_schema" };
  }
  if (workspaceIds.size > 1) {
    return { ok: false, reason: "ambiguous_live_claude_workspace" };
  }
  if (workspaceIds.size === 1) {
    return { ok: true, workspaceId: [...workspaceIds][0] };
  }
  return {
    ok: false,
    reason:
      markerCount > 0 && staleMarkerCount === markerCount
        ? "stale_claude_workspace"
        : "no_live_claude_workspace",
  };
}

export function resolveLiveClaudeTarget(repoRoot: string): ClaudeLiveTargetResolution {
  const workspace = resolveLiveClaudeWorkspace(repoRoot);
  if (!workspace.ok) return workspace;
  const inspected = inspectClaudeWakeGeneration(runtimeRoot(repoRoot), workspace.workspaceId);
  if (!inspected.ok) return { ok: false, reason: "incompatible_claude_workspace_schema" };
  return {
    ok: true,
    workspaceId: workspace.workspaceId,
    sessionId: inspected.authority.sessionId,
  };
}

function observeClaudeSessions(
  root: string,
  workspaceId: string,
  nowMs = Date.now(),
): ClaudeSessionObservation {
  if (!existsSync(root)) return { activeSessionCount: 0, sessionStatus: "absent" };
  let freshMarkerCount = 0;
  let activeSessionCount = 0;
  for (const name of readdirSync(root).filter((entry) => entry.endsWith(".generation"))) {
    try {
      if (nowMs - statSync(join(root, name)).mtimeMs > CLAUDE_INBOX_BACKLOG_WARN_AGE_MS) continue;
      freshMarkerCount += 1;
      if (readGenerationMarker(join(root, name))?.workspaceId === workspaceId)
        activeSessionCount += 1;
    } catch {
      freshMarkerCount += 1;
    }
  }
  return {
    activeSessionCount,
    sessionStatus: activeSessionCount > 0 ? "active" : freshMarkerCount > 0 ? "unknown" : "absent",
  };
}

export function summarizeUnclaimedInbox(
  repoRoot: string,
  workspaceId: string,
): ClaudeInboxBacklogSummary {
  const root = runtimeRoot(repoRoot);
  const claimed = new Set(claimedIds(root));
  const terminal = terminalIds(root);
  const allEntries = readInbox(repoRoot);
  const all = allEntries.filter((entry) => !claimed.has(entry.id) && !terminal.has(entry.id));
  const entries = all.filter((entry) => entry.targetWorkspaceId === workspaceId);
  const foreign = all.filter((entry) => entry.targetWorkspaceId !== workspaceId);
  const own = summarizeEntries(entries, workspaceId);
  const foreignOrdered = [...foreign].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const targetMismatchOldest = foreignOrdered[0];
  const sessions = observeClaudeSessions(root, workspaceId);
  const hook = inspectClaudeMemoryWakeHook(repoRoot);
  const totalPending = all.length;
  const warnings = new Set<ClaudeInboxWarningCode>();
  if ((own.oldestAgeMs ?? 0) >= CLAUDE_INBOX_BACKLOG_WARN_AGE_MS) warnings.add("age");
  if (foreign.length > 0) warnings.add("target_mismatch");
  if (totalPending > 0 && sessions.sessionStatus === "absent") warnings.add("session_absent");
  if (totalPending > 0 && sessions.sessionStatus === "unknown") warnings.add("session_unknown");
  if (totalPending > 0 && !hook.configured) warnings.add("hook_missing");
  return {
    ...own,
    targetMismatchPending: foreign.length,
    targetMismatchOldestAgeMs: targetMismatchOldest
      ? Date.now() - Date.parse(targetMismatchOldest.createdAt)
      : null,
    activeSessionCount: sessions.activeSessionCount,
    sessionStatus: sessions.sessionStatus,
    hookConfigured: hook.configured,
    warningCodes: [...warnings],
    terminalized: allEntries.filter((entry) => terminal.has(entry.id)).length,
  };
}

function claim(input: {
  repoRoot: string;
  entry: ClaudeInboxEntry;
  sessionId: string;
  at: string;
  authority: ClaudeWakeAuthority;
  leaseToken: string;
  envelopeGuard?: () => ClaudeProviderEnvelopeValidation;
  beforeCommit?: () => void;
}): boolean {
  const root = runtimeRoot(input.repoRoot);
  ensureDir(root, { recursive: true });
  if (!validateClaudeWakeClaimAuthority(root, input.authority, input.leaseToken).ok) return false;
  if (!inboxSourceMatchesEntry(input.entry)) return false;
  if (input.envelopeGuard && !input.envelopeGuard().ok) return false;
  const path = join(root, `${inboxFileStem(input.entry.id)}.claim`);
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    input.beforeCommit?.();
    if (input.envelopeGuard && !input.envelopeGuard().ok) {
      closeSync(descriptor);
      unlinkSync(path);
      return false;
    }
    if (!validateClaudeWakeClaimAuthority(root, input.authority, input.leaseToken).ok) {
      closeSync(descriptor);
      unlinkSync(path);
      return false;
    }
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        id: input.entry.id,
        sessionId: input.sessionId,
        deliveredAt: input.at,
      })}\n`,
    );
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // authority-loss path already closed the descriptor before removing the empty claim.
    }
  }
  return true;
}

export function renderClaudeWakeMessage(entry: ClaudeInboxEntry): string {
  const body = [...entry.body].slice(0, CLAUDE_WAKE_BODY_MAX_CHARS).join("");
  const notification = JSON.stringify({
    memory_id: entry.memoryId,
    operation_id: entry.operationId,
    purpose: entry.purpose,
    ...(entry.schemaVersion === CLAUDE_PROVIDER_INBOX_SCHEMA
      ? {
          project_id: entry.projectId,
          producer: entry.producer,
          target: entry.target,
          envelope_digest: entry.envelopeDigest,
        }
      : {}),
    ...(entry.purpose === "review"
      ? {
          request_digest: entry.requestDigest,
          request_path: entry.requestPath,
          memory_path: entry.memoryPath,
          pr: entry.pr,
          exact_head: entry.exactHead,
          review_revision: entry.reviewRevision,
          author_family: entry.authorFamily,
        }
      : {}),
    body,
  })
    .replaceAll("[", "\\u005b")
    .replaceAll("<", "\\u003c");
  return [
    "[UT_TDD_CLAUDE_INBOX]",
    "共有HARNESSメモリからの通知データです。現行契約・HEAD・CIを再確認して処理してください。",
    `notification_json:${notification}`,
    "[/UT_TDD_CLAUDE_INBOX]",
  ].join("\n");
}

export async function waitForClaudeMemory(input: {
  repoRoot: string;
  sessionId: string;
  /** Explicit pre-boundary compatibility only; production hooks leave this false. */
  allowLegacy?: boolean;
  provider?: ClaudeProvider;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  pullRequestState?: (pr: number) => ClaudeInboxPullRequestObservation | undefined;
  /** Fault-injection/adapter barrier immediately before the claim CAS commit. */
  beforeClaimCommit?: () => void;
}): Promise<ClaudeMemoryWakeResult> {
  const requestedPollMs = input.pollIntervalMs ?? 2_000;
  const requestedMaxMs = input.maxWaitMs ?? 900_000;
  if (!Number.isFinite(requestedPollMs) || requestedPollMs <= 0) {
    throw new Error("claude_wake_poll_interval_invalid");
  }
  if (!Number.isFinite(requestedMaxMs) || requestedMaxMs <= 0) {
    throw new Error("claude_wake_max_wait_invalid");
  }
  const pollIntervalMs = Math.max(10, requestedPollMs);
  const maxWaitMs = Math.max(pollIntervalMs, requestedMaxMs);
  const now = input.now ?? (() => new Date().toISOString());
  const provider = input.provider ?? "claude";
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const root = runtimeRoot(input.repoRoot);
  const workspaceId = claudeWorkspaceId(input.repoRoot);
  ensureDir(root, { recursive: true });
  pruneRuntimeFiles(root, Date.now());
  const generationPath = join(root, `${safeFilePart(input.sessionId)}.generation`);
  const generation = `${process.pid}:${Date.now()}`;
  const leaseToken = randomBytes(32).toString("hex");
  const sourceRevision = runtimeSourceRevision();
  const activation = activateClaudeWakeGeneration({
    root,
    sessionId: input.sessionId,
    workspaceId,
    generation,
    runtimeSourceRevision: sourceRevision,
    leaseToken,
  });
  if (!activation.ok) {
    writeAuditLog(input.repoRoot, {
      event: "activation",
      status: "deny",
      reason: activation.reason,
      sessionId: input.sessionId,
    });
    return { kind: "superseded" };
  }
  const started = Date.now();
  const unclaimable = new Set<string>();
  // PR observation is an external synchronous port (normally `gh`). Cache both
  // facts and missing facts for this wake cycle so a long poll never repeats
  // the same network observation for the same PR.
  const pullRequestStateCache = new Map<number, ClaudeInboxPullRequestObservation | undefined>();
  const observePullRequestOnce = (pr: number) => {
    if (!pullRequestStateCache.has(pr)) {
      pullRequestStateCache.set(pr, input.pullRequestState?.(pr));
    }
    return pullRequestStateCache.get(pr);
  };
  while (Date.now() - started < maxWaitMs) {
    let currentGeneration: string | null = null;
    try {
      if (!existsSync(generationPath)) {
        writeAuditLog(input.repoRoot, {
          event: "supersede",
          reason: "generation_file_missing",
          sessionId: input.sessionId,
        });
        return { kind: "superseded" };
      }
      currentGeneration = readGenerationMarker(generationPath)?.generation ?? null;
    } catch {
      writeAuditLog(input.repoRoot, {
        event: "supersede",
        reason: "generation_read_failed",
        sessionId: input.sessionId,
      });
      return { kind: "superseded" };
    }
    if (currentGeneration !== generation) {
      writeAuditLog(input.repoRoot, {
        event: "supersede",
        reason: "generation_changed",
        sessionId: input.sessionId,
      });
      return { kind: "superseded" };
    }
    const unavailable = claimedIds(root);
    for (const id of terminalIds(root)) unavailable.add(id);
    for (const id of unclaimable) unavailable.add(id);
    const inbox = readInbox(input.repoRoot);
    for (const candidate of inbox) {
      if (
        unavailable.has(candidate.id) ||
        !input.pullRequestState ||
        candidate.purpose !== "review"
      )
        continue;
      const observation = observePullRequestOnce(candidate.pr);
      const replacementExists = inbox.some(
        (replacement) =>
          replacement.purpose === "review" &&
          replacement.id !== candidate.id &&
          replacement.pr === candidate.pr &&
          observation?.state === "OPEN" &&
          replacement.exactHead === observation.headSha &&
          !unavailable.has(replacement.id),
      );
      const decision = evaluateClaudeInboxTerminal({
        entry: candidate,
        pullRequest: observation,
        replacementExists,
      });
      if (decision.terminal) {
        ensureDir(root, { recursive: true });
        const markerPath = terminalMarkerPath(root, candidate.id);
        if (!existsSync(markerPath)) {
          writeFileSync(
            markerPath,
            `${JSON.stringify(terminalMarkerFor(candidate, decision, now()))}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        }
        unavailable.add(candidate.id);
      }
    }
    const entry = selectClaudeInboxEntry(
      inbox.filter((candidate) => candidate.targetWorkspaceId === workspaceId),
      unavailable,
    );
    if (entry) {
      if (entry.schemaVersion !== CLAUDE_PROVIDER_INBOX_SCHEMA && !input.allowLegacy) {
        writeAuditLog(input.repoRoot, {
          event: "claim",
          status: "deny",
          entryId: entry.id,
          operationId: entry.operationId,
          reason: "legacy_schema_unbound",
        });
        return { kind: "denied", entry, reason: "legacy_schema_unbound" };
      }
      if (!inboxSourceMatchesEntry(entry)) {
        writeAuditLog(input.repoRoot, {
          event: "claim",
          status: "deny",
          entryId: entry.id,
          operationId: entry.operationId,
          reason: "envelope_integrity_mismatch",
        });
        return { kind: "denied", entry, reason: "envelope_integrity_mismatch" };
      }
      let envelopeGuard: (() => ClaudeProviderEnvelopeValidation) | undefined;
      if (entry.schemaVersion === CLAUDE_PROVIDER_INBOX_SCHEMA) {
        envelopeGuard = () =>
          validateProviderBinding({
            repoRoot: input.repoRoot,
            entry,
            provider,
            sessionId: input.sessionId,
          });
        const envelopeResult = envelopeGuard();
        if (!envelopeResult.ok) {
          writeAuditLog(input.repoRoot, {
            event: "claim",
            status: "deny",
            entryId: entry.id,
            operationId: entry.operationId,
            reason: envelopeResult.reason,
          });
          unclaimable.add(entry.id);
          return { kind: "denied", entry, reason: envelopeResult.reason };
        }
      }
      if (
        claim({
          repoRoot: input.repoRoot,
          entry,
          sessionId: input.sessionId,
          at: now(),
          authority: activation.authority,
          leaseToken,
          envelopeGuard,
          beforeCommit: input.beforeClaimCommit,
        })
      ) {
        writeAuditLog(input.repoRoot, {
          event: "claim",
          status: "ok",
          entryId: entry.id,
          operationId: entry.operationId,
          sessionId: input.sessionId,
        });
        const markerPath = terminalMarkerPath(root, entry.id);
        if (!existsSync(markerPath)) {
          writeFileSync(
            markerPath,
            `${JSON.stringify(terminalMarkerFor(entry, { terminal: true, reason: "claimed" }, now()))}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        }
        // The terminal marker is the durable claim evidence. Only after it is
        // present may the independent expectation sidecar be retired.
        removeProviderBinding(input.repoRoot, entry);
        try {
          const source = (entry as InboxEntryWithSource)[INBOX_SOURCE_FILE];
          unlinkSync(join(root, "inbox", source ?? `${inboxFileStem(entry.id)}.json`));
        } catch {
          // claim が配送の正本。inbox GC は次回へ委ねる。
        }
        return { kind: "delivered", entry, message: renderClaudeWakeMessage(entry) };
      }
      writeAuditLog(input.repoRoot, {
        event: "claim",
        status: "skip",
        entryId: entry.id,
        operationId: entry.operationId,
        sessionId: input.sessionId,
        reason: "already_claimed",
      });
      unclaimable.add(entry.id);
      continue;
    }
    await sleep(pollIntervalMs);
  }
  return { kind: "timeout" };
}
