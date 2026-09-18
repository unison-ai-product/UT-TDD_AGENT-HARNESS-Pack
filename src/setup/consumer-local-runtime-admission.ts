import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { deriveReleaseId, parsePublicationManifest } from "../schema/release-manifest.ts";
import { digestConsumerRuntimeBytes } from "./consumer-node-runtime.ts";
import { deriveControlManifestSnapshotDigest } from "./pack-publication-staging.ts";
import {
  applySealedReleaseAggregate,
  type ReleaseAggregateApplyDependencies,
  type ReleaseAggregateApplyResult,
  type SealedReleaseAggregatePlan,
} from "./release-aggregate-admission.ts";
import {
  digestMaterializedReleaseEntries,
  type MaterializedReleaseEntry,
} from "./release-materializer.ts";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RELEASE_ID = /^rel-sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const MODES = new Set(["100644", "100755", "120000"]);
const admittedCapabilities = new WeakSet<object>();

export interface ConsumerArtifactIdentity {
  readonly materializerVersion: string;
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly artifactSetDigest: string;
}

export interface ConsumerReceipt extends ConsumerArtifactIdentity {
  readonly productId: string;
  readonly consumerRoot: string;
  readonly runtimeRoot: string;
}

export interface ConsumerLocalRuntimeAdmissionInput {
  readonly productId: string;
  readonly consumerRoot: string;
  readonly runtimeRoot: string;
  readonly plan: SealedReleaseAggregatePlan;
  readonly manifest: ConsumerArtifactIdentity;
  readonly receipt: ConsumerReceipt;
  readonly controlManifestBytes: Uint8Array;
}

export interface ConsumerLocalRuntimeAdmission {
  readonly productId: string;
  readonly consumerRoot: string;
  readonly runtimeRoot: string;
  readonly identity: ConsumerArtifactIdentity;
  readonly controlManifestSnapshotDigest: string;
  readonly plan: SealedReleaseAggregatePlan;
  readonly layout: ConsumerRuntimeLayout;
}

export interface ConsumerRuntimeLayout {
  readonly configuration: string;
  readonly database: string;
  readonly memory: string;
  readonly planProjection: string;
  readonly lock: string;
  readonly hookState: string;
  readonly receipt: string;
  readonly evidence: string;
  readonly history: string;
}

export type ConsumerLocalRuntimeAdmissionError =
  | "artifact_unavailable"
  | "invalid_artifact"
  | "identity_mismatch"
  | "namespace_escape"
  | "unknown_version"
  | "receipt_mismatch";

export type ConsumerLocalRuntimeAdmissionResult =
  | { readonly ok: true; readonly admission: ConsumerLocalRuntimeAdmission }
  | { readonly ok: false; readonly error: ConsumerLocalRuntimeAdmissionError };

/** Same-process capability check; structurally matching JSON is not admission. */
export function isConsumerLocalRuntimeAdmission(
  value: unknown,
): value is ConsumerLocalRuntimeAdmission {
  return isRecord(value) && admittedCapabilities.has(value);
}

export type ConsumerLocalRuntimeInstallResult =
  | {
      readonly ok: true;
      readonly admission: ConsumerLocalRuntimeAdmission;
      readonly applied: 1;
    }
  | {
      readonly ok: false;
      readonly phase: "admission";
      readonly error: ConsumerLocalRuntimeAdmissionError;
    }
  | {
      readonly ok: false;
      readonly phase: "apply";
      readonly error: "unavailable" | "rollback_failed";
      readonly applied: 0 | "indeterminate";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function validSymlink(destination: string, content: Uint8Array): boolean {
  let target: string;
  try {
    target = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return false;
  }
  if (
    target.length === 0 ||
    target.includes("\0") ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[A-Za-z]:/.test(target) ||
    target.startsWith("\\\\")
  )
    return false;
  const targetPath = posix.normalize(posix.join(posix.dirname(destination), target));
  return targetPath !== ".." && !targetPath.startsWith("../") && !posix.isAbsolute(targetPath);
}

function samePath(left: string, right: string): boolean {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  if (a === null || b === null) return false;

  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(parent: string, child: string): boolean {
  const parentCanonical = canonicalPath(parent);
  const childCanonical = canonicalPath(child);
  if (parentCanonical === null || childCanonical === null) return false;
  const rel = relative(parentCanonical, childCanonical);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${requirementSeparator()}`) && !isAbsolute(rel))
  );
}

/** Existing symlink/junction ancestors are resolved even when the final runtime directory is new. */
function canonicalPath(path: string): string | null {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    suffix.unshift(basename(current));
    current = parent;
  }
  try {
    return resolve(realpathSync.native(current), ...suffix);
  } catch {
    return null;
  }
}

function requirementSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function deriveLayout(runtimeRoot: string): ConsumerRuntimeLayout {
  return Object.freeze({
    configuration: resolve(runtimeRoot, "config.json"),
    database: resolve(runtimeRoot, "harness.db"),
    memory: resolve(runtimeRoot, "memory"),
    planProjection: resolve(runtimeRoot, "plans"),
    lock: resolve(runtimeRoot, "runtime.lock"),
    hookState: resolve(runtimeRoot, "hooks"),
    receipt: resolve(runtimeRoot, "receipt.json"),
    evidence: resolve(runtimeRoot, "evidence"),
    history: resolve(runtimeRoot, "history"),
  });
}

function validIdentity(value: unknown): value is ConsumerArtifactIdentity {
  return (
    isRecord(value) &&
    typeof value.materializerVersion === "string" &&
    value.materializerVersion.length > 0 &&
    typeof value.releaseId === "string" &&
    RELEASE_ID.test(value.releaseId) &&
    typeof value.sourceRevision === "string" &&
    REVISION.test(value.sourceRevision) &&
    typeof value.artifactSetDigest === "string" &&
    SHA256.test(value.artifactSetDigest)
  );
}

function validReceipt(value: unknown): value is ConsumerReceipt {
  return (
    isRecord(value) &&
    validIdentity(value) &&
    typeof value.productId === "string" &&
    typeof value.consumerRoot === "string" &&
    typeof value.runtimeRoot === "string"
  );
}

function validPlan(plan: unknown): plan is SealedReleaseAggregatePlan {
  return (
    isRecord(plan) &&
    plan.kind === "release-aggregate" &&
    typeof plan.channel === "string" &&
    typeof plan.releaseId === "string" &&
    RELEASE_ID.test(plan.releaseId) &&
    typeof plan.sourceRevision === "string" &&
    REVISION.test(plan.sourceRevision) &&
    typeof plan.destinationPath === "string" &&
    validPath(plan.destinationPath) &&
    typeof plan.expectedDigest === "string" &&
    SHA256.test(plan.expectedDigest) &&
    typeof plan.actualDigest === "string" &&
    SHA256.test(plan.actualDigest) &&
    Array.isArray(plan.entries)
  );
}

function copyEntries(plan: SealedReleaseAggregatePlan): readonly MaterializedReleaseEntry[] | null {
  const entries: MaterializedReleaseEntry[] = [];
  const paths = new Set<string>();
  for (const candidate of plan.entries) {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || !validPath(candidate.path))
      return null;
    if (paths.has(candidate.path) || !MODES.has(candidate.mode)) return null;
    if (!(candidate.content instanceof Uint8Array)) return null;
    if (candidate.mode === "120000" && !validSymlink(candidate.path, candidate.content))
      return null;
    paths.add(candidate.path);
    const snapshot = new Uint8Array(candidate.content);
    entries.push(
      Object.freeze({
        path: candidate.path,
        mode: candidate.mode,
        get content(): Uint8Array {
          return new Uint8Array(snapshot);
        },
      }),
    );
  }
  if (entries.length === 0) return null;
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  return Object.freeze(entries);
}

function admitControlManifest(input: {
  readonly bytes: Uint8Array;
  readonly plan: SealedReleaseAggregatePlan;
}): string | null {
  try {
    const parsed = parsePublicationManifest(parseYaml(Buffer.from(input.bytes).toString("utf8")));
    if (!parsed.ok) return null;
    const release = parsed.value.releases[input.plan.releaseId];
    if (
      !release ||
      release.materializerVersion !== "1" ||
      release.artifactSourceCommit !== input.plan.sourceRevision ||
      release.artifactSetDigest !== input.plan.expectedDigest ||
      release.artifacts.length !== input.plan.entries.length
    )
      return null;
    for (const [index, artifact] of release.artifacts.entries()) {
      const entry = input.plan.entries[index];
      if (
        !entry ||
        artifact.destinationPath !== entry.path ||
        artifact.mode !== entry.mode ||
        artifact.size !== entry.content.length ||
        artifact.contentDigest !== digestConsumerRuntimeBytes(entry.content)
      )
        return null;
    }
    return deriveControlManifestSnapshotDigest(parsed.value);
  } catch {
    return null;
  }
}

export function admitConsumerLocalRuntime(
  input: ConsumerLocalRuntimeAdmissionInput,
): ConsumerLocalRuntimeAdmissionResult {
  if (
    !isRecord(input) ||
    typeof input.productId !== "string" ||
    input.productId.length === 0 ||
    typeof input.consumerRoot !== "string" ||
    typeof input.runtimeRoot !== "string"
  ) {
    return { ok: false, error: "invalid_artifact" };
  }
  if (
    !isAbsolute(input.consumerRoot) ||
    !isAbsolute(input.runtimeRoot) ||
    !within(input.consumerRoot, input.runtimeRoot)
  ) {
    return { ok: false, error: "namespace_escape" };
  }
  const canonicalConsumerRoot = canonicalPath(input.consumerRoot);
  const canonicalRuntimeRoot = canonicalPath(input.runtimeRoot);
  if (canonicalConsumerRoot === null || canonicalRuntimeRoot === null) {
    return { ok: false, error: "namespace_escape" };
  }
  if (!within(canonicalConsumerRoot, canonicalRuntimeRoot)) {
    return { ok: false, error: "namespace_escape" };
  }
  if (!validPlan(input.plan)) return { ok: false, error: "artifact_unavailable" };
  if (!(input.controlManifestBytes instanceof Uint8Array))
    return { ok: false, error: "artifact_unavailable" };
  if (!validIdentity(input.manifest) || !validReceipt(input.receipt))
    return { ok: false, error: "identity_mismatch" };
  if (input.manifest.materializerVersion !== "1" || input.receipt.materializerVersion !== "1") {
    return { ok: false, error: "unknown_version" };
  }
  if (input.receipt.productId !== input.productId) {
    return { ok: false, error: "identity_mismatch" };
  }
  if (
    !samePath(input.receipt.consumerRoot, input.consumerRoot) ||
    !samePath(input.receipt.runtimeRoot, input.runtimeRoot)
  ) {
    return { ok: false, error: "receipt_mismatch" };
  }
  if (input.plan.entries.length === 0) return { ok: false, error: "artifact_unavailable" };
  const entries = copyEntries(input.plan);
  if (!entries) return { ok: false, error: "namespace_escape" };
  const computedDigest = digestMaterializedReleaseEntries(entries);
  const planIdentityMatches =
    input.plan.expectedDigest === input.plan.actualDigest &&
    input.plan.releaseId === input.manifest.releaseId &&
    input.plan.sourceRevision === input.manifest.sourceRevision &&
    input.plan.expectedDigest === input.manifest.artifactSetDigest &&
    input.plan.actualDigest === input.receipt.artifactSetDigest &&
    computedDigest === input.manifest.artifactSetDigest &&
    deriveReleaseId(
      input.manifest.materializerVersion,
      input.manifest.sourceRevision,
      input.manifest.artifactSetDigest,
    ) === input.manifest.releaseId &&
    input.manifest.releaseId === input.receipt.releaseId &&
    input.manifest.sourceRevision === input.receipt.sourceRevision;
  if (!planIdentityMatches) return { ok: false, error: "identity_mismatch" };
  const controlManifestSnapshotDigest = admitControlManifest({
    bytes: input.controlManifestBytes,
    plan: input.plan,
  });
  if (!controlManifestSnapshotDigest) return { ok: false, error: "identity_mismatch" };
  const sealedPlan = Object.freeze({ ...input.plan, entries });
  const consumerRoot = canonicalConsumerRoot;
  const runtimeRoot = canonicalRuntimeRoot;
  const layout = deriveLayout(runtimeRoot);
  if (Object.values(layout).some((path) => !within(consumerRoot, path))) {
    return { ok: false, error: "namespace_escape" };
  }
  const admission = Object.freeze({
    productId: input.productId,
    consumerRoot,
    runtimeRoot,
    identity: Object.freeze({ ...input.manifest }),
    controlManifestSnapshotDigest,
    plan: sealedPlan,
    layout,
  });
  admittedCapabilities.add(admission);
  return {
    ok: true,
    admission,
  };
}

export async function applyConsumerLocalRuntime<TStage>(
  admission: ConsumerLocalRuntimeAdmission,
  dependencies: ReleaseAggregateApplyDependencies<TStage>,
): Promise<ReleaseAggregateApplyResult> {
  return applySealedReleaseAggregate(admission.plan, dependencies);
}

/** AdmissionとPF5 applyを結合する境界。deny時はportを一つも呼ばない。 */
export async function installConsumerLocalRuntime<TStage>(
  input: ConsumerLocalRuntimeAdmissionInput,
  dependencies: ReleaseAggregateApplyDependencies<TStage>,
): Promise<ConsumerLocalRuntimeInstallResult> {
  const admission = admitConsumerLocalRuntime(input);
  if (!admission.ok) return { ...admission, phase: "admission" };
  const applied = await applyConsumerLocalRuntime(admission.admission, dependencies);
  if (!applied.ok) return { ...applied, phase: "apply" };
  return {
    ok: true,
    admission: admission.admission,
    applied: 1,
  };
}
