import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export const CLAUDE_WAKE_GENERATION_SCHEMA = "ut-tdd.claude-wake-generation/v1" as const;
export const CLAUDE_WAKE_CAPABILITY_SCHEMA = "ut-tdd.claude-wake-capability/v1" as const;
export const CLAUDE_WAKE_AUTHORITY_SCHEMA = "ut-tdd.claude-wake-authority/v1" as const;
export const CLAUDE_WAKE_RESTART_HANDOFF_SCHEMA = "ut-tdd.claude-wake-restart-handoff/v1" as const;
const CLAUDE_INBOX_SCHEMA = "ut-tdd.claude-inbox/v3" as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const WORKSPACE_ID = /^[a-f0-9]{64}$/;

export interface ClaudeWakeGeneration {
  readonly schema: typeof CLAUDE_WAKE_GENERATION_SCHEMA;
  readonly generation: string;
  readonly workspaceId: string;
  readonly inboxSchema: typeof CLAUDE_INBOX_SCHEMA;
}

export interface ClaudeWakeCapability {
  readonly schema: typeof CLAUDE_WAKE_CAPABILITY_SCHEMA;
  readonly generation: string;
  readonly workspaceId: string;
  readonly markerDigest: string;
  readonly runtimeSourceRevision: string;
  readonly capabilityRevision: number;
  readonly policyDigest: string;
  readonly authorityEpoch: number;
}

export interface ClaudeWakeAuthority {
  readonly schema: typeof CLAUDE_WAKE_AUTHORITY_SCHEMA;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly authorityEpoch: number;
  readonly markerDigest: string;
  readonly profileDigest: string;
  readonly leaseTokenDigest: string;
  readonly runtimeSourceRevision: string;
}

export interface RequiredClaudeWakeCapability {
  readonly requiredWireSchema: typeof CLAUDE_WAKE_GENERATION_SCHEMA;
  readonly requiredInboxSchema: typeof CLAUDE_INBOX_SCHEMA;
  readonly requiredProfileSchema: typeof CLAUDE_WAKE_CAPABILITY_SCHEMA;
  readonly requiredPolicyDigest: string;
  readonly minimumCompatibleRevision: number;
}

export type ClaudeWakeGenerationFailure =
  | "generation_marker_invalid"
  | "foreign_workspace_generation"
  | "multiple_active_generations"
  | "capability_profile_missing"
  | "capability_profile_invalid"
  | "capability_identity_mismatch"
  | "capability_policy_mismatch"
  | "capability_revision_unsupported"
  | "authority_record_missing"
  | "authority_record_invalid"
  | "authority_identity_mismatch"
  | "activation_recovery_failed"
  | "claim_authority_revoked"
  | "claim_lease_token_mismatch";

type Result<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: ClaudeWakeGenerationFailure };

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const parseRecord = (bytes: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(bytes);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export function parseClaudeWakeGeneration(bytes: string): ClaudeWakeGeneration | undefined {
  const value = parseRecord(bytes);
  if (
    !value ||
    !exactKeys(value, ["schema", "generation", "workspaceId", "inboxSchema"]) ||
    value.schema !== CLAUDE_WAKE_GENERATION_SCHEMA ||
    typeof value.generation !== "string" ||
    value.generation.length === 0 ||
    typeof value.workspaceId !== "string" ||
    !WORKSPACE_ID.test(value.workspaceId) ||
    value.inboxSchema !== CLAUDE_INBOX_SCHEMA
  ) {
    return undefined;
  }
  return value as unknown as ClaudeWakeGeneration;
}

export function parseClaudeWakeCapability(bytes: string): ClaudeWakeCapability | undefined {
  const value = parseRecord(bytes);
  if (
    !value ||
    !exactKeys(value, [
      "schema",
      "generation",
      "workspaceId",
      "markerDigest",
      "runtimeSourceRevision",
      "capabilityRevision",
      "policyDigest",
      "authorityEpoch",
    ]) ||
    value.schema !== CLAUDE_WAKE_CAPABILITY_SCHEMA ||
    typeof value.generation !== "string" ||
    value.generation.length === 0 ||
    typeof value.workspaceId !== "string" ||
    !WORKSPACE_ID.test(value.workspaceId) ||
    typeof value.markerDigest !== "string" ||
    !SHA256.test(value.markerDigest) ||
    typeof value.runtimeSourceRevision !== "string" ||
    !SHA40.test(value.runtimeSourceRevision) ||
    !Number.isSafeInteger(value.capabilityRevision) ||
    Number(value.capabilityRevision) < 1 ||
    typeof value.policyDigest !== "string" ||
    !SHA256.test(value.policyDigest) ||
    !Number.isSafeInteger(value.authorityEpoch) ||
    Number(value.authorityEpoch) < 1
  ) {
    return undefined;
  }
  return value as unknown as ClaudeWakeCapability;
}

function parseAuthority(bytes: string): ClaudeWakeAuthority | undefined {
  const value = parseRecord(bytes);
  if (
    !value ||
    !exactKeys(value, [
      "schema",
      "workspaceId",
      "sessionId",
      "generation",
      "authorityEpoch",
      "markerDigest",
      "profileDigest",
      "leaseTokenDigest",
      "runtimeSourceRevision",
    ]) ||
    value.schema !== CLAUDE_WAKE_AUTHORITY_SCHEMA ||
    typeof value.workspaceId !== "string" ||
    !WORKSPACE_ID.test(value.workspaceId) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    typeof value.generation !== "string" ||
    value.generation.length === 0 ||
    !Number.isSafeInteger(value.authorityEpoch) ||
    Number(value.authorityEpoch) < 1 ||
    typeof value.markerDigest !== "string" ||
    !SHA256.test(value.markerDigest) ||
    typeof value.profileDigest !== "string" ||
    !SHA256.test(value.profileDigest) ||
    typeof value.leaseTokenDigest !== "string" ||
    !SHA256.test(value.leaseTokenDigest) ||
    typeof value.runtimeSourceRevision !== "string" ||
    !SHA40.test(value.runtimeSourceRevision)
  ) {
    return undefined;
  }
  return value as unknown as ClaudeWakeAuthority;
}

const sha256 = (bytes: string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const stableJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

export function resolveRequiredClaudeWakeCapability(): RequiredClaudeWakeCapability {
  const policy = {
    wireSchema: CLAUDE_WAKE_GENERATION_SCHEMA,
    inboxSchema: CLAUDE_INBOX_SCHEMA,
    profileSchema: CLAUDE_WAKE_CAPABILITY_SCHEMA,
    minimumCompatibleRevision: 1,
  } as const;
  return {
    requiredWireSchema: policy.wireSchema,
    requiredInboxSchema: policy.inboxSchema,
    requiredProfileSchema: policy.profileSchema,
    requiredPolicyDigest: sha256(JSON.stringify(policy)),
    minimumCompatibleRevision: policy.minimumCompatibleRevision,
  };
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const authorityPath = (root: string, workspaceId: string): string =>
  join(root, "authorities", `${workspaceId}.authority.json`);
const capabilityPath = (root: string, sessionId: string): string =>
  join(root, "capabilities", `${safeName(sessionId)}.capability.json`);

function atomicWrite(path: string, bytes: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

type ActivationStep =
  | "journal_planned"
  | "previous_superseded"
  | "marker_written"
  | "profile_written"
  | "authority_written"
  | "journal_committed";

interface ActivationJournal {
  readonly state: "planned" | "active" | "rolled_back";
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly authorityEpoch: number;
  readonly previousMarkerName: string | null;
  readonly previousAuthorityBytes: string | null;
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function reconcileActivationJournals(root: string): Result<Record<never, never>> {
  const journalRoot = join(root, "activation-journal");
  if (!existsSync(journalRoot)) return { ok: true };
  for (const name of readdirSync(journalRoot).filter((entry) => entry.endsWith(".json"))) {
    const path = join(journalRoot, name);
    const value = parseRecord(readFileSync(path, "utf8")) as Partial<ActivationJournal> | undefined;
    if (!value || value.state !== "planned") continue;
    if (
      typeof value.workspaceId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.generation !== "string" ||
      !Number.isSafeInteger(value.authorityEpoch)
    ) {
      return { ok: false, reason: "activation_recovery_failed" };
    }
    const current = inspectClaudeWakeGeneration(root, value.workspaceId);
    if (
      current.ok &&
      current.authority.sessionId === value.sessionId &&
      current.authority.generation === value.generation &&
      current.authority.authorityEpoch === value.authorityEpoch
    ) {
      atomicWrite(path, stableJson({ ...value, state: "active" }));
      continue;
    }

    const previousMarkerPath =
      typeof value.previousMarkerName === "string" && value.previousMarkerName
        ? join(root, value.previousMarkerName)
        : undefined;
    const savedMarker = previousMarkerPath
      ? join(root, "superseded", `${value.authorityEpoch}-${value.previousMarkerName}`)
      : undefined;
    // A crash at journal_planned happens before supersession. In that window the previous
    // marker is still canonical, and removing a same-session marker would destroy it.
    const supersessionStarted = savedMarker ? existsSync(savedMarker) : false;
    if (
      !previousMarkerPath ||
      supersessionStarted ||
      value.previousMarkerName !== `${value.sessionId}.generation`
    ) {
      removeIfPresent(join(root, `${value.sessionId}.generation`));
      removeIfPresent(capabilityPath(root, value.sessionId));
    }
    const recordPath = authorityPath(root, value.workspaceId);
    if (typeof value.previousAuthorityBytes === "string") {
      atomicWrite(recordPath, value.previousAuthorityBytes);
    } else {
      removeIfPresent(recordPath);
    }
    if (typeof value.previousMarkerName === "string" && value.previousMarkerName) {
      if (savedMarker && existsSync(savedMarker)) {
        renameSync(savedMarker, previousMarkerPath as string);
        const previousSession = basename(value.previousMarkerName, ".generation");
        const savedProfile = join(
          root,
          "superseded",
          `${value.authorityEpoch}-${previousSession}.capability.json`,
        );
        if (existsSync(savedProfile))
          renameSync(savedProfile, capabilityPath(root, previousSession));
      } else if (!previousMarkerPath || !existsSync(previousMarkerPath)) {
        return { ok: false, reason: "activation_recovery_failed" };
      }
    }
    atomicWrite(path, stableJson({ ...value, state: "rolled_back" }));
  }
  return { ok: true };
}

function nextEpoch(root: string, workspaceId: string): number {
  const path = authorityPath(root, workspaceId);
  const authority = existsSync(path) ? parseAuthority(readFileSync(path, "utf8")) : undefined;
  let highest = authority?.authorityEpoch ?? 0;
  const journalRoot = join(root, "activation-journal");
  if (existsSync(journalRoot)) {
    for (const name of readdirSync(journalRoot).filter((entry) => entry.endsWith(".json"))) {
      const value = parseRecord(readFileSync(join(journalRoot, name), "utf8"));
      if (
        value?.workspaceId === workspaceId &&
        Number.isSafeInteger(value.authorityEpoch) &&
        Number(value.authorityEpoch) > highest
      ) {
        highest = Number(value.authorityEpoch);
      }
    }
  }
  return highest + 1;
}

export function inspectClaudeWakeGeneration(
  root: string,
  workspaceId: string,
): Result<{
  readonly generation: string;
  readonly authorityEpoch: number;
  readonly authority: ClaudeWakeAuthority;
}> {
  const markerPaths = existsSync(root)
    ? readdirSync(root).filter((name) => name.endsWith(".generation"))
    : [];
  if (markerPaths.length !== 1) {
    return {
      ok: false,
      reason: markerPaths.length > 1 ? "multiple_active_generations" : "generation_marker_invalid",
    };
  }
  const markerPath = join(root, markerPaths[0]);
  const markerBytes = readFileSync(markerPath, "utf8");
  const marker = parseClaudeWakeGeneration(markerBytes);
  if (!marker) return { ok: false, reason: "generation_marker_invalid" };
  if (marker.workspaceId !== workspaceId)
    return { ok: false, reason: "foreign_workspace_generation" };

  const sessionId = basename(markerPath, ".generation");
  const profileFile = capabilityPath(root, sessionId);
  if (!existsSync(profileFile)) return { ok: false, reason: "capability_profile_missing" };
  const profileBytes = readFileSync(profileFile, "utf8");
  const profile = parseClaudeWakeCapability(profileBytes);
  if (!profile) return { ok: false, reason: "capability_profile_invalid" };
  if (
    profile.generation !== marker.generation ||
    profile.workspaceId !== marker.workspaceId ||
    profile.markerDigest !== sha256(markerBytes)
  ) {
    return { ok: false, reason: "capability_identity_mismatch" };
  }
  const required = resolveRequiredClaudeWakeCapability();
  if (profile.policyDigest !== required.requiredPolicyDigest) {
    return { ok: false, reason: "capability_policy_mismatch" };
  }
  if (profile.capabilityRevision < required.minimumCompatibleRevision) {
    return { ok: false, reason: "capability_revision_unsupported" };
  }

  const recordPath = authorityPath(root, workspaceId);
  if (!existsSync(recordPath)) return { ok: false, reason: "authority_record_missing" };
  const authority = parseAuthority(readFileSync(recordPath, "utf8"));
  if (!authority) return { ok: false, reason: "authority_record_invalid" };
  if (
    authority.workspaceId !== workspaceId ||
    authority.sessionId !== sessionId ||
    authority.generation !== marker.generation ||
    authority.authorityEpoch !== profile.authorityEpoch ||
    authority.markerDigest !== profile.markerDigest ||
    authority.profileDigest !== sha256(profileBytes) ||
    authority.runtimeSourceRevision !== profile.runtimeSourceRevision
  ) {
    return { ok: false, reason: "authority_identity_mismatch" };
  }
  return {
    ok: true,
    generation: marker.generation,
    authorityEpoch: authority.authorityEpoch,
    authority,
  };
}

export function activateClaudeWakeGeneration(input: {
  readonly root: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly generation: string;
  readonly runtimeSourceRevision: string;
  readonly leaseToken: string;
  readonly beforeStep?: (step: ActivationStep) => void;
}): Result<{ readonly authority: ClaudeWakeAuthority }> {
  if (!WORKSPACE_ID.test(input.workspaceId) || !SHA40.test(input.runtimeSourceRevision)) {
    return { ok: false, reason: "generation_marker_invalid" };
  }
  mkdirSync(input.root, { recursive: true });
  const recovery = reconcileActivationJournals(input.root);
  if (!recovery.ok) return recovery;
  const markerNames = readdirSync(input.root).filter((name) => name.endsWith(".generation"));
  if (markerNames.length > 1) return { ok: false, reason: "multiple_active_generations" };

  const previous = markerNames[0];
  let previousReason: "legacy_generation_marker" | "generation_superseded" | undefined;
  if (previous) {
    const previousMarker = parseClaudeWakeGeneration(
      readFileSync(join(input.root, previous), "utf8"),
    );
    if (previousMarker && previousMarker.workspaceId !== input.workspaceId) {
      return { ok: false, reason: "foreign_workspace_generation" };
    }
    previousReason = previousMarker ? "generation_superseded" : "legacy_generation_marker";
  }

  const epoch = nextEpoch(input.root, input.workspaceId);
  const marker: ClaudeWakeGeneration = {
    schema: CLAUDE_WAKE_GENERATION_SCHEMA,
    generation: input.generation,
    workspaceId: input.workspaceId,
    inboxSchema: CLAUDE_INBOX_SCHEMA,
  };
  const markerBytes = stableJson(marker);
  const required = resolveRequiredClaudeWakeCapability();
  const profile: ClaudeWakeCapability = {
    schema: CLAUDE_WAKE_CAPABILITY_SCHEMA,
    generation: input.generation,
    workspaceId: input.workspaceId,
    markerDigest: sha256(markerBytes),
    runtimeSourceRevision: input.runtimeSourceRevision,
    capabilityRevision: required.minimumCompatibleRevision,
    policyDigest: required.requiredPolicyDigest,
    authorityEpoch: epoch,
  };
  const profileBytes = stableJson(profile);
  const authority: ClaudeWakeAuthority = {
    schema: CLAUDE_WAKE_AUTHORITY_SCHEMA,
    workspaceId: input.workspaceId,
    sessionId: safeName(input.sessionId),
    generation: input.generation,
    authorityEpoch: epoch,
    markerDigest: profile.markerDigest,
    profileDigest: sha256(profileBytes),
    leaseTokenDigest: sha256(input.leaseToken),
    runtimeSourceRevision: input.runtimeSourceRevision,
  };
  const recordPath = authorityPath(input.root, input.workspaceId);
  const previousAuthorityBytes = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : null;
  const journalPath = join(
    input.root,
    "activation-journal",
    `${epoch}-${authority.sessionId}.json`,
  );
  const journal: ActivationJournal = {
    state: "planned",
    workspaceId: input.workspaceId,
    sessionId: authority.sessionId,
    generation: input.generation,
    authorityEpoch: epoch,
    previousMarkerName: previous ?? null,
    previousAuthorityBytes,
  };
  atomicWrite(journalPath, stableJson(journal));
  input.beforeStep?.("journal_planned");

  if (previous) {
    mkdirSync(join(input.root, "superseded"), { recursive: true });
    renameSync(join(input.root, previous), join(input.root, "superseded", `${epoch}-${previous}`));
    const previousSession = basename(previous, ".generation");
    const previousProfile = capabilityPath(input.root, previousSession);
    if (existsSync(previousProfile)) {
      renameSync(
        previousProfile,
        join(input.root, "superseded", `${epoch}-${basename(previousProfile)}`),
      );
    }
    const handoff = {
      schema: CLAUDE_WAKE_RESTART_HANDOFF_SCHEMA,
      state: "restart_required",
      reason: previousReason,
      workspaceId: input.workspaceId,
      previousSessionId: previousSession,
      replacementSessionId: authority.sessionId,
      authorityEpoch: epoch,
    } as const;
    atomicWrite(
      join(input.root, "handoffs", `${epoch}-${safeName(previousSession)}.restart.json`),
      stableJson(handoff),
    );
    input.beforeStep?.("previous_superseded");
  }

  atomicWrite(join(input.root, `${authority.sessionId}.generation`), markerBytes);
  input.beforeStep?.("marker_written");
  atomicWrite(capabilityPath(input.root, authority.sessionId), profileBytes);
  input.beforeStep?.("profile_written");
  atomicWrite(recordPath, stableJson(authority));
  input.beforeStep?.("authority_written");
  atomicWrite(journalPath, stableJson({ ...journal, state: "active" }));
  input.beforeStep?.("journal_committed");
  return { ok: true, authority };
}

export function validateClaudeWakeClaimAuthority(
  root: string,
  expected: ClaudeWakeAuthority,
  leaseToken: string,
): Result<Record<never, never>> {
  const current = inspectClaudeWakeGeneration(root, expected.workspaceId);
  if (!current.ok) return current;
  if (
    current.authority.authorityEpoch !== expected.authorityEpoch ||
    current.authority.generation !== expected.generation ||
    current.authority.sessionId !== expected.sessionId ||
    current.authority.markerDigest !== expected.markerDigest ||
    current.authority.profileDigest !== expected.profileDigest
  ) {
    return { ok: false, reason: "claim_authority_revoked" };
  }
  if (current.authority.leaseTokenDigest !== sha256(leaseToken)) {
    return { ok: false, reason: "claim_lease_token_mismatch" };
  }
  return { ok: true };
}
