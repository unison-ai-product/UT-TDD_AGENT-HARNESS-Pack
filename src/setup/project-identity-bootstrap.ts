import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalProjectIdentityBytes,
  loadProjectIdentityFromHead,
  repositoryIdentityFromOrigin,
} from "../plan-asset/adapters/project-identity-loader.ts";

export { canonicalProjectIdentityBytes, repositoryIdentityFromOrigin };

export const PROJECT_IDENTITY_PATH = "ut-tdd.project.json";

export type ProjectIdentityBootstrapRuleId =
  | "identity_repository_unbound"
  | "identity_stale_worktree"
  | "identity_write_failed"
  | "plan-repository-identity-missing"
  | "plan-project-config-invalid"
  | "plan-repository-identity-invalid"
  | "plan-repository-identity-provenance-invalid"
  | "identity_worktree_drift"
  | "identity_head_toctou"
  | "identity_noncanonical_bytes";

export type ProjectIdentityBootstrapResult =
  | {
      readonly ok: true;
      readonly repositoryIdentity: string;
      readonly path: string;
      readonly created: boolean;
      /** True until the caller explicitly commits the generated worktree file. */
      readonly commitRequired: boolean;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly ruleId: ProjectIdentityBootstrapRuleId;
        readonly message: string;
      };
    };

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Create the tracked identity in setup's working tree, or verify an existing
 * HEAD identity. This function deliberately has no git commit operation.
 */
export function bootstrapProjectIdentity(repoRoot: string): ProjectIdentityBootstrapResult {
  let root: string;
  try {
    root = realpathSync(repoRoot);
  } catch {
    return fail("identity_repository_unbound", "repository root is unavailable");
  }

  const identityPath = join(root, PROJECT_IDENTITY_PATH);
  let hasTrackedEntry = false;
  try {
    hasTrackedEntry = gitText(root, ["ls-tree", "HEAD", "--", PROJECT_IDENTITY_PATH]).trim() !== "";
  } catch {
    // An unborn HEAD has no tracked identity and may be bootstrapped from origin.
  }

  if (hasTrackedEntry) {
    const loaded = loadProjectIdentityFromHead({ repoRoot: root });
    if (!loaded.ok) return loaded;
    return {
      ok: true,
      repositoryIdentity: loaded.value.repositoryIdentity,
      path: PROJECT_IDENTITY_PATH,
      created: false,
      commitRequired: false,
    };
  }

  const repositoryIdentity = repositoryIdentityFromOrigin(root);
  if (!repositoryIdentity) {
    return fail("identity_repository_unbound", "origin remote is missing or invalid");
  }
  const bytes = canonicalProjectIdentityBytes(repositoryIdentity);

  try {
    if (existsSync(identityPath)) {
      const stat = lstatSync(identityPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return fail("identity_stale_worktree", "existing project identity is not a regular file");
      }
      if (!Buffer.from(readFileSync(identityPath)).equals(Buffer.from(bytes))) {
        return fail("identity_stale_worktree", "existing untracked identity does not match origin");
      }
      return {
        ok: true,
        repositoryIdentity,
        path: PROJECT_IDENTITY_PATH,
        created: false,
        commitRequired: true,
      };
    }
    // setup owns this write; no commit, add, or other history mutation is made.
    writeFileSync(identityPath, bytes);
    return {
      ok: true,
      repositoryIdentity,
      path: PROJECT_IDENTITY_PATH,
      created: true,
      commitRequired: true,
    };
  } catch {
    return fail("identity_write_failed", "project identity could not be written");
  }
}

function fail(
  ruleId: ProjectIdentityBootstrapRuleId,
  message: string,
): ProjectIdentityBootstrapResult {
  return { ok: false, error: { ruleId, message } };
}
