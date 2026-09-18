import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type NodeBootstrapReceipt,
  parseNodeBootstrapReceiptBytes,
} from "../runtime/node-bootstrap.ts";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const RELEASE_ID = /^rel-sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9._-]+$/;
const GENESIS = "genesis";

export type ConsumerRuntimeDenyReason =
  | "consumer_runtime_absent"
  | "consumer_runtime_identity_mismatch"
  | "consumer_runtime_digest_mismatch"
  | "consumer_runtime_external_path"
  | "consumer_runtime_resolution_denied"
  | "consumer_runtime_permission"
  | "consumer_runtime_indeterminate";

/** The runtime identity is data-only; no source checkout is a valid input. */
export interface ConsumerNodeRuntimeIdentity {
  readonly product_id: string;
  readonly consumer_root: string;
  readonly runtime_root: string;
  readonly operation_id: string;
  readonly attempt: number;
  readonly generation_id: string;
  readonly subject_revision: string;
  readonly artifact_digest: string;
  readonly node_executable_identity: string;
  readonly package_lock_digest: string;
  readonly source_graph_digest: string;
  readonly compiled_esm_digest: string;
  readonly release_id: string;
  readonly materializer_version: string;
  readonly artifact_set_digest: string;
  readonly control_manifest_digest: string;
  readonly sealed_policy: "compiled-esm-only";
}

export interface ConsumerNodeRuntimeBundle {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly bundle_digest: string;
  readonly bundle_path: string;
  readonly files: Readonly<Record<string, string>>;
  readonly history_sequence: number;
  readonly prior_bundle_digest: string;
  readonly prior_history_tip_digest: string;
}

export interface ConsumerNodeRuntimeBundleInput {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly compiled_esm: Uint8Array;
  readonly node_bootstrap_receipt: Uint8Array;
  readonly marker: Uint8Array;
  readonly consumer_receipt: Uint8Array;
  readonly history: Uint8Array;
  readonly operation_state: Uint8Array;
  readonly prior_bundle_digest?: string;
  readonly prior_history_tip_digest?: string;
  readonly history_sequence?: number;
}

export type ConsumerNodeRuntimeOperationKind = "install" | "update" | "rollback";

export interface ConsumerNodeRuntimePriorPointer {
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly digest: string;
}

/** Bytes admitted from the sealed release aggregate and Node producer. */
export interface ConsumerNodeRuntimePayloads {
  readonly compiled_esm: Uint8Array;
  readonly node_bootstrap_receipt: Uint8Array;
  readonly marker: Uint8Array;
  readonly consumer_receipt: Uint8Array;
  readonly history: Uint8Array;
  readonly operation_state: Uint8Array;
}

export interface ConsumerNodeRuntimeFilesystemOptions {
  /** The payload is immutable after this function returns. */
  readonly payloads: ConsumerNodeRuntimePayloads;
  /** Optional seam used by fault/partial-publish tests. */
  readonly fault?: (barrier: string) => void;
  /** Optional aggregate verifier; absence means bundle/payload admission only. */
  readonly verifySealedAggregate?: () => void;
  /** Physical lock removal seam; production defaults to recursive rmSync. */
  readonly removeLock?: (path: string) => void;
}

export interface ConsumerNodeRuntimeReadinessInput {
  readonly status: "ready" | "blocked";
  readonly reason?: ConsumerRuntimeDenyReason;
  readonly identity?: ConsumerNodeRuntimeIdentity;
  readonly bundle?: ConsumerNodeRuntimeBundle;
}

export interface ConsumerNodeRuntimePorts {
  readConsumerIdentity: () => void | Promise<void>;
  verifySealedAggregate: () => void | Promise<void>;
  verifyNodeGeneration: () => void | Promise<void>;
  acquireConsumerLock: () => void | Promise<void>;
  snapshotPriorActivePointer: () => void | Promise<void>;
  createPrivateStaging: (path: string) => void | Promise<void>;
  writeGenerationAndReceipt: (
    path: string,
    bundle: ConsumerNodeRuntimeBundle,
  ) => void | Promise<void>;
  fsyncStaging: (path: string) => void | Promise<void>;
  sealActivationBundle: (path: string, bundle: ConsumerNodeRuntimeBundle) => void | Promise<void>;
  atomicRenameActivePointerCAS: (bundle: ConsumerNodeRuntimeBundle) => void | Promise<void>;
  verifyActiveBundle: (bundle: ConsumerNodeRuntimeBundle) => void | Promise<void>;
  reconcileDurableOperation: () =>
    | "committed"
    | "uncommitted"
    | "unknown"
    | "partial"
    | Promise<"committed" | "uncommitted" | "unknown" | "partial">;
  releaseConsumerLock: () => void | Promise<void>;
  destroyPrivateStaging?: (path: string) => void | Promise<void>;
  quarantinePrivateStaging?: (path: string) => void | Promise<void>;
}

export type ConsumerNodeRuntimeInstallResult =
  | { readonly ok: true; readonly status: "committed"; readonly bundle: ConsumerNodeRuntimeBundle }
  | {
      readonly ok: false;
      readonly status: "denied" | "failed" | "indeterminate";
      readonly reason: ConsumerRuntimeDenyReason;
      readonly phase: "admission" | "staging" | "activation" | "reconcile" | "release";
      readonly error?: unknown;
    };

type Phase = "admission" | "staging" | "activation" | "reconcile" | "release";
type OperationState = "committed" | "uncommitted" | "unknown" | "partial";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable JSON bytes are the only bytes used for identity digests. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function digestConsumerRuntimeBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestConsumerRuntimeValue(value: unknown): string {
  return digestConsumerRuntimeBytes(Buffer.from(canonical(value), "utf8"));
}

/**
 * A generation can be addressed by its sealed identity independently of the
 * operation which published it.  History keeps both this stable address and
 * the full operation identity so rollback does not accidentally bind a target
 * to the current tip's operation id/attempt.
 */
function digestConsumerRuntimeGenerationIdentity(identity: ConsumerNodeRuntimeIdentity): string {
  const { operation_id: _operationId, attempt: _attempt, ...generationIdentity } = identity;
  return digestConsumerRuntimeValue(generationIdentity);
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

/**
 * Build the four local projections from the admitted identity.  These are
 * projections, not a second receipt authority: the producer receipt remains
 * byte-for-byte in `node-bootstrap-receipt.json`.
 */
export function buildConsumerNodeRuntimePayloads(input: {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly compiled_esm: Uint8Array;
  readonly node_bootstrap_receipt: Uint8Array;
  readonly prior_bundle_digest?: string;
  readonly prior_history_tip_digest?: string;
  readonly history_sequence?: number;
  readonly prior_history?: Uint8Array;
  readonly prior_identity?: ConsumerNodeRuntimeIdentity;
  readonly prior_pointer?: ConsumerNodeRuntimePriorPointer | null;
  readonly operation_kind?: ConsumerNodeRuntimeOperationKind;
  readonly prior_attestation?: Uint8Array;
}): ConsumerNodeRuntimePayloads {
  if (!validIdentity(input.identity)) throw new Error("invalid consumer runtime identity");
  const sequence = input.history_sequence ?? 0;
  const priorBundle = input.prior_bundle_digest ?? GENESIS;
  const priorTip = input.prior_history_tip_digest ?? GENESIS;
  assertHistory(sequence, priorBundle, priorTip);
  const identityDigest = digestConsumerRuntimeValue(input.identity);
  const operationKind = input.operation_kind ?? (sequence === 0 ? "install" : "update");
  if (sequence === 0 && operationKind !== "install") throw new Error("invalid history operation");
  if (sequence > 0 && operationKind === "install") throw new Error("invalid history operation");
  const priorHistory = input.prior_history;
  const priorPointer = input.prior_pointer;
  if (
    sequence > 0 &&
    (priorHistory !== undefined || priorPointer !== undefined || input.operation_kind)
  ) {
    if (!(priorHistory instanceof Uint8Array) || !priorPointer)
      throw new Error("invalid prior history");
    const priorRecords = parseHistoryRecords(priorHistory);
    const priorRecord = priorRecords.at(-1);
    if (!priorRecord || priorRecord.history_sequence !== sequence - 1)
      throw new Error("invalid prior history");
    if (priorRecord.record_digest !== priorTip) throw new Error("invalid prior history tip");
    if (
      !DIGEST.test(priorPointer.digest) ||
      digestConsumerRuntimeBytes(priorPointer.bytes) !== priorPointer.digest
    )
      throw new Error("invalid prior pointer");
    if (!Number.isSafeInteger(priorPointer.mode) || priorPointer.mode !== 0o444)
      throw new Error("invalid prior pointer");
    try {
      const pointer = JSON.parse(Buffer.from(priorPointer.bytes).toString("utf8")) as unknown;
      if (
        isRecord(pointer) &&
        typeof pointer.bundle_digest === "string" &&
        pointer.bundle_digest !== priorBundle
      )
        throw new Error("invalid prior pointer");
    } catch {
      throw new Error("invalid prior pointer");
    }
    if (operationKind === "rollback") {
      if (!(input.prior_attestation instanceof Uint8Array))
        throw new Error("rollback attestation missing");
      if (!input.prior_identity || !validIdentity(input.prior_identity))
        throw new Error("rollback prior identity missing");
      const targetGenerationDigest = digestConsumerRuntimeGenerationIdentity(input.prior_identity);
      const targetRecords = priorRecords.filter(
        (record) => record.generation_identity_digest === targetGenerationDigest,
      );
      const exactTargetDigest = digestConsumerRuntimeValue(input.prior_identity);
      const exactTargetRecords = targetRecords.filter(
        (record) => record.identity_digest === exactTargetDigest,
      );
      const targetRecord = exactTargetRecords.at(-1) ?? targetRecords.at(-1);
      if (!targetRecord) throw new Error("rollback prior identity not recorded");
      if (
        digestConsumerRuntimeGenerationIdentity(input.identity) !==
        targetRecord.generation_identity_digest
      )
        throw new Error("rollback prior identity mismatch");
      verifyNodeReceiptForIdentity(
        input.prior_identity,
        input.prior_attestation,
        input.compiled_esm,
      );
    }
  }
  const marker = {
    identity_digest: identityDigest,
    operation_id: input.identity.operation_id,
    attempt: input.identity.attempt,
    generation_id: input.identity.generation_id,
  };
  const consumerReceipt = {
    consumer: {
      materializerVersion: input.identity.materializer_version,
      releaseId: input.identity.release_id,
      sourceRevision: input.identity.subject_revision,
      artifactSetDigest: input.identity.artifact_set_digest,
      productId: input.identity.product_id,
      consumerRoot: input.identity.consumer_root,
      runtimeRoot: input.identity.runtime_root,
    },
    identity_digest: identityDigest,
    operation_id: input.identity.operation_id,
    attempt: input.identity.attempt,
    history_sequence: sequence,
    prior_bundle_digest: priorBundle,
    prior_history_tip_digest: priorTip,
    history_tip_digest: "pending",
  };
  const unsignedRecord = {
    history_sequence: sequence,
    operation_id: input.identity.operation_id,
    attempt: input.identity.attempt,
    operation_kind: operationKind,
    identity_digest: identityDigest,
    generation_identity_digest: digestConsumerRuntimeGenerationIdentity(input.identity),
    prior_bundle_digest: priorBundle,
    prior_history_tip_digest: priorTip,
  };
  const recordDigest = digestConsumerRuntimeValue(unsignedRecord);
  const historyRecord = { ...unsignedRecord, record_digest: recordDigest };
  const historyTip = recordDigest;
  const finalReceipt = { ...consumerReceipt, history_tip_digest: historyTip };
  return {
    compiled_esm: Buffer.from(input.compiled_esm),
    node_bootstrap_receipt: Buffer.from(input.node_bootstrap_receipt),
    marker: jsonBytes(marker),
    consumer_receipt: jsonBytes(finalReceipt),
    history:
      priorHistory && sequence > 0
        ? Buffer.concat([
            Buffer.from(priorHistory),
            Buffer.from(`${canonical(historyRecord)}\n`, "utf8"),
          ])
        : Buffer.from(`${canonical(historyRecord)}\n`, "utf8"),
    operation_state: jsonBytes({
      identity_digest: identityDigest,
      operation_id: input.identity.operation_id,
      attempt: input.identity.attempt,
      prior_pointer:
        priorPointer && sequence > 0
          ? {
              bytes_base64: Buffer.from(priorPointer.bytes).toString("base64"),
              mode: priorPointer.mode,
              digest: priorPointer.digest,
            }
          : null,
      history_tip_digest: historyTip,
      publication: "prepared",
    }),
  };
}

function contained(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const SAFE_PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validIdentity(value: unknown): value is ConsumerNodeRuntimeIdentity {
  if (!isRecord(value)) return false;
  if (typeof value.product_id !== "string" || !SAFE_PRODUCT_ID.test(value.product_id)) return false;
  const id = value as Partial<ConsumerNodeRuntimeIdentity>;
  return (
    typeof id.product_id === "string" &&
    id.product_id.length > 0 &&
    typeof id.consumer_root === "string" &&
    isAbsolute(id.consumer_root) &&
    typeof id.runtime_root === "string" &&
    isAbsolute(id.runtime_root) &&
    contained(id.consumer_root, id.runtime_root) &&
    typeof id.operation_id === "string" &&
    OPERATION_ID.test(id.operation_id) &&
    Number.isSafeInteger(id.attempt) &&
    (id.attempt as number) >= 0 &&
    typeof id.generation_id === "string" &&
    id.generation_id.length > 0 &&
    typeof id.subject_revision === "string" &&
    REVISION.test(id.subject_revision) &&
    typeof id.artifact_digest === "string" &&
    DIGEST.test(id.artifact_digest) &&
    typeof id.node_executable_identity === "string" &&
    /^node-[^|]+\|sha256:[a-f0-9]{64}$/.test(id.node_executable_identity) &&
    typeof id.package_lock_digest === "string" &&
    DIGEST.test(id.package_lock_digest) &&
    typeof id.source_graph_digest === "string" &&
    DIGEST.test(id.source_graph_digest) &&
    typeof id.compiled_esm_digest === "string" &&
    DIGEST.test(id.compiled_esm_digest) &&
    typeof id.release_id === "string" &&
    RELEASE_ID.test(id.release_id) &&
    typeof id.materializer_version === "string" &&
    id.materializer_version.length > 0 &&
    typeof id.artifact_set_digest === "string" &&
    DIGEST.test(id.artifact_set_digest) &&
    typeof id.control_manifest_digest === "string" &&
    DIGEST.test(id.control_manifest_digest) &&
    id.sealed_policy === "compiled-esm-only"
  );
}

function fileDigests(input: ConsumerNodeRuntimeBundleInput): Record<string, string> {
  return {
    "ut-tdd.mjs": digestConsumerRuntimeBytes(input.compiled_esm),
    "node-bootstrap-receipt.json": digestConsumerRuntimeBytes(input.node_bootstrap_receipt),
    "marker.json": digestConsumerRuntimeBytes(input.marker),
    "consumer-receipt.json": digestConsumerRuntimeBytes(input.consumer_receipt),
    "history.jsonl": digestConsumerRuntimeBytes(input.history),
    "operation-state.json": digestConsumerRuntimeBytes(input.operation_state),
  };
}

function assertHistory(sequence: number, priorBundle: string, priorTip: string): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid history sequence");
  if (sequence === 0 && (priorBundle !== GENESIS || priorTip !== GENESIS))
    throw new Error("invalid genesis history");
  if (sequence > 0 && (!DIGEST.test(priorBundle) || !DIGEST.test(priorTip)))
    throw new Error("invalid prior history identity");
}

function parseHistoryRecords(bytes: Uint8Array): readonly Record<string, unknown>[] {
  const raw = Buffer.from(bytes);
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) throw new Error("invalid history");
  const lines = raw.toString("utf8").split("\n");
  if (lines.at(-1) !== "") throw new Error("invalid history");
  const records: Record<string, unknown>[] = [];
  for (const line of lines.slice(0, -1)) {
    if (line.length === 0) throw new Error("invalid history");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error("invalid history");
    }
    if (!isRecord(parsed)) throw new Error("invalid history");
    const required = [
      "history_sequence",
      "operation_id",
      "attempt",
      "operation_kind",
      "identity_digest",
      "generation_identity_digest",
      "prior_bundle_digest",
      "prior_history_tip_digest",
      "record_digest",
    ];
    if (Object.keys(parsed).sort().join("\0") !== required.slice().sort().join("\0"))
      throw new Error("invalid history");
    if (
      !Number.isSafeInteger(parsed.history_sequence) ||
      (parsed.history_sequence as number) < 0 ||
      typeof parsed.operation_id !== "string" ||
      !OPERATION_ID.test(parsed.operation_id) ||
      !Number.isSafeInteger(parsed.attempt) ||
      (parsed.attempt as number) < 0 ||
      (parsed.operation_kind !== "install" &&
        parsed.operation_kind !== "update" &&
        parsed.operation_kind !== "rollback") ||
      typeof parsed.identity_digest !== "string" ||
      !DIGEST.test(parsed.identity_digest) ||
      typeof parsed.generation_identity_digest !== "string" ||
      !DIGEST.test(parsed.generation_identity_digest) ||
      typeof parsed.prior_bundle_digest !== "string" ||
      (parsed.prior_bundle_digest !== GENESIS && !DIGEST.test(parsed.prior_bundle_digest)) ||
      typeof parsed.prior_history_tip_digest !== "string" ||
      (parsed.prior_history_tip_digest !== GENESIS &&
        !DIGEST.test(parsed.prior_history_tip_digest)) ||
      typeof parsed.record_digest !== "string" ||
      !DIGEST.test(parsed.record_digest)
    )
      throw new Error("invalid history");
    const unsigned = { ...parsed };
    delete unsigned.record_digest;
    if (digestConsumerRuntimeValue(unsigned) !== parsed.record_digest)
      throw new Error("invalid history");
    const expectedSequence = records.length;
    if (parsed.history_sequence !== expectedSequence) throw new Error("invalid history");
    if (
      expectedSequence === 0 &&
      (parsed.prior_bundle_digest !== GENESIS || parsed.prior_history_tip_digest !== GENESIS)
    )
      throw new Error("invalid history");
    if (
      expectedSequence > 0 &&
      (parsed.prior_bundle_digest === GENESIS || parsed.prior_history_tip_digest === GENESIS)
    )
      throw new Error("invalid history");
    if (
      expectedSequence > 0 &&
      parsed.prior_history_tip_digest !== records[expectedSequence - 1].record_digest
    )
      throw new Error("invalid history");
    records.push(parsed);
  }
  if (records.length === 0) throw new Error("invalid history");
  return records;
}

export function bundlePathFor(identity: ConsumerNodeRuntimeIdentity, bundleDigest: string): string {
  if (!validIdentity(identity) || !DIGEST.test(bundleDigest))
    throw new Error("invalid consumer runtime identity");
  return resolve(
    identity.runtime_root,
    "bundles",
    identity.operation_id,
    `attempt-${identity.attempt}-${bundleDigest.slice(7)}`,
  );
}

export function stagingPathFor(identity: ConsumerNodeRuntimeIdentity): string {
  if (!validIdentity(identity)) throw new Error("invalid consumer runtime identity");
  return resolve(
    identity.runtime_root,
    "staging",
    identity.operation_id,
    `attempt-${identity.attempt}`,
  );
}

export function quarantinePathFor(
  identity: ConsumerNodeRuntimeIdentity,
  bundleDigest: string,
): string {
  if (!validIdentity(identity) || !DIGEST.test(bundleDigest))
    throw new Error("invalid consumer runtime identity");
  return resolve(
    identity.runtime_root,
    "quarantine",
    identity.operation_id,
    `attempt-${identity.attempt}-${bundleDigest.slice(7)}`,
  );
}

export function buildConsumerNodeRuntimeBundle(
  input: ConsumerNodeRuntimeBundleInput,
): ConsumerNodeRuntimeBundle {
  if (!validIdentity(input.identity)) throw new Error("invalid consumer runtime identity");
  if (digestConsumerRuntimeBytes(input.compiled_esm) !== input.identity.compiled_esm_digest)
    throw new Error("compiled ESM digest mismatch");
  const sequence = input.history_sequence ?? 0;
  const priorBundle = input.prior_bundle_digest ?? GENESIS;
  const priorTip = input.prior_history_tip_digest ?? GENESIS;
  assertHistory(sequence, priorBundle, priorTip);
  const files = fileDigests(input);
  const digest = digestConsumerRuntimeValue({
    identity: input.identity,
    files,
    history_sequence: sequence,
    prior_bundle_digest: priorBundle,
    prior_history_tip_digest: priorTip,
  });
  return Object.freeze({
    identity: Object.freeze({ ...input.identity }),
    bundle_digest: digest,
    bundle_path: bundlePathFor(input.identity, digest),
    files: Object.freeze(files),
    history_sequence: sequence,
    prior_bundle_digest: priorBundle,
    prior_history_tip_digest: priorTip,
  });
}

export function validateConsumerNodeRuntimeBundle(
  bundle: unknown,
): ConsumerRuntimeDenyReason | null {
  if (!isRecord(bundle) || !validIdentity(bundle.identity))
    return "consumer_runtime_identity_mismatch";
  if (typeof bundle.bundle_digest !== "string" || !DIGEST.test(bundle.bundle_digest))
    return "consumer_runtime_digest_mismatch";
  if (
    typeof bundle.bundle_path !== "string" ||
    !contained(bundle.identity.runtime_root, bundle.bundle_path)
  )
    return "consumer_runtime_external_path";
  if (
    !isRecord(bundle.files) ||
    Object.keys(bundle.files).sort().join("\0") !==
      [
        "consumer-receipt.json",
        "history.jsonl",
        "marker.json",
        "node-bootstrap-receipt.json",
        "operation-state.json",
        "ut-tdd.mjs",
      ]
        .sort()
        .join("\0") ||
    Object.values(bundle.files).some((value) => typeof value !== "string" || !DIGEST.test(value))
  )
    return "consumer_runtime_digest_mismatch";
  if (bundle.files["ut-tdd.mjs"] !== bundle.identity.compiled_esm_digest)
    return "consumer_runtime_digest_mismatch";
  try {
    assertHistory(
      bundle.history_sequence as number,
      bundle.prior_bundle_digest as string,
      bundle.prior_history_tip_digest as string,
    );
  } catch {
    return "consumer_runtime_identity_mismatch";
  }
  if (bundle.bundle_path !== bundlePathFor(bundle.identity, bundle.bundle_digest as string))
    return "consumer_runtime_external_path";
  const expectedDigest = digestConsumerRuntimeValue({
    identity: bundle.identity,
    files: bundle.files,
    history_sequence: bundle.history_sequence,
    prior_bundle_digest: bundle.prior_bundle_digest,
    prior_history_tip_digest: bundle.prior_history_tip_digest,
  });
  if (bundle.bundle_digest !== expectedDigest) return "consumer_runtime_digest_mismatch";
  return null;
}

export function validateConsumerReadiness(input: ConsumerNodeRuntimeReadinessInput | undefined): {
  ok: boolean;
  reason?: ConsumerRuntimeDenyReason;
} {
  if (!input || input.status !== "ready" || !input.identity || !input.bundle)
    return { ok: false, reason: input?.reason ?? "consumer_runtime_absent" };
  const reason = validateConsumerNodeRuntimeBundle(input.bundle);
  if (reason) return { ok: false, reason };
  if (
    digestConsumerRuntimeValue(input.identity) !== digestConsumerRuntimeValue(input.bundle.identity)
  )
    return { ok: false, reason: "consumer_runtime_identity_mismatch" };
  return { ok: true };
}

/** A generated wrapper has one resolution source: the consumer-local active pointer. */
export function renderConsumerNodeWrapper(): string {
  return `import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const consumerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pointerPath = resolve(consumerRoot, ".ut-tdd", "runtime", "activation", "active.json");
const deny = (reason) => { console.error(reason); process.exit(78); };
let pointer;
try { pointer = JSON.parse(readFileSync(pointerPath, "utf8")); } catch { deny("consumer_runtime_absent"); }
if (!pointer || typeof pointer.bundle_path !== "string" || typeof pointer.entry_path !== "string" || typeof pointer.bundle_digest !== "string") deny("consumer_runtime_resolution_denied");
if (Object.keys(pointer).sort().join("\\0") !== "bundle_digest\\0bundle_path\\0entry_path") deny("consumer_runtime_resolution_denied");
if (pointer.bundle_path !== resolve(pointer.bundle_path) || pointer.entry_path !== resolve(pointer.entry_path)) deny("consumer_runtime_resolution_denied");
const bundle = resolve(pointer.bundle_path), entry = resolve(pointer.entry_path);
const runtimeRoot = resolve(consumerRoot, ".ut-tdd", "runtime");
const runtimeRel = relative(runtimeRoot, bundle);
const rel = relative(bundle, entry);
if (runtimeRel === "" || runtimeRel === ".." || runtimeRel.startsWith("..") || rel === "" || rel === ".." || rel.startsWith("..")) deny("consumer_runtime_external_path");
let runtimeReal, bundleReal, entryReal;
try { runtimeReal = realpathSync.native(runtimeRoot); bundleReal = realpathSync.native(bundle); entryReal = realpathSync.native(entry); } catch { deny("consumer_runtime_absent"); }
const runtimePhysicalRel = relative(runtimeReal, bundleReal);
if (runtimePhysicalRel === "" || runtimePhysicalRel === ".." || runtimePhysicalRel.startsWith("..")) deny("consumer_runtime_external_path");
const physicalRel = relative(bundleReal, entryReal);
if (physicalRel === "" || physicalRel === ".." || physicalRel.startsWith("..")) deny("consumer_runtime_external_path");
const samePath = (left, right) => { try { const a = realpathSync.native(left), b = realpathSync.native(right); return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; } catch { return resolve(left) === resolve(right); } };
const sha256 = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
let manifest;
try { manifest = JSON.parse(readFileSync(resolve(bundle, "bundle-manifest.json"), "utf8")); } catch { deny("consumer_runtime_absent"); }
const required = ["consumer-receipt.json", "history.jsonl", "marker.json", "node-bootstrap-receipt.json", "operation-state.json", "ut-tdd.mjs"];
if (!manifest || typeof manifest.bundle_digest !== "string" || manifest.bundle_digest !== pointer.bundle_digest || manifest.bundle_path !== bundle || !manifest.identity || !samePath(manifest.identity.consumer_root, consumerRoot) || !samePath(manifest.identity.runtime_root, runtimeRoot) || manifest.identity.sealed_policy !== "compiled-esm-only" || typeof manifest.identity.node_executable_identity !== "string" || !/^node-[^|]+\\|sha256:[a-f0-9]{64}$/.test(manifest.identity.node_executable_identity) || !manifest.files || Object.keys(manifest.files).sort().join("\\0") !== required.slice().sort().join("\\0")) deny("consumer_runtime_identity_mismatch");
if (!Number.isSafeInteger(manifest.history_sequence) || manifest.history_sequence < 0 || (manifest.history_sequence === 0 && (manifest.prior_bundle_digest !== "genesis" || manifest.prior_history_tip_digest !== "genesis")) || (manifest.history_sequence > 0 && (typeof manifest.prior_bundle_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.prior_bundle_digest) || typeof manifest.prior_history_tip_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.prior_history_tip_digest)))) deny("consumer_runtime_identity_mismatch");
if (sha256(Buffer.from(canonical({ identity: manifest.identity, files: manifest.files, history_sequence: manifest.history_sequence, prior_bundle_digest: manifest.prior_bundle_digest, prior_history_tip_digest: manifest.prior_history_tip_digest }), "utf8")) !== manifest.bundle_digest) deny("consumer_runtime_digest_mismatch");
for (const name of required) { let bytes; try { bytes = readFileSync(resolve(bundle, name)); } catch { deny("consumer_runtime_absent"); } if (sha256(bytes) !== manifest.files[name]) deny("consumer_runtime_digest_mismatch"); }
if (manifest.files["ut-tdd.mjs"] !== manifest.identity.compiled_esm_digest) deny("consumer_runtime_digest_mismatch");
const payload = (name) => { try { return readFileSync(resolve(bundle, name)); } catch { deny("consumer_runtime_absent"); } };
const parsePayload = (name) => { try { const value = JSON.parse(payload(name).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) deny("consumer_runtime_resolution_denied"); return value; } catch { deny("consumer_runtime_resolution_denied"); } };
const marker = parsePayload("marker.json"), consumer = parsePayload("consumer-receipt.json"), operation = parsePayload("operation-state.json");
const identityDigest = sha256(Buffer.from(canonical(manifest.identity), "utf8"));
const { operation_id: _operationId, attempt: _attempt, ...generationIdentity } = manifest.identity;
const generationIdentityDigest = sha256(Buffer.from(canonical(generationIdentity), "utf8"));
let history;
try {
  const lines = payload("history.jsonl").toString("utf8").trim().split(/\\r?\\n/);
  if (lines.length === 0 || lines.some((line) => line.length === 0)) deny("consumer_runtime_resolution_denied");
  const records = lines.map((line) => JSON.parse(line));
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) deny("consumer_runtime_resolution_denied");
    if (record.history_sequence !== index || typeof record.record_digest !== "string" || typeof record.generation_identity_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.generation_identity_digest)) deny("consumer_runtime_resolution_denied");
    if (index === 0 && (record.prior_bundle_digest !== "genesis" || record.prior_history_tip_digest !== "genesis")) deny("consumer_runtime_resolution_denied");
    if (index > 0 && (typeof record.prior_bundle_digest !== "string" || typeof record.prior_history_tip_digest !== "string")) deny("consumer_runtime_resolution_denied");
    if (index > 0 && record.prior_history_tip_digest !== records[index - 1].record_digest) deny("consumer_runtime_resolution_denied");
const unsigned = {
      attempt: record.attempt,
      generation_identity_digest: record.generation_identity_digest,
      history_sequence: record.history_sequence,
      identity_digest: record.identity_digest,
      operation_id: record.operation_id,
      operation_kind: record.operation_kind,
      prior_bundle_digest: record.prior_bundle_digest,
      prior_history_tip_digest: record.prior_history_tip_digest,
    };
    if (sha256(Buffer.from(canonical(unsigned), "utf8")) !== record.record_digest) deny("consumer_runtime_resolution_denied");
  }
  history = records[records.length - 1];
} catch { deny("consumer_runtime_resolution_denied"); }
if (marker.identity_digest !== identityDigest || marker.operation_id !== manifest.identity.operation_id || marker.attempt !== manifest.identity.attempt || marker.generation_id !== manifest.identity.generation_id) deny("consumer_runtime_resolution_denied");
if (consumer.identity_digest !== marker.identity_digest || consumer.operation_id !== marker.operation_id || consumer.attempt !== marker.attempt || consumer.history_sequence !== manifest.history_sequence || consumer.prior_bundle_digest !== manifest.prior_bundle_digest || consumer.prior_history_tip_digest !== manifest.prior_history_tip_digest || consumer.history_tip_digest !== history.record_digest) deny("consumer_runtime_resolution_denied");
if (history.identity_digest !== marker.identity_digest || history.generation_identity_digest !== generationIdentityDigest || history.operation_id !== marker.operation_id || history.attempt !== marker.attempt || history.history_sequence !== manifest.history_sequence || history.prior_bundle_digest !== manifest.prior_bundle_digest || history.prior_history_tip_digest !== manifest.prior_history_tip_digest || sha256(Buffer.from(canonical({ attempt: history.attempt, generation_identity_digest: history.generation_identity_digest, history_sequence: history.history_sequence, identity_digest: history.identity_digest, operation_id: history.operation_id, operation_kind: history.operation_kind, prior_bundle_digest: history.prior_bundle_digest, prior_history_tip_digest: history.prior_history_tip_digest }), "utf8")) !== history.record_digest) deny("consumer_runtime_resolution_denied");
if (operation.identity_digest !== marker.identity_digest || operation.operation_id !== marker.operation_id || operation.attempt !== marker.attempt || operation.history_tip_digest !== history.record_digest) deny("consumer_runtime_resolution_denied");
const nodeReceipt = parsePayload("node-bootstrap-receipt.json"); const nodeReceiptDigest = nodeReceipt.receipt_digest; delete nodeReceipt.receipt_digest; if (typeof nodeReceiptDigest !== "string" || sha256(Buffer.from(canonical(nodeReceipt), "utf8")) !== "sha256:" + nodeReceiptDigest) deny("consumer_runtime_resolution_denied");
const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { cwd: consumerRoot, stdio: "inherit", windowsHide: true });
if (result.error) deny("consumer_runtime_resolution_denied");
process.exit(result.status ?? 1);
`;
}

type PointerSnapshot = { readonly bytes: Buffer; readonly mode: number } | null;

export interface ConsumerNodeRuntimeReconcileInput {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly bundle: ConsumerNodeRuntimeBundle;
  readonly prior: PointerSnapshot;
}

function fsyncFile(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } catch (error) {
      // Windows does not expose directory handles as fsync targets. File
      // contents are still flushed and the pointer rename remains atomic; do
      // not turn a supported Windows install into a false success elsewhere.
      if (process.platform !== "win32") throw error;
    }
  } catch (error) {
    // Windows may reject opening a directory even though the files and the
    // atomic rename are durable. Treat that platform limitation like a
    // rejected directory fsync, but never hide it on POSIX.
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureRealContained(parent: string, child: string): void {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  const lexical = relative(parentResolved, childResolved);
  if (!contained(parentResolved, childResolved)) throw new Error("consumer_runtime_external_path");
  if (!existsSync(parentResolved)) mkdirSync(parentResolved, { recursive: true });
  const parentReal = realpathSync.native(parentResolved);
  let nearest = childResolved;
  while (!existsSync(nearest) && nearest !== dirnameOf(nearest)) nearest = dirnameOf(nearest);
  if (existsSync(nearest)) {
    const nearestReal = realpathSync.native(nearest);
    const physical = relative(parentReal, nearestReal);
    if (physical === ".." || physical.startsWith(`..${sep}`) || isAbsolute(physical))
      throw new Error("consumer_runtime_external_path");
  }
  if (!lexical) throw new Error("consumer_runtime_external_path");
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path.slice(0, 1) : path.slice(0, index);
}

function readPointer(pointerPath: string): PointerSnapshot {
  if (!existsSync(pointerPath)) return null;
  const bytes = readFileSync(pointerPath);
  return { bytes, mode: statSync(pointerPath).mode & 0o777 };
}

function pointerBytes(bundle: ConsumerNodeRuntimeBundle): Buffer {
  return Buffer.from(`${canonical(pointerValue(bundle))}\n`, "utf8");
}

function samePointer(left: PointerSnapshot, right: PointerSnapshot): boolean {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.bytes.equals(right.bytes);
}

function parsePointerSnapshot(bytes: Uint8Array): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("consumer_runtime_identity_mismatch");
  }
  if (!isRecord(value)) throw new Error("consumer_runtime_identity_mismatch");
  if (
    Object.keys(value).sort().join("\0") !== "bundle_digest\0bundle_path\0entry_path" ||
    typeof value.bundle_digest !== "string" ||
    typeof value.bundle_path !== "string" ||
    typeof value.entry_path !== "string" ||
    !DIGEST.test(value.bundle_digest) ||
    value.bundle_path !== resolve(value.bundle_path) ||
    value.entry_path !== resolve(value.entry_path)
  )
    throw new Error("consumer_runtime_identity_mismatch");
  return value as Record<string, string>;
}

function priorPointerFromOperationState(bytes: Uint8Array): ConsumerNodeRuntimePriorPointer | null {
  const operation = validJsonProjection(bytes, "operation_state");
  const value = operation.prior_pointer;
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("consumer_runtime_identity_mismatch");
  const encoded = value.bytes_base64;
  const mode = value.mode;
  const digest = value.digest;
  if (
    typeof encoded !== "string" ||
    Buffer.from(encoded, "base64").toString("base64") !== encoded ||
    !Number.isSafeInteger(mode) ||
    mode !== 0o444 ||
    typeof digest !== "string" ||
    !DIGEST.test(digest)
  )
    throw new Error("consumer_runtime_identity_mismatch");
  const pointerBytes = Buffer.from(encoded, "base64");
  if (digestConsumerRuntimeBytes(pointerBytes) !== digest)
    throw new Error("consumer_runtime_identity_mismatch");
  return { bytes: pointerBytes, mode, digest };
}

function priorHistoryPrefix(bytes: Uint8Array): Buffer {
  const raw = Buffer.from(bytes);
  const currentLineStart = raw.lastIndexOf(0x0a, raw.length - 2);
  if (currentLineStart < 0) throw new Error("consumer_runtime_identity_mismatch");
  return raw.subarray(0, currentLineStart + 1);
}

function assertPriorSnapshot(input: {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly bundle: ConsumerNodeRuntimeBundle;
  readonly payloads: ConsumerNodeRuntimePayloads;
  readonly prior: PointerSnapshot;
}): void {
  if (input.bundle.history_sequence === 0) {
    if (input.prior) throw new Error("consumer_runtime_identity_mismatch");
    return;
  }
  if (!input.prior) throw new Error("consumer_runtime_identity_mismatch");
  const suppliedPrior = priorPointerFromOperationState(input.payloads.operation_state);
  if (
    !suppliedPrior ||
    input.prior.mode !== suppliedPrior.mode ||
    !input.prior.bytes.equals(Buffer.from(suppliedPrior.bytes))
  )
    throw new Error("consumer_runtime_identity_mismatch");
  const pointer = parsePointerSnapshot(input.prior.bytes);
  if (pointer.bundle_digest !== input.bundle.prior_bundle_digest)
    throw new Error("consumer_runtime_identity_mismatch");
  const priorBundlePath = pointer.bundle_path;
  ensureRealContained(input.identity.runtime_root, priorBundlePath);
  const manifest = validJsonProjection(
    readFileSync(join(priorBundlePath, "bundle-manifest.json")),
    "prior_bundle_manifest",
  ) as unknown as ConsumerNodeRuntimeBundle;
  if (
    validateConsumerNodeRuntimeBundle(manifest) ||
    manifest.bundle_path !== priorBundlePath ||
    manifest.bundle_digest !== pointer.bundle_digest ||
    manifest.history_sequence !== input.bundle.history_sequence - 1
  )
    throw new Error("consumer_runtime_identity_mismatch");
  const activeHistory = readFileSync(join(priorBundlePath, "history.jsonl"));
  if (
    digestConsumerRuntimeBytes(activeHistory) !== manifest.files["history.jsonl"] ||
    !activeHistory.equals(priorHistoryPrefix(input.payloads.history))
  )
    throw new Error("consumer_runtime_identity_mismatch");
  const records = parseHistoryRecords(activeHistory);
  if (
    records.length !== input.bundle.history_sequence ||
    records.at(-1)?.record_digest !== input.bundle.prior_history_tip_digest
  )
    throw new Error("consumer_runtime_identity_mismatch");
}

function bundleFilesIntact(bundle: ConsumerNodeRuntimeBundle): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(bundle.bundle_path, "bundle-manifest.json"), "utf8"),
    ) as unknown;
    if (validateConsumerNodeRuntimeBundle(manifest)) return false;
    for (const [name, digest] of Object.entries(bundle.files)) {
      if (digestConsumerRuntimeBytes(readFileSync(join(bundle.bundle_path, name))) !== digest)
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Read-only durable reconciliation. It never creates, renames, or deletes files. */
export function reconcileConsumerNodeRuntimeOnFilesystem(
  input: ConsumerNodeRuntimeReconcileInput,
): OperationState {
  if (!validIdentity(input.identity) || validateConsumerNodeRuntimeBundle(input.bundle))
    return "unknown";
  const pointerPath = join(input.identity.runtime_root, "activation", "active.json");
  let observed: PointerSnapshot;
  try {
    observed = readPointer(pointerPath);
  } catch {
    return "unknown";
  }
  const committed = observed?.bytes.equals(pointerBytes(input.bundle)) === true;
  if (committed) return bundleFilesIntact(input.bundle) ? "committed" : "partial";
  if (samePointer(observed, input.prior)) return "uncommitted";
  if (observed === null && input.prior !== null) return "unknown";
  return "partial";
}

function pointerValue(bundle: ConsumerNodeRuntimeBundle): Record<string, string> {
  return {
    bundle_path: bundle.bundle_path,
    entry_path: join(bundle.bundle_path, "ut-tdd.mjs"),
    bundle_digest: bundle.bundle_digest,
  };
}

function validJsonProjection(bytes: Uint8Array, name: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!isRecord(parsed)) throw new Error(name);
    return parsed;
  } catch {
    throw new Error(`consumer_runtime_${name}_invalid`);
  }
}

function verifyNodeReceiptForIdentity(
  identity: ConsumerNodeRuntimeIdentity,
  bytes: Uint8Array,
  compiledEsm: Uint8Array,
): void {
  let receipt: NodeBootstrapReceipt;
  try {
    receipt = parseNodeBootstrapReceiptBytes(bytes);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "consumer_runtime_identity_mismatch");
  }
  const nodeIdentity = /^node-([^|]+)\|(sha256:[a-f0-9]{64})$/.exec(
    identity.node_executable_identity,
  );
  if (
    receipt.generation_id !== identity.generation_id ||
    receipt.subject_revision !== identity.subject_revision ||
    digestConsumerRuntimeBytes(compiledEsm) !== identity.compiled_esm_digest ||
    !nodeIdentity ||
    receipt.node.version !== nodeIdentity[1] ||
    `sha256:${receipt.node.sha256}` !== nodeIdentity[2] ||
    `sha256:${receipt.package_lock_sha256}` !== identity.package_lock_digest ||
    `sha256:${receipt.source_graph_sha256}` !== identity.source_graph_digest ||
    `sha256:${receipt.compiled_cli.sha256}` !== identity.compiled_esm_digest
  )
    throw new Error("consumer_runtime_identity_mismatch");
}

function verifyRuntimePayloads(
  identity: ConsumerNodeRuntimeIdentity,
  bundle: ConsumerNodeRuntimeBundle,
  payloads: ConsumerNodeRuntimePayloads,
): void {
  const records = parseHistoryRecords(payloads.history);
  const last = records.at(-1);
  if (
    !last ||
    last.history_sequence !== bundle.history_sequence ||
    last.prior_bundle_digest !== bundle.prior_bundle_digest ||
    last.prior_history_tip_digest !== bundle.prior_history_tip_digest
  )
    throw new Error("consumer_runtime_history_invalid");
  if (records.length > 1) {
    const operation = validJsonProjection(payloads.operation_state, "operation_state");
    const expectedKeys = [
      "attempt",
      "history_tip_digest",
      "identity_digest",
      "operation_id",
      "prior_pointer",
      "publication",
    ];
    if (Object.keys(operation).sort().join("\0") !== expectedKeys.sort().join("\0"))
      throw new Error("consumer_runtime_operation_state_invalid");
    const pointer = operation.prior_pointer;
    if (
      !isRecord(pointer) ||
      Object.keys(pointer).sort().join("\0") !== "bytes_base64\0digest\0mode"
    )
      throw new Error("consumer_runtime_operation_state_invalid");
    if (
      typeof pointer.bytes_base64 !== "string" ||
      Buffer.from(pointer.bytes_base64, "base64").toString("base64") !== pointer.bytes_base64 ||
      typeof pointer.digest !== "string" ||
      digestConsumerRuntimeBytes(Buffer.from(pointer.bytes_base64, "base64")) !== pointer.digest ||
      pointer.mode !== 0o444
    )
      throw new Error("consumer_runtime_operation_state_invalid");
  }
  const consumer = validJsonProjection(payloads.consumer_receipt, "consumer_receipt");
  if (
    consumer.history_sequence !== bundle.history_sequence ||
    consumer.prior_bundle_digest !== bundle.prior_bundle_digest ||
    consumer.prior_history_tip_digest !== bundle.prior_history_tip_digest ||
    consumer.history_tip_digest !== last.record_digest ||
    consumer.identity_digest !== digestConsumerRuntimeValue(identity)
  )
    throw new Error("consumer_runtime_resolution_denied");
}

/**
 * Production Node filesystem adapter.  It publishes a complete immutable
 * bundle first, then swaps one active pointer. No public pointer is touched
 * while a payload is incomplete.
 */
export function createConsumerNodeRuntimeFilesystemPorts(
  identity: ConsumerNodeRuntimeIdentity,
  bundle: ConsumerNodeRuntimeBundle,
  options: ConsumerNodeRuntimeFilesystemOptions,
): ConsumerNodeRuntimePorts {
  if (!validIdentity(identity)) throw new Error("consumer_runtime_identity_mismatch");
  const payloads = options.payloads;
  const stage = stagingPathFor(identity);
  const pointerPath = join(identity.runtime_root, "activation", "active.json");
  const lockPath = join(identity.runtime_root, "locks", `${identity.product_id}.lock`);
  const state: {
    prior: PointerSnapshot;
    sealed: boolean;
    locked: boolean;
    bundleManifest: string | null;
  } = { prior: null, sealed: false, locked: false, bundleManifest: null };
  const fault = (name: string) => options.fault?.(name);
  const requirePayloadDigest = (name: keyof ConsumerNodeRuntimePayloads, file: string) => {
    const bytes = payloads[name];
    if (!(bytes instanceof Uint8Array) || digestConsumerRuntimeBytes(bytes) !== bundle.files[file])
      throw new Error("consumer_runtime_digest_mismatch");
    return bytes;
  };
  return {
    readConsumerIdentity: () => {
      ensureRealContained(identity.consumer_root, identity.runtime_root);
      fault("readConsumerIdentity");
    },
    verifySealedAggregate: () => {
      if (options.verifySealedAggregate) options.verifySealedAggregate();
      if (validateConsumerNodeRuntimeBundle(bundle))
        throw new Error("consumer_runtime_identity_mismatch");
      verifyNodeReceiptForIdentity(
        identity,
        requirePayloadDigest("node_bootstrap_receipt", "node-bootstrap-receipt.json"),
        requirePayloadDigest("compiled_esm", "ut-tdd.mjs"),
      );
      verifyRuntimePayloads(identity, bundle, payloads);
      fault("verifySealedAggregate");
    },
    verifyNodeGeneration: () => {
      // Receipt parsing and tuple matching are intentionally repeated at the
      // generation boundary: a caller cannot replace the admitted bytes after
      // aggregate verification.
      verifyNodeReceiptForIdentity(
        identity,
        requirePayloadDigest("node_bootstrap_receipt", "node-bootstrap-receipt.json"),
        requirePayloadDigest("compiled_esm", "ut-tdd.mjs"),
      );
      verifyRuntimePayloads(identity, bundle, payloads);
      fault("verifyNodeGeneration");
    },
    acquireConsumerLock: () => {
      ensureRealContained(identity.consumer_root, identity.runtime_root);
      mkdirSync(join(identity.runtime_root, "locks"), { recursive: true });
      mkdirSync(lockPath, { recursive: false });
      state.locked = true;
      try {
        fault("acquireConsumerLock");
      } catch (error) {
        // The orchestrator can only mark its lock as acquired after this port
        // resolves. If an injected/real failure occurs after mkdir, release
        // the physical lock here so the failed admission cannot strand it.
        rmSync(lockPath, { recursive: true, force: false });
        state.locked = false;
        throw error;
      }
    },
    snapshotPriorActivePointer: () => {
      state.prior = readPointer(pointerPath);
      assertPriorSnapshot({ identity, bundle, payloads, prior: state.prior });
      fault("snapshotPriorActivePointer");
    },
    createPrivateStaging: (path) => {
      if (resolve(path) !== resolve(stage)) throw new Error("consumer_runtime_external_path");
      ensureRealContained(identity.runtime_root, path);
      mkdirSync(dirnameOf(path), { recursive: true });
      mkdirSync(path, { recursive: false });
      state.bundleManifest = null;
      fault("createPrivateStaging");
    },
    writeGenerationAndReceipt: (path, candidate) => {
      if (resolve(path) !== resolve(stage) || candidate.bundle_digest !== bundle.bundle_digest)
        throw new Error("consumer_runtime_identity_mismatch");
      const files: Record<string, Uint8Array> = {
        "ut-tdd.mjs": requirePayloadDigest("compiled_esm", "ut-tdd.mjs"),
        "node-bootstrap-receipt.json": requirePayloadDigest(
          "node_bootstrap_receipt",
          "node-bootstrap-receipt.json",
        ),
        "marker.json": requirePayloadDigest("marker", "marker.json"),
        "consumer-receipt.json": requirePayloadDigest("consumer_receipt", "consumer-receipt.json"),
        "history.jsonl": requirePayloadDigest("history", "history.jsonl"),
        "operation-state.json": requirePayloadDigest("operation_state", "operation-state.json"),
      };
      validJsonProjection(files["marker.json"], "marker");
      validJsonProjection(files["consumer-receipt.json"], "consumer_receipt");
      validJsonProjection(files["operation-state.json"], "operation_state");
      parseHistoryRecords(files["history.jsonl"]);
      verifyRuntimePayloads(identity, bundle, payloads);
      for (const [name, bytes] of Object.entries(files))
        writeFileSync(join(path, name), bytes, { mode: 0o444 });
      const manifest = {
        ...bundle,
        files: { ...bundle.files },
      };
      writeFileSync(join(path, "bundle-manifest.json"), `${canonical(manifest)}\n`, {
        mode: 0o444,
      });
      state.bundleManifest = canonical(manifest);
      fault("writeGenerationAndReceipt");
    },
    fsyncStaging: (path) => {
      if (!state.bundleManifest || !existsSync(path)) throw new Error("consumer_runtime_absent");
      for (const name of [
        "ut-tdd.mjs",
        "node-bootstrap-receipt.json",
        "marker.json",
        "consumer-receipt.json",
        "history.jsonl",
        "operation-state.json",
        "bundle-manifest.json",
      ])
        fsyncFile(join(path, name));
      fsyncDirectory(path);
      fault("fsyncStaging");
    },
    sealActivationBundle: (path, candidate) => {
      if (resolve(path) !== resolve(stage)) throw new Error("consumer_runtime_external_path");
      const parent = dirnameOf(candidate.bundle_path);
      ensureRealContained(identity.runtime_root, parent);
      mkdirSync(parent, { recursive: true });
      if (existsSync(candidate.bundle_path)) throw new Error("consumer_runtime_indeterminate");
      fault("sealActivationBundle");
      renameSync(path, candidate.bundle_path);
      state.sealed = true;
      chmodSync(candidate.bundle_path, 0o555);
      fsyncDirectory(parent);
    },
    atomicRenameActivePointerCAS: (candidate) => {
      if (!state.sealed) throw new Error("consumer_runtime_indeterminate");
      const observed = readPointer(pointerPath);
      if (
        observed?.mode !== state.prior?.mode ||
        observed?.bytes?.equals(state.prior?.bytes ?? Buffer.alloc(0)) !== true
      ) {
        if (observed !== null || state.prior !== null)
          throw new Error("consumer_runtime_indeterminate");
      }
      const activation = dirnameOf(pointerPath);
      ensureRealContained(identity.runtime_root, activation);
      mkdirSync(activation, { recursive: true });
      const pointerTemp = join(
        activation,
        `.active-${identity.operation_id}-${identity.attempt}.tmp`,
      );
      if (existsSync(pointerTemp)) throw new Error("consumer_runtime_indeterminate");
      const bytes = Buffer.from(`${canonical(pointerValue(candidate))}\n`, "utf8");
      writeFileSync(pointerTemp, bytes, { mode: 0o444 });
      fsyncFile(pointerTemp);
      // Windows refuses to replace an existing read-only file with rename(2).
      // The active pointer remains the single publication point: make only the
      // old pointer writable for the duration of the atomic replacement, and
      // restore its exact mode if the pre-rename fault/rename fails. Once the
      // rename succeeds, any later durability error is indeterminate and must
      // not be followed by a best-effort rollback to an older pointer.
      const priorMode = observed?.mode;
      const needsWindowsWritable = process.platform === "win32" && observed !== null;
      let madeWindowsWritable = false;
      let replaced = false;
      try {
        if (needsWindowsWritable && priorMode !== undefined) {
          chmodSync(pointerPath, priorMode | 0o200);
          madeWindowsWritable = true;
        }
        fault("atomicRenameActivePointerCAS");
        renameSync(pointerTemp, pointerPath);
        replaced = true;
        chmodSync(pointerPath, 0o444);
        fsyncDirectory(activation);
      } catch (error) {
        if (!replaced) {
          try {
            if (existsSync(pointerTemp)) rmSync(pointerTemp, { force: true });
          } finally {
            if (madeWindowsWritable && priorMode !== undefined && existsSync(pointerPath))
              chmodSync(pointerPath, priorMode);
          }
        }
        throw error;
      }
    },
    verifyActiveBundle: (candidate) => {
      const pointer = readPointer(pointerPath);
      if (!pointer) throw new Error("consumer_runtime_absent");
      const expected = Buffer.from(`${canonical(pointerValue(candidate))}\n`, "utf8");
      if (!pointer.bytes.equals(expected)) throw new Error("consumer_runtime_indeterminate");
      const manifest = JSON.parse(
        readFileSync(join(candidate.bundle_path, "bundle-manifest.json"), "utf8"),
      ) as unknown;
      if (validateConsumerNodeRuntimeBundle(manifest))
        throw new Error("consumer_runtime_digest_mismatch");
      for (const [name, field] of [
        ["ut-tdd.mjs", "compiled_esm"],
        ["node-bootstrap-receipt.json", "node_bootstrap_receipt"],
        ["marker.json", "marker"],
        ["consumer-receipt.json", "consumer_receipt"],
        ["history.jsonl", "history"],
        ["operation-state.json", "operation_state"],
      ] as const) {
        const bytes = readFileSync(join(candidate.bundle_path, name));
        if (
          digestConsumerRuntimeBytes(bytes) !== candidate.files[name] ||
          !bytes.equals(payloads[field])
        )
          throw new Error("consumer_runtime_digest_mismatch");
      }
      fault("verifyActiveBundle");
    },
    reconcileDurableOperation: () => {
      return reconcileConsumerNodeRuntimeOnFilesystem({ identity, bundle, prior: state.prior });
    },
    releaseConsumerLock: () => {
      let cleanupError: unknown;
      if (state.locked) {
        const removeLock =
          options.removeLock ?? ((path: string) => rmSync(path, { recursive: true, force: false }));
        for (let attempt = 0; attempt < 2 && existsSync(lockPath); attempt += 1) {
          try {
            removeLock(lockPath);
          } catch (error) {
            cleanupError = error;
          }
        }
        if (!existsSync(lockPath)) cleanupError = undefined;
        if (existsSync(lockPath) && cleanupError === undefined)
          cleanupError = new Error("consumer_runtime_lock_cleanup_incomplete");
      }
      if (cleanupError !== undefined && existsSync(lockPath)) state.locked = true;
      else state.locked = false;
      let faultError: unknown;
      try {
        fault("releaseConsumerLock");
      } catch (error) {
        faultError = error;
      }
      if (cleanupError !== undefined && faultError !== undefined)
        throw { cleanup: cleanupError, fault: faultError };
      if (cleanupError !== undefined) throw cleanupError;
      if (faultError !== undefined) throw faultError;
    },
    destroyPrivateStaging: (path) => {
      if (resolve(path) !== resolve(stage)) throw new Error("consumer_runtime_external_path");
      rmSync(path, { recursive: true, force: true });
    },
    quarantinePrivateStaging: (path) => {
      if (resolve(path) !== resolve(stage)) throw new Error("consumer_runtime_external_path");
      const destination = quarantinePathFor(identity, bundle.bundle_digest);
      ensureRealContained(identity.runtime_root, dirnameOf(destination));
      mkdirSync(dirnameOf(destination), { recursive: true });
      if (existsSync(destination)) throw new Error("consumer_runtime_indeterminate");
      renameSync(path, destination);
    },
  };
}

export async function installConsumerNodeRuntimeOnFilesystem(input: {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly bundle: ConsumerNodeRuntimeBundle;
  readonly payloads: ConsumerNodeRuntimePayloads;
  readonly fault?: (barrier: string) => void;
  readonly verifySealedAggregate?: () => void;
  readonly removeLock?: (path: string) => void;
}): Promise<ConsumerNodeRuntimeInstallResult> {
  return installConsumerNodeRuntime({
    identity: input.identity,
    bundle: input.bundle,
    ports: createConsumerNodeRuntimeFilesystemPorts(input.identity, input.bundle, input),
  });
}

function failure(input: {
  status: "denied" | "failed" | "indeterminate";
  reason: ConsumerRuntimeDenyReason;
  phase: Phase;
  error?: unknown;
}): ConsumerNodeRuntimeInstallResult {
  return {
    ok: false,
    status: input.status,
    reason: input.reason,
    phase: input.phase,
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

function reasonFromError(error: unknown): ConsumerRuntimeDenyReason | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const reasons: ConsumerRuntimeDenyReason[] = [
    "consumer_runtime_absent",
    "consumer_runtime_identity_mismatch",
    "consumer_runtime_digest_mismatch",
    "consumer_runtime_external_path",
    "consumer_runtime_resolution_denied",
    "consumer_runtime_permission",
    "consumer_runtime_indeterminate",
  ];
  return reasons.find((reason) => message.includes(reason));
}

export async function installConsumerNodeRuntime(input: {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly bundle: ConsumerNodeRuntimeBundle;
  readonly ports: ConsumerNodeRuntimePorts;
}): Promise<ConsumerNodeRuntimeInstallResult> {
  const { identity, bundle, ports } = input;
  if (!validIdentity(identity))
    return failure({
      status: "denied",
      reason: "consumer_runtime_identity_mismatch",
      phase: "admission",
    });
  const bundleReason = validateConsumerNodeRuntimeBundle(bundle);
  if (
    bundleReason ||
    digestConsumerRuntimeValue(identity) !== digestConsumerRuntimeValue(bundle.identity)
  )
    return failure({
      status: "denied",
      reason: bundleReason ?? "consumer_runtime_identity_mismatch",
      phase: "admission",
    });
  const stage = stagingPathFor(identity);
  let locked = false,
    staged = false,
    committed = false,
    renameStarted = false,
    phase: Phase = "admission";
  let primaryError: unknown;
  let result: ConsumerNodeRuntimeInstallResult | undefined;
  let reconciled = false;
  const reconcileOnce = async (): Promise<OperationState> => {
    if (reconciled) return "unknown";
    reconciled = true;
    return await ports.reconcileDurableOperation();
  };
  try {
    await ports.readConsumerIdentity();
    await ports.verifySealedAggregate();
    await ports.verifyNodeGeneration();
    await ports.acquireConsumerLock();
    locked = true;
    phase = "staging";
    await ports.snapshotPriorActivePointer();
    await ports.createPrivateStaging(stage);
    staged = true;
    await ports.writeGenerationAndReceipt(stage, bundle);
    await ports.fsyncStaging(stage);
    await ports.sealActivationBundle(stage, bundle);
    renameStarted = true;
    await ports.atomicRenameActivePointerCAS(bundle);
    committed = true;
    phase = "activation";
    await ports.verifyActiveBundle(bundle);
    const state = await reconcileOnce();
    if (state !== "committed") {
      result = failure({
        status: "indeterminate",
        reason: "consumer_runtime_indeterminate",
        phase: "reconcile",
      });
    } else {
      result = { ok: true, status: "committed", bundle };
    }
  } catch (error) {
    primaryError = error;
    if (committed || renameStarted) {
      phase = "reconcile";
      try {
        await reconcileOnce();
      } catch (reconcileError) {
        primaryError = { primary: error, reconcile: reconcileError };
      }
      result = failure({
        status: "indeterminate",
        reason: "consumer_runtime_indeterminate",
        phase: "reconcile",
        error: primaryError,
      });
    } else {
      phase = phase === "admission" ? "admission" : "staging";
      if (staged) {
        try {
          if (ports.destroyPrivateStaging) await ports.destroyPrivateStaging(stage);
          else if (ports.quarantinePrivateStaging) await ports.quarantinePrivateStaging(stage);
        } catch (cleanupError) {
          result = failure({
            status: "indeterminate",
            reason: "consumer_runtime_indeterminate",
            phase: "staging",
            error: { primary: error, cleanup: cleanupError },
          });
        }
      }
      result ??= failure({
        status: phase === "admission" ? "denied" : "failed",
        reason:
          phase === "admission"
            ? (reasonFromError(error) ?? "consumer_runtime_identity_mismatch")
            : (reasonFromError(error) ?? "consumer_runtime_permission"),
        phase,
        error: primaryError,
      });
    }
  } finally {
    if (locked) {
      try {
        await ports.releaseConsumerLock();
      } catch (releaseError) {
        result = failure({
          status: "indeterminate",
          reason: "consumer_runtime_indeterminate",
          phase: "release",
          error: primaryError ? { primary: primaryError, release: releaseError } : releaseError,
        });
      }
    }
  }
  return (
    result ??
    failure({
      status: "indeterminate",
      reason: "consumer_runtime_indeterminate",
      phase,
      error: primaryError,
    })
  );
}
