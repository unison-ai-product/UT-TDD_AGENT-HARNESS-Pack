import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const projectPath = "ut-tdd.project.json";
type ObjectFormat = "sha1" | "sha256";
type RuleId =
  | "plan-repository-identity-missing"
  | "plan-project-config-invalid"
  | "plan-repository-identity-invalid"
  | "plan-repository-identity-provenance-invalid"
  | "identity_worktree_drift"
  | "identity_head_toctou"
  | "identity_noncanonical_bytes"
  | "identity_repository_unbound";
type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly ruleId: RuleId; readonly message: string } };

export interface ProjectIdentityReceipt {
  readonly path: string;
  readonly blobOid: string;
  readonly contentDigest: string;
  readonly sourceCommit: string;
  readonly objectFormat: ObjectFormat;
}

export interface TrackedProjectIdentity {
  readonly schemaVersion: "ut-tdd.project/v1";
  readonly repositoryIdentity: string;
  readonly provenance: ProjectIdentityReceipt & { readonly receiptDigest: string };
}

export function loadTrackedProjectIdentity(input: {
  bytes: Uint8Array;
  receipt: ProjectIdentityReceipt;
  expectedRepositoryIdentity?: string;
}): Result<TrackedProjectIdentity> {
  if (!validReceipt(input.bytes, input.receipt)) {
    return failed("plan-repository-identity-provenance-invalid", "HEAD blob receipt mismatch");
  }
  const decoded = decodeConfig(input.bytes);
  if (!decoded.ok) return decoded;
  if (!validIdentity(decoded.value.repository_identity)) {
    return failed("plan-repository-identity-invalid", "repository identity grammar invalid");
  }
  if (
    input.expectedRepositoryIdentity &&
    decoded.value.repository_identity !== input.expectedRepositoryIdentity
  ) {
    return failed("plan-repository-identity-missing", "expected repository identity mismatch");
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: "ut-tdd.project/v1",
      repositoryIdentity: decoded.value.repository_identity,
      provenance: Object.freeze({
        ...input.receipt,
        receiptDigest: sha256(Buffer.from(canonicalReceipt(input.receipt))),
      }),
    }),
  };
}

export function loadProjectIdentityFromHead(input: {
  repoRoot: string;
  expectedRepositoryIdentity?: string;
  /**
   * Optional observation seam used by the paired TOCTOU test. It is invoked
   * after the subject HEAD OID is resolved and before any tree/blob read. The
   * read path never uses the callback's return value or trusts its effects;
   * production callers omit it.
   */
  afterHeadResolved?: (context: { repoRoot: string; sourceCommit: string }) => void;
}): Result<TrackedProjectIdentity> {
  try {
    const repoRoot = realpathSync(input.repoRoot);
    const objectFormat = gitText(repoRoot, ["rev-parse", "--show-object-format"]).trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      return failed("plan-repository-identity-provenance-invalid", "unsupported object format");
    }
    const sourceCommit = gitText(repoRoot, ["rev-parse", "HEAD"]).trim();
    input.afterHeadResolved?.({ repoRoot, sourceCommit });
    const entry = gitText(repoRoot, ["ls-tree", sourceCommit, "--", projectPath]).trim();
    const match = new RegExp(
      `^100644 blob ([a-f0-9]{${objectFormat === "sha1" ? 40 : 64}})\\t${projectPath}$`,
    ).exec(entry);
    if (!match) return failed("plan-repository-identity-missing", "tracked HEAD config missing");
    const bytes = execFileSync("git", ["-C", repoRoot, "show", `${sourceCommit}:${projectPath}`]);
    if (gitText(repoRoot, ["rev-parse", "HEAD"]).trim() !== sourceCommit) {
      return failed("identity_head_toctou", "HEAD changed while reading project identity");
    }
    const worktreePath = join(repoRoot, projectPath);
    if (!existsSync(worktreePath)) {
      return failed("identity_worktree_drift", "tracked project identity is absent from worktree");
    }
    const stat = lstatSync(worktreePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return failed("identity_worktree_drift", "worktree project identity is not a regular file");
    }
    if (!Buffer.from(readFileSync(worktreePath)).equals(Buffer.from(bytes))) {
      return failed("identity_worktree_drift", "worktree project identity differs from HEAD blob");
    }
    const loaded = loadTrackedProjectIdentity({
      bytes,
      receipt: {
        path: projectPath,
        blobOid: match[1],
        contentDigest: sha256(bytes),
        sourceCommit,
        objectFormat,
      },
      expectedRepositoryIdentity: undefined,
    });
    if (!loaded.ok) return loaded;
    if (
      !Buffer.from(bytes).equals(
        Buffer.from(canonicalProjectIdentityBytes(loaded.value.repositoryIdentity)),
      )
    ) {
      return failed("identity_noncanonical_bytes", "project identity bytes are not canonical");
    }
    const bound = repositoryIdentityFromOrigin(repoRoot);
    if (bound && input.expectedRepositoryIdentity && bound !== input.expectedRepositoryIdentity) {
      return failed("identity_repository_unbound", "origin and expected identity disagree");
    }
    if (bound && bound !== loaded.value.repositoryIdentity) {
      return failed("identity_repository_unbound", "project identity does not match origin");
    }
    if (!bound && !input.expectedRepositoryIdentity) {
      return failed("identity_repository_unbound", "project identity has no origin binding");
    }
    if (
      input.expectedRepositoryIdentity &&
      input.expectedRepositoryIdentity !== loaded.value.repositoryIdentity
    ) {
      return failed("plan-repository-identity-missing", "expected repository identity mismatch");
    }
    return loaded;
  } catch {
    return failed("plan-repository-identity-missing", "tracked HEAD config unavailable");
  }
}

/** Canonical bytes shared by setup creation and HEAD read validation. */
export function canonicalProjectIdentityBytes(repositoryIdentity: string): Uint8Array {
  return Buffer.from(
    `${JSON.stringify(
      { schema_version: "ut-tdd.project/v1", repository_identity: repositoryIdentity },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** Normalize supported Git origin forms to a path-independent identity. */
export function repositoryIdentityFromOrigin(repoRoot: string): string | null {
  try {
    const remote = gitText(repoRoot, ["remote", "get-url", "origin"]).trim();
    if (!remote || remote.includes("\n")) return null;
    const direct = parseRepositoryIdentity(remote);
    if (direct) return direct;
    // Detached snapshot clones use a local Git repository as origin. Resolve
    // exactly one custody hop to that repository's canonical network origin;
    // never derive identity from the local path itself.
    if (existsSync(remote)) {
      const sourceRoot = realpathSync(remote);
      const sourceOrigin = gitText(sourceRoot, ["remote", "get-url", "origin"]).trim();
      return parseRepositoryIdentity(sourceOrigin);
    }
    return null;
  } catch {
    return null;
  }
}

function parseRepositoryIdentity(remote: string): string | null {
  try {
    let owner: string | undefined;
    let repository: string | undefined;
    const scp = /^[^@/:]+@[^:]+:([^/]+)\/([^/]+)$/.exec(remote);
    if (scp) {
      owner = scp[1];
      repository = scp[2];
    } else if (/^https?:\/\//i.test(remote)) {
      const url = new URL(remote);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      owner = parts[0];
      repository = parts[1];
    } else {
      return null;
    }
    if (!owner || !repository) return null;
    if (repository.endsWith(".git")) repository = repository.slice(0, -4);
    const identity = `${owner}/${repository}`;
    return validIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

function decodeConfig(bytes: Uint8Array): Result<{ repository_identity: string }> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      occurrences(text, "schema_version") !== 1 ||
      occurrences(text, "repository_identity") !== 1
    ) {
      return failed("plan-project-config-invalid", "duplicate or missing config key");
    }
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const config = value as Record<string, unknown>;
    if (
      Object.keys(config).sort().join(",") !== "repository_identity,schema_version" ||
      config.schema_version !== "ut-tdd.project/v1" ||
      typeof config.repository_identity !== "string"
    ) {
      throw new Error();
    }
    return { ok: true, value: { repository_identity: config.repository_identity } };
  } catch {
    return failed("plan-project-config-invalid", "project config is not strict v1 JSON");
  }
}

function validReceipt(bytes: Uint8Array, receipt: ProjectIdentityReceipt): boolean {
  const width = receipt.objectFormat === "sha1" ? 40 : 64;
  return (
    receipt.path === projectPath &&
    new RegExp(`^[a-f0-9]{${width}}$`).test(receipt.sourceCommit) &&
    receipt.blobOid === gitBlobOid(bytes, receipt.objectFormat) &&
    receipt.contentDigest === sha256(bytes)
  );
}

function validIdentity(value: string): boolean {
  return (
    value === value.trim() &&
    value === value.normalize("NFC") &&
    !value.endsWith(".git") &&
    /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(value)
  );
}

function gitBlobOid(bytes: Uint8Array, format: ObjectFormat): string {
  return createHash(format)
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");
}

function canonicalReceipt(receipt: ProjectIdentityReceipt): string {
  return JSON.stringify([
    receipt.path,
    receipt.objectFormat,
    receipt.sourceCommit,
    receipt.blobOid,
    receipt.contentDigest,
  ]);
}

function occurrences(text: string, key: string): number {
  return text.match(new RegExp(`"${key}"\\s*:`, "g"))?.length ?? 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function failed(ruleId: RuleId, message: string): Result<never> {
  return { ok: false, error: { ruleId, message } };
}
