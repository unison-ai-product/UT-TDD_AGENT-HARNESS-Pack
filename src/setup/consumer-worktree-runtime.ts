import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ConsumerNodeRuntimeIdentity,
  digestConsumerRuntimeBytes,
  validateConsumerNodeRuntimeBundle,
} from "./consumer-node-runtime.ts";
import type { ConsumerRuntimeReleaseInstallResult } from "./consumer-runtime-contracts.ts";
import { verifyConsumerRuntimeReleaseAssets } from "./consumer-runtime-release.ts";
import type { ConsumerWorktreeSetupFault } from "./consumer-runtime-transaction.ts";
import { releaseArtifactFileNames } from "./distribution.ts";

const RELEASE_ID = /^rel-sha256:([a-f0-9]{64})$/;

export type ConsumerWorktreeRuntimeErrorCode =
  | "worktree_entry_not_linked"
  | "worktree_entry_main_not_activated"
  | "worktree_entry_cache_missing"
  | "worktree_entry_pin_mismatch";

export class ConsumerWorktreeRuntimeError extends Error {
  readonly code: ConsumerWorktreeRuntimeErrorCode;

  constructor(code: ConsumerWorktreeRuntimeErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "ConsumerWorktreeRuntimeError";
    this.code = code;
  }
}

export interface ConsumerRuntimePin {
  readonly release_id: string;
  readonly artifact_set_digest: string;
  readonly compiled_esm_digest: string;
  readonly entry_path: string;
}

export function createConsumerRuntimePin(input: {
  readonly releaseId: string;
  readonly artifactSetDigest: string;
  readonly compiledEsmDigest: string;
  readonly entryPath: string;
}): ConsumerRuntimePin {
  return {
    release_id: input.releaseId,
    artifact_set_digest: input.artifactSetDigest,
    compiled_esm_digest: input.compiledEsmDigest,
    entry_path: input.entryPath,
  };
}

export function assertConsumerRuntimePinMatches(input: {
  readonly expectedPin: ConsumerRuntimePin | undefined;
  readonly releaseId: string;
  readonly artifactSetDigest: string;
  readonly compiledEsmDigest: string;
}): void {
  if (
    input.expectedPin &&
    (input.releaseId !== input.expectedPin.release_id ||
      input.artifactSetDigest !== input.expectedPin.artifact_set_digest ||
      input.compiledEsmDigest !== input.expectedPin.compiled_esm_digest)
  )
    throw new ConsumerWorktreeRuntimeError("worktree_entry_pin_mismatch");
}

export interface ConsumerWorktreeContext {
  readonly worktreeRoot: string;
  readonly mainRoot: string;
  readonly commonDir: string;
}

interface GitDirectoryContext {
  readonly gitDir: string;
  readonly commonDir: string;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function gitDirectoryContext(root: string): GitDirectoryContext {
  try {
    const gitDirText = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    const commonDirText = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return {
      gitDir: realpathSync.native(resolve(root, gitDirText)),
      commonDir: realpathSync.native(resolve(root, commonDirText)),
    };
  } catch {
    throw new ConsumerWorktreeRuntimeError("worktree_entry_not_linked");
  }
}

function gitTopLevel(root: string): string {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return realpathSync.native(resolve(root, topLevel));
  } catch {
    throw new ConsumerWorktreeRuntimeError("worktree_entry_not_linked");
  }
}

export function resolveConsumerWorktreeContext(
  currentRoot: string,
  worktreePath: string,
): ConsumerWorktreeContext {
  if (!isAbsolute(worktreePath))
    throw new ConsumerWorktreeRuntimeError("worktree_entry_not_linked");

  let current: string;
  let target: string;
  try {
    current = realpathSync.native(currentRoot);
    target = realpathSync.native(worktreePath);
  } catch {
    throw new ConsumerWorktreeRuntimeError("worktree_entry_not_linked");
  }

  const currentGit = gitDirectoryContext(current);
  const targetGit = gitDirectoryContext(target);
  if (
    !samePath(gitTopLevel(target), target) ||
    samePath(targetGit.gitDir, targetGit.commonDir) ||
    !samePath(currentGit.commonDir, targetGit.commonDir)
  )
    throw new ConsumerWorktreeRuntimeError("worktree_entry_not_linked");

  const mainRoot = dirname(targetGit.commonDir);
  try {
    if (!samePath(realpathSync.native(join(mainRoot, ".git")), targetGit.commonDir))
      throw new Error("common directory is not the main worktree .git directory");
  } catch {
    throw new ConsumerWorktreeRuntimeError("worktree_entry_not_linked");
  }

  return { worktreeRoot: target, mainRoot, commonDir: targetGit.commonDir };
}

export function mainWorktreeCommonDir(root: string): string | null {
  try {
    const resolvedRoot = realpathSync.native(root);
    const context = gitDirectoryContext(resolvedRoot);
    return samePath(context.gitDir, context.commonDir) ? context.commonDir : null;
  } catch {
    return null;
  }
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export function readMainConsumerRuntimePin(mainRoot: string): ConsumerRuntimePin {
  const root = resolve(mainRoot);
  const runtimeRoot = join(root, ".ut-tdd", "runtime");
  const pointerPath = join(runtimeRoot, "activation", "active.json");
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
    if (
      Object.keys(pointer).sort().join("\0") !== "bundle_digest\0bundle_path\0entry_path" ||
      typeof pointer.bundle_digest !== "string" ||
      typeof pointer.bundle_path !== "string" ||
      typeof pointer.entry_path !== "string" ||
      pointer.bundle_path !== resolve(pointer.bundle_path) ||
      pointer.entry_path !== resolve(pointer.entry_path) ||
      !contained(runtimeRoot, pointer.bundle_path)
    )
      throw new Error("invalid active pointer");

    const bundle = JSON.parse(
      readFileSync(join(pointer.bundle_path, "bundle-manifest.json"), "utf8"),
    ) as {
      identity?: ConsumerNodeRuntimeIdentity;
      bundle_digest?: unknown;
      bundle_path?: unknown;
      files?: Record<string, unknown>;
    };
    const runtimeReal = realpathSync.native(runtimeRoot);
    const bundleReal = realpathSync.native(pointer.bundle_path);
    const entryReal = realpathSync.native(pointer.entry_path);
    if (
      validateConsumerNodeRuntimeBundle(bundle) ||
      bundle.bundle_digest !== pointer.bundle_digest ||
      bundle.bundle_path !== pointer.bundle_path ||
      !samePath(pointer.entry_path, join(pointer.bundle_path, "ut-tdd.mjs")) ||
      !contained(runtimeReal, bundleReal) ||
      !contained(bundleReal, entryReal) ||
      !bundle.identity ||
      !samePath(bundle.identity.consumer_root, root) ||
      !samePath(bundle.identity.runtime_root, runtimeRoot) ||
      !bundle.files
    )
      throw new Error("invalid active bundle");

    for (const [name, expected] of Object.entries(bundle.files)) {
      if (typeof expected !== "string") throw new Error("invalid bundle file digest");
      const bytes = readFileSync(join(pointer.bundle_path, name));
      if (digestConsumerRuntimeBytes(bytes) !== expected)
        throw new Error("bundle file digest mismatch");
    }

    const { release_id, artifact_set_digest, compiled_esm_digest } = bundle.identity;
    if (!RELEASE_ID.test(release_id)) throw new Error("invalid release id");
    return {
      release_id,
      artifact_set_digest,
      compiled_esm_digest,
      entry_path: pointer.entry_path,
    };
  } catch {
    throw new ConsumerWorktreeRuntimeError(
      "worktree_entry_main_not_activated",
      "main runtime is missing or invalid; run setup in the main worktree first",
    );
  }
}

export function consumerRuntimeCachePath(commonDir: string, releaseId: string): string {
  const match = RELEASE_ID.exec(releaseId);
  if (!match) throw new ConsumerWorktreeRuntimeError("worktree_entry_main_not_activated");
  return join(commonDir, "ut-tdd", "runtime-cache", match[1]);
}

export function inferConsumerRuntimeReleaseTag(releaseDirectory: string): string {
  try {
    const runtimeFiles = readdirSync(releaseDirectory).filter((name) =>
      name.endsWith(".consumer-runtime.json"),
    );
    if (runtimeFiles.length !== 1) throw new Error("consumer runtime descriptor is ambiguous");
    const fileName = runtimeFiles[0];
    if (!fileName) throw new Error("consumer runtime descriptor is missing");
    const parsed = JSON.parse(readFileSync(join(releaseDirectory, fileName), "utf8")) as {
      release?: { tag?: unknown };
    };
    const tag = parsed.release?.tag;
    if (
      typeof tag !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag) ||
      releaseArtifactFileNames(tag).consumerRuntime !== fileName
    )
      throw new Error("consumer runtime descriptor tag is invalid");
    return tag;
  } catch {
    throw new ConsumerWorktreeRuntimeError("worktree_entry_pin_mismatch");
  }
}

function checksumAnchor(releaseDirectory: string, tag: string): string {
  try {
    const checksum = readFileSync(
      join(releaseDirectory, releaseArtifactFileNames(tag).consumerChecksum),
    );
    return `sha256:${createHash("sha256").update(checksum).digest("hex")}`;
  } catch {
    throw new ConsumerWorktreeRuntimeError("worktree_entry_pin_mismatch");
  }
}

export function cachedConsumerRuntimeAnchor(releaseDirectory: string): string {
  return checksumAnchor(releaseDirectory, inferConsumerRuntimeReleaseTag(releaseDirectory));
}

export function ensureConsumerRuntimeReleaseCached(input: {
  readonly commonDir: string;
  readonly releaseDirectory: string;
  readonly releaseId: string;
  readonly tag: string;
  readonly expectedConsumerDigest: string;
  readonly executingModulePath: string;
  readonly expectedPin: ConsumerRuntimePin;
}): boolean {
  const target = consumerRuntimeCachePath(input.commonDir, input.releaseId);
  const parent = dirname(target);
  const verify = (directory: string, anchor: string): void => {
    const assets = verifyConsumerRuntimeReleaseAssets({
      releaseDirectory: directory,
      tag: input.tag,
      expectedConsumerDigest: anchor,
      executingModulePath: input.executingModulePath,
    });
    if (
      assets.document.admission_input.aggregate_input.attestation.releaseId !== input.releaseId ||
      assets.document.admission_input.aggregate_input.attestation.releaseId !==
        input.expectedPin.release_id ||
      assets.document.generation.artifact_digest !== input.expectedPin.artifact_set_digest ||
      assets.document.generation.compiled_esm_digest !== input.expectedPin.compiled_esm_digest
    )
      throw new ConsumerWorktreeRuntimeError("worktree_entry_pin_mismatch");
  };

  const existingTarget = lstatIfPresent(target);
  if (existingTarget) {
    if (!existingTarget.isDirectory())
      throw new ConsumerWorktreeRuntimeError("worktree_entry_pin_mismatch");
    verify(target, input.expectedConsumerDigest);
    return false;
  }

  const utTddDirectory = join(input.commonDir, "ut-tdd");
  const utTddDirectoryExisted = lstatIfPresent(utTddDirectory) !== null;
  const parentExisted = existsSync(parent);
  for (const ancestor of [utTddDirectory, parent]) {
    const stat = lstatIfPresent(ancestor);
    if (stat && !stat.isDirectory())
      throw new ConsumerWorktreeRuntimeError("worktree_entry_pin_mismatch");
  }
  let stage: string | null = null;
  try {
    mkdirSync(parent, { recursive: true });
    stage = mkdtempSync(join(parent, `.stage-${basename(target)}-`));
    const names = Object.values(releaseArtifactFileNames(input.tag));
    for (const name of names) copyFileSync(join(input.releaseDirectory, name), join(stage, name));
    verify(stage, input.expectedConsumerDigest);
    try {
      renameSync(stage, target);
      return true;
    } catch (error) {
      const racedTarget = lstatIfPresent(target);
      if (!racedTarget?.isDirectory()) throw error;
      verify(target, input.expectedConsumerDigest);
      rmSync(stage, { recursive: true, force: false });
      return false;
    }
  } catch (error) {
    if (stage && existsSync(stage)) rmSync(stage, { recursive: true, force: false });
    if (!parentExisted) {
      try {
        rmdirSync(parent);
      } catch {
        // Another writer may have committed a cache entry after our check.
      }
    }
    if (!utTddDirectoryExisted) {
      try {
        if (readdirSync(utTddDirectory).length === 0) rmdirSync(utTddDirectory);
      } catch {
        // Preserve non-empty or concurrently created runtime-cache state.
      }
    }
    throw error;
  }
}

export function cacheConsumerRuntimeRelease(input: {
  readonly commonDir: string;
  readonly releaseDirectory: string;
  readonly releaseId: string;
  readonly tag: string;
  readonly expectedConsumerDigest: string;
  readonly executingModulePath: string;
  readonly expectedPin: ConsumerRuntimePin;
}): { readonly cacheCreated?: true; readonly cacheWarning?: string } {
  try {
    const cacheCreated = ensureConsumerRuntimeReleaseCached(input);
    return cacheCreated ? { cacheCreated: true } : {};
  } catch (error) {
    return {
      cacheWarning:
        `warning: verified worktree runtime cache could not be prepared (${String(error)}); ` +
        "use --consumer-runtime-release and --expected-consumer-digest with setup --worktree.",
    };
  }
}

export function requireConsumerRuntimeReleaseCache(cacheDirectory: string): void {
  try {
    if (!lstatSync(cacheDirectory).isDirectory())
      throw new ConsumerWorktreeRuntimeError("worktree_entry_pin_mismatch");
  } catch (error) {
    if (error instanceof ConsumerWorktreeRuntimeError) throw error;
    throw new ConsumerWorktreeRuntimeError("worktree_entry_cache_missing");
  }
}

export async function setupConsumerWorktreeRuntime(
  input: {
    readonly currentRoot: string;
    readonly worktreePath: string;
    readonly releaseDirectory?: string;
    readonly expectedConsumerDigest?: string;
    readonly fault?: ConsumerWorktreeSetupFault;
  },
  installRuntime: (input: {
    readonly releaseDirectory: string;
    readonly expectedConsumerDigest: string;
    readonly consumerRoot: string;
    readonly tag: string;
    readonly executingModulePath: string;
    readonly expectedPin: ConsumerRuntimePin;
    readonly runtimeOnly: true;
    readonly fault?: ConsumerWorktreeSetupFault;
  }) => Promise<ConsumerRuntimeReleaseInstallResult>,
): Promise<{
  readonly status: "installed" | "already-installed";
  readonly tag: string;
  readonly identity: ConsumerRuntimePin;
}> {
  const hasExplicitRelease = input.releaseDirectory !== undefined;
  if (hasExplicitRelease !== (input.expectedConsumerDigest !== undefined))
    throw new Error("consumer_runtime_anchor_mismatch");

  const context = resolveConsumerWorktreeContext(input.currentRoot, input.worktreePath);
  const pin = readMainConsumerRuntimePin(context.mainRoot);
  let releaseDirectory: string;
  let expectedConsumerDigest: string;
  if (hasExplicitRelease) {
    releaseDirectory = input.releaseDirectory as string;
    expectedConsumerDigest = input.expectedConsumerDigest as string;
  } else {
    releaseDirectory = consumerRuntimeCachePath(context.commonDir, pin.release_id);
    requireConsumerRuntimeReleaseCache(releaseDirectory);
    expectedConsumerDigest = cachedConsumerRuntimeAnchor(releaseDirectory);
  }
  const tag = inferConsumerRuntimeReleaseTag(releaseDirectory);
  const result = await installRuntime({
    releaseDirectory,
    expectedConsumerDigest,
    consumerRoot: context.worktreeRoot,
    tag,
    executingModulePath: pin.entry_path,
    expectedPin: pin,
    runtimeOnly: true,
    ...(input.fault ? { fault: input.fault } : {}),
  });
  return { status: result.status, tag, identity: pin };
}
