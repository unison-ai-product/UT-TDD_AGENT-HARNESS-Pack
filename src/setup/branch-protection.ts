import { join } from "node:path";

export type GhRunner = (args: string[]) => { ok: boolean; stdout: string };
export type Confirm = (message: string) => boolean;

export interface BranchProtectionActionPlan {
  actions: { kind: string }[];
}

export interface BranchProtectionDeps {
  repoRoot: string;
  gh: GhRunner;
  writeText: (path: string, content: string) => void;
  confirm: Confirm;
  isInteractive: boolean;
}

export interface BranchProtectionResult {
  applied: boolean;
  reason: string;
}

const BP_PAYLOAD_PATH = join(".ut-tdd", "tmp", "branch-protection.json");

export function buildBranchProtectionPayload(): {
  required_status_checks: { strict: boolean; checks: { context: string }[] };
  enforce_admins: boolean;
  required_pull_request_reviews: { required_approving_review_count: number };
  restrictions: null;
} {
  return {
    required_status_checks: { strict: true, checks: [{ context: "harness-check" }] },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 1 },
    restrictions: null,
  };
}

export function branchProtectionPayloadPath(repoRoot: string): string {
  return join(repoRoot, BP_PAYLOAD_PATH);
}

export function applyBranchProtection(
  plan: BranchProtectionActionPlan,
  deps: BranchProtectionDeps,
  opts: { apply: boolean },
): BranchProtectionResult {
  if (opts.apply !== true) return { applied: false, reason: "emit-only" };
  if (deps.isInteractive !== true) return { applied: false, reason: "non-interactive" };
  const action = plan.actions.find((a) => a.kind === "branch-protection");
  if (!action) return { applied: false, reason: "no-action" };
  if (!deps.gh(["auth", "status"]).ok) return { applied: false, reason: "not-authenticated" };
  const repo = deps.gh(["api", "repos/{owner}/{repo}"]);
  let admin = false;
  try {
    admin =
      (JSON.parse(repo.stdout) as { permissions?: { admin?: boolean } })?.permissions?.admin ===
      true;
  } catch {
    admin = false;
  }
  if (!repo.ok || !admin) return { applied: false, reason: "not-admin" };
  if (
    !deps.confirm(
      "main の branch protection を適用します (本番 merge ゲート変更)。よろしいですか？",
    )
  ) {
    return { applied: false, reason: "declined" };
  }

  const payloadPath = branchProtectionPayloadPath(deps.repoRoot);
  deps.writeText(payloadPath, `${JSON.stringify(buildBranchProtectionPayload(), null, 2)}\n`);
  const r = deps.gh([
    "api",
    "-X",
    "PUT",
    "repos/{owner}/{repo}/branches/main/protection",
    "-H",
    "Accept: application/vnd.github+json",
    "--input",
    payloadPath,
  ]);
  return r.ok ? { applied: true, reason: "applied" } : { applied: false, reason: "gh-failed" };
}
