import { createHash } from "node:crypto";
import type { MemoryEntry } from "../memory/index.ts";
import { isCanonicalMemorySourcePath } from "../memory/service.ts";

export const CLAUDE_PROVIDER_INBOX_SCHEMA = "ut-tdd.claude-inbox/v4" as const;
export type ClaudeProvider = "codex" | "claude";

export type ClaudeProviderTarget = {
  readonly scope: "session";
  readonly provider: ClaudeProvider;
  readonly sessionId: string;
};

export interface ClaudeProviderEnvelope {
  readonly projectId: string;
  readonly producer: { readonly provider: ClaudeProvider; readonly sessionId: string };
  readonly target: ClaudeProviderTarget;
  readonly envelopeDigest: string;
}

export interface ClaudeProviderEnvelopeExpectation {
  readonly projectId: string;
  readonly memoryId: string;
  readonly operationId: string;
  readonly producer: { readonly provider: ClaudeProvider; readonly sessionId: string };
  readonly target: ClaudeProviderTarget;
}

export type ClaudeProviderEnvelopeDenyReason =
  | "project_id_mismatch"
  | "memory_id_mismatch"
  | "operation_id_mismatch"
  | "producer_provider_mismatch"
  | "producer_session_mismatch"
  | "target_scope_mismatch"
  | "target_provider_mismatch"
  | "target_session_mismatch"
  | "envelope_binding_missing"
  | "envelope_binding_invalid"
  | "envelope_integrity_mismatch";

export type ClaudeProviderEnvelopeValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ClaudeProviderEnvelopeDenyReason };

interface ClaudeProviderInboxBase extends ClaudeProviderEnvelope {
  readonly schemaVersion: typeof CLAUDE_PROVIDER_INBOX_SCHEMA;
  readonly id: string;
  readonly memoryId: string;
  readonly body: string;
  readonly originRuntime: "codex" | "system";
  readonly operationId: string;
  readonly targetWorkspaceId: string;
  readonly createdAt: string;
}

export interface ClaudeProviderMemoryInboxEntry extends ClaudeProviderInboxBase {
  readonly purpose: "memory";
}

export interface ClaudeProviderReviewInboxEntry extends ClaudeProviderInboxBase {
  readonly purpose: "review";
  readonly requestDigest: string;
  readonly requestPath: string;
  readonly memoryPath: string;
  readonly pr: number;
  readonly exactHead: string;
  readonly reviewRevision: string;
  readonly authorFamily: "codex" | "claude";
}

export type ClaudeProviderInboxEntry =
  | ClaudeProviderMemoryInboxEntry
  | ClaudeProviderReviewInboxEntry;

type ProviderBindings = Pick<
  ClaudeProviderMemoryInboxEntry,
  "projectId" | "memoryId" | "operationId" | "producer" | "target"
>;
type ProviderEntry = ProviderBindings &
  Pick<ClaudeProviderMemoryInboxEntry, "id" | "envelopeDigest">;

export function computeClaudeProviderEntryId(
  input: ProviderBindings & { envelopeDigest?: string },
): string {
  const digest = input.envelopeDigest ?? computeClaudeProviderEnvelopeDigest(input);
  return `${input.memoryId}:project:${input.projectId}:op:${input.operationId}:env:${digest.slice(0, 16)}`;
}

export function computeClaudeProviderEnvelopeDigest(input: ProviderBindings): string {
  const canonical = JSON.stringify({
    schemaVersion: CLAUDE_PROVIDER_INBOX_SCHEMA,
    projectId: input.projectId,
    memoryId: input.memoryId,
    operationId: input.operationId,
    producer: input.producer,
    target: input.target,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function validProvider(value: unknown): value is ClaudeProvider {
  return value === "codex" || value === "claude";
}

function validProviderTarget(value: unknown): value is ClaudeProviderTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    target.scope === "session" &&
    Object.keys(target).length === 3 &&
    validProvider(target.provider) &&
    typeof target.sessionId === "string" &&
    target.sessionId.trim().length > 0
  );
}

export function isValidClaudeProviderEnvelopeShape(entry: ClaudeProviderInboxEntry): boolean {
  const producer = entry.producer as unknown;
  const producerRecord = producer as Record<string, unknown>;
  return (
    typeof entry.projectId === "string" &&
    entry.projectId.trim().length > 0 &&
    typeof producer === "object" &&
    producer !== null &&
    !Array.isArray(producer) &&
    validProvider(producerRecord.provider) &&
    typeof producerRecord.sessionId === "string" &&
    (producerRecord.sessionId as string).trim().length > 0 &&
    validProviderTarget(entry.target) &&
    /^[a-f0-9]{64}$/.test(entry.envelopeDigest)
  );
}

export function validateClaudeProviderEnvelope(
  entry: ProviderEntry,
  expected: ClaudeProviderEnvelopeExpectation,
): ClaudeProviderEnvelopeValidation {
  if (entry.projectId !== expected.projectId) return { ok: false, reason: "project_id_mismatch" };
  if (entry.memoryId !== expected.memoryId) return { ok: false, reason: "memory_id_mismatch" };
  if (entry.operationId !== expected.operationId)
    return { ok: false, reason: "operation_id_mismatch" };
  if (entry.producer.provider !== expected.producer.provider) {
    return { ok: false, reason: "producer_provider_mismatch" };
  }
  if (entry.producer.sessionId !== expected.producer.sessionId) {
    return { ok: false, reason: "producer_session_mismatch" };
  }
  if (entry.target.scope !== expected.target.scope)
    return { ok: false, reason: "target_scope_mismatch" };
  if (entry.target.scope === "session" && expected.target.scope === "session") {
    if (entry.target.provider !== expected.target.provider) {
      return { ok: false, reason: "target_provider_mismatch" };
    }
    if (entry.target.sessionId !== expected.target.sessionId) {
      return { ok: false, reason: "target_session_mismatch" };
    }
  }
  if (entry.envelopeDigest !== computeClaudeProviderEnvelopeDigest(entry)) {
    return { ok: false, reason: "envelope_integrity_mismatch" };
  }
  if (entry.id !== computeClaudeProviderEntryId(entry)) {
    return { ok: false, reason: "envelope_integrity_mismatch" };
  }
  return { ok: true };
}

export function validateClaudeProviderConsumerEnvelope(input: {
  entry: ClaudeProviderInboxEntry;
  projectId: string;
  provider: ClaudeProvider;
  sessionId: string;
  /**
   * These values must come from the consumer's trusted operation context.  A
   * provider envelope is not self-authenticating: accepting them as optional
   * would let a coherent, re-digested payload choose its own claim identity.
   */
  expectedMemoryId: string;
  expectedOperationId: string;
  expectedProducer: { provider: ClaudeProvider; sessionId: string };
}): ClaudeProviderEnvelopeValidation {
  const { entry } = input;
  if (entry.projectId !== input.projectId) return { ok: false, reason: "project_id_mismatch" };
  if (entry.memoryId !== input.expectedMemoryId) {
    return { ok: false, reason: "memory_id_mismatch" };
  }
  if (entry.operationId !== input.expectedOperationId) {
    return { ok: false, reason: "operation_id_mismatch" };
  }
  if (entry.producer.provider !== input.expectedProducer.provider) {
    return { ok: false, reason: "producer_provider_mismatch" };
  }
  if (entry.producer.sessionId !== input.expectedProducer.sessionId) {
    return { ok: false, reason: "producer_session_mismatch" };
  }
  if (entry.target.scope === "session") {
    if (entry.target.provider !== input.provider)
      return { ok: false, reason: "target_provider_mismatch" };
    if (entry.target.sessionId !== input.sessionId)
      return { ok: false, reason: "target_session_mismatch" };
  }
  if (entry.envelopeDigest !== computeClaudeProviderEnvelopeDigest(entry)) {
    return { ok: false, reason: "envelope_integrity_mismatch" };
  }
  if (entry.id !== computeClaudeProviderEntryId(entry)) {
    return { ok: false, reason: "envelope_integrity_mismatch" };
  }
  return { ok: true };
}

export function buildClaudeProviderInboxEntry(input: {
  memory: MemoryEntry;
  projectId: string;
  operationId: string;
  workspaceId: string;
  producer: { provider: ClaudeProvider; sessionId: string };
  target: ClaudeProviderTarget;
  now?: string;
}): ClaudeProviderMemoryInboxEntry {
  if (!input.projectId.trim()) throw new Error("claude_provider_project_id_required");
  if (!input.operationId.trim()) throw new Error("claude_inbox_operation_id_required");
  if (!/^[a-f0-9]{64}$/.test(input.workspaceId))
    throw new Error("claude_inbox_workspace_id_invalid");
  if (!validProvider(input.producer.provider) || !input.producer.sessionId.trim()) {
    throw new Error("claude_provider_producer_invalid");
  }
  if (!validProviderTarget(input.target)) throw new Error("claude_provider_target_invalid");
  const envelope = {
    projectId: input.projectId,
    producer: { ...input.producer },
    target: { ...input.target },
  } as ClaudeProviderEnvelope;
  const envelopeDigest = computeClaudeProviderEnvelopeDigest({
    projectId: input.projectId,
    memoryId: input.memory.memory_id,
    operationId: input.operationId,
    producer: input.producer,
    target: input.target,
  });
  return {
    schemaVersion: CLAUDE_PROVIDER_INBOX_SCHEMA,
    purpose: "memory",
    id: computeClaudeProviderEntryId({
      projectId: input.projectId,
      memoryId: input.memory.memory_id,
      operationId: input.operationId,
      producer: input.producer,
      target: input.target,
      envelopeDigest,
    }),
    memoryId: input.memory.memory_id,
    body: input.memory.body,
    originRuntime: input.producer.provider === "codex" ? "codex" : "system",
    operationId: input.operationId,
    targetWorkspaceId: input.workspaceId,
    createdAt: input.now ?? new Date().toISOString(),
    ...envelope,
    envelopeDigest,
  };
}

export function buildClaudeProviderReviewInboxEntry(input: {
  memory: MemoryEntry;
  projectId: string;
  operationId: string;
  workspaceId: string;
  producer: { provider: ClaudeProvider; sessionId: string };
  target: ClaudeProviderTarget;
  requestDigest: string;
  requestPath: string;
  pr: number;
  exactHead: string;
  reviewRevision: string;
  authorFamily: "codex" | "claude";
  now?: string;
}): ClaudeProviderReviewInboxEntry {
  const memoryEntry = buildClaudeProviderInboxEntry(input);
  const review = {
    requestDigest: input.requestDigest,
    requestPath: input.requestPath,
    memoryPath: input.memory.source_path,
    pr: input.pr,
    exactHead: input.exactHead,
    reviewRevision: input.reviewRevision,
    authorFamily: input.authorFamily,
  };
  const normalizedRequestPath = review.requestPath.replaceAll("\\", "/");
  if (
    !/^[a-f0-9]{16,64}$/.test(review.requestDigest) ||
    !(
      normalizedRequestPath.endsWith(`/.ut-tdd/review/requests/${review.requestDigest}.json`) ||
      normalizedRequestPath === `.ut-tdd/review/requests/${review.requestDigest}.json`
    ) ||
    !isCanonicalMemorySourcePath(review.memoryPath) ||
    !Number.isInteger(review.pr) ||
    review.pr <= 0 ||
    !/^[a-f0-9]{40}$/.test(review.exactHead) ||
    !review.reviewRevision.trim() ||
    !["codex", "claude"].includes(review.authorFamily)
  ) {
    throw new Error("claude_inbox_review_identity_invalid");
  }
  return { ...memoryEntry, purpose: "review", ...review };
}
