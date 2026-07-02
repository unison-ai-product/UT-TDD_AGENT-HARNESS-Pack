export type GithubOpsGuardCode =
  | "poc-no-main-merge"
  | "hotfix-postmortem-missing"
  | "commitlint-invalid";

export interface GithubOpsGuardFinding {
  code: GithubOpsGuardCode;
  severity: "error";
  message: string;
  evidence: string;
}

export interface GithubOpsGuardInput {
  headRef: string;
  baseRef: string;
  prTitle?: string;
  prBody?: string;
  commitSubjects?: string[];
}

export interface GithubOpsGuardResult {
  ok: boolean;
  headRef: string;
  baseRef: string;
  branchType: string;
  findings: GithubOpsGuardFinding[];
}

export interface ReleasePublicationPlan {
  ok: boolean;
  tag: string;
  repo: string;
  dryRun: boolean;
  commands: string[];
  externalPublishRequiresApproval: true;
}

const CONVENTIONAL_COMMIT_RE =
  /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9._-]+\))?!?: .{1,200}$/;

export function normalizeBranchRef(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^remotes\//, "")
    .replace(/^origin\//, "");
}

function branchType(ref: string): string {
  return normalizeBranchRef(ref).split("/", 1)[0] || "none";
}

function hasPostmortem(text: string): boolean {
  return /(?:^|\n)#{1,3}\s*postmortem\b/i.test(text) || /\bpostmortem\b/i.test(text);
}

export function evaluateGithubOpsGuard(input: GithubOpsGuardInput): GithubOpsGuardResult {
  const headRef = input.headRef.trim();
  const baseRef = input.baseRef.trim();
  const normalizedBaseRef = normalizeBranchRef(baseRef);
  const type = branchType(headRef);
  const findings: GithubOpsGuardFinding[] = [];

  if (type === "poc" && normalizedBaseRef === "main") {
    findings.push({
      code: "poc-no-main-merge",
      severity: "error",
      evidence: `${headRef}->${baseRef}`,
      message: "poc/* branches must not merge directly into main; promote through feature/add flow",
    });
  }

  if (type === "hotfix" && normalizedBaseRef === "main") {
    const text = `${input.prTitle ?? ""}\n${input.prBody ?? ""}`;
    if (!hasPostmortem(text)) {
      findings.push({
        code: "hotfix-postmortem-missing",
        severity: "error",
        evidence: headRef,
        message: "hotfix/* PRs to main must include a Postmortem section or marker",
      });
    }
  }

  for (const subject of input.commitSubjects ?? []) {
    const trimmed = subject.trim();
    if (!trimmed || trimmed.startsWith("Merge ")) continue;
    if (!CONVENTIONAL_COMMIT_RE.test(trimmed)) {
      findings.push({
        code: "commitlint-invalid",
        severity: "error",
        evidence: trimmed,
        message: "commit subject must follow Conventional Commits",
      });
    }
  }

  return {
    ok: findings.length === 0,
    headRef,
    baseRef,
    branchType: type,
    findings,
  };
}

export function renderGithubOpsGuard(result: GithubOpsGuardResult): string {
  const lines = [
    `github guard: ${result.ok ? "ok" : "failed"} head=${result.headRef} base=${result.baseRef} type=${result.branchType}`,
  ];
  for (const finding of result.findings) {
    lines.push(`  - ${finding.code}: ${finding.message} (${finding.evidence})`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildReleasePublicationPlan(input: {
  tag: string;
  repo: string;
  dryRun?: boolean;
}): ReleasePublicationPlan {
  const tag = input.tag.trim();
  const repo = input.repo.trim();
  const dryRun = input.dryRun !== false;
  const tarball = `.ut-tdd/release/${tag}.tar.gz`;
  return {
    ok: /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(tag) && repo.length > 0,
    tag,
    repo,
    dryRun,
    commands: [
      `git tag -a ${tag} -m "release ${tag}"`,
      `bun src/cli.ts distribution package --tag ${tag}`,
      `gh release create ${tag} ${tarball} ${tarball}.sha256 ${tarball}.sig --repo ${repo} --verify-tag --notes-file .ut-tdd/release/${tag}.manifest.json`,
    ],
    externalPublishRequiresApproval: true,
  };
}
