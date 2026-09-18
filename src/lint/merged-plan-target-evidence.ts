import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export type TargetRefSource =
  | "event_default_base"
  | "remote_default"
  | "local_default"
  | "origin_main"
  | "local_main";

export interface TargetRefCandidate {
  ref: string;
  source: TargetRefSource;
  exists: boolean;
  sha?: string;
}

export interface MergedPlanTargetEvidence {
  decision: "canonical_target" | "no_verified_target";
  targetRef: string | null;
  targetSha: string | null;
  mergeBaseSha: string | null;
  subjectHeadSha: string | null;
  immediateBaseRef: string | null;
  immediateBaseSha: string | null;
  source: TargetRefSource | null;
}

export interface ArtifactTargetDecision {
  path: string;
  /**
   * - landed_on_target: canonical target (default branch) に既に存在する = merge 済み。
   * - landing_in_subject: target に不在だが検査対象 (PR head) に存在し、かつ immediate base にも
   *   不在 = **この PR が merge されたら target に載る** (issue #162 の pre-merge 検出)。
   * - inherited_from_base: target に不在だが immediate base に既に存在 = stacked PR の親が
   *   持ち込んだもの。この PR の責任ではないので landing とは区別する。
   * - absent_from_target: どこにも無い。
   */
  decision:
    | "landed_on_target"
    | "landing_in_subject"
    | "inherited_from_base"
    | "absent_from_target";
}

/** 三点比較の三点目。解決できない面は undefined にして二点比較へ縮退させる (issue #162)。 */
export interface SubjectTrees {
  /** 検査対象 (PR head) の tree path 集合。 */
  readonly subjectPaths?: ReadonlySet<string>;
  /** immediate base (stacked PR の親) の tree path 集合。 */
  readonly immediateBasePaths?: ReadonlySet<string>;
}

export function selectCanonicalMergedTarget(input: {
  candidates: readonly TargetRefCandidate[];
  subjectHeadSha: string | null;
  immediateBaseRef?: string | null;
  immediateBaseSha?: string | null;
  mergeBaseSha?: string | null;
}): MergedPlanTargetEvidence {
  const selected = input.candidates.find((candidate) => candidate.exists && candidate.sha);
  return {
    decision: selected ? "canonical_target" : "no_verified_target",
    targetRef: selected?.ref ?? null,
    targetSha: selected?.sha ?? null,
    mergeBaseSha: selected ? (input.mergeBaseSha ?? null) : null,
    subjectHeadSha: input.subjectHeadSha,
    immediateBaseRef: input.immediateBaseRef ?? null,
    immediateBaseSha: input.immediateBaseSha ?? null,
    source: selected?.source ?? null,
  };
}

/**
 * declared deliverable を **三点比較** (target / immediate base / subject) で分類する。
 *
 * 二点 (target のみ) だと、PR が新規に持ち込む deliverable が「target に無い」で終わり、merge 後の
 * main で初めて検出される (issue #162 の post-merge 罠)。三点目に subject を足すと merge 前に
 * 検出でき、immediate base も見ることで stacked PR の親が持ち込んだ分を誤帰責しない。
 *
 * `subject` 未指定なら従来どおり二値 (完全後方互換)。
 */
export function classifyTargetArtifacts(
  declaredPaths: readonly string[],
  targetPaths: ReadonlySet<string>,
  subject?: SubjectTrees,
): ArtifactTargetDecision[] {
  const subjectPaths = subject?.subjectPaths;
  const immediateBasePaths = subject?.immediateBasePaths;
  return declaredPaths.map((rawPath) => {
    const path = rawPath.replaceAll("\\", "/");
    if (targetPaths.has(path)) return { path, decision: "landed_on_target" as const };
    if (subjectPaths?.has(path)) {
      // 親 PR が持ち込んだものは landing に数えない (誤帰責の回避)。
      if (immediateBasePaths?.has(path)) return { path, decision: "inherited_from_base" as const };
      return { path, decision: "landing_in_subject" as const };
    }
    return { path, decision: "absent_from_target" as const };
  });
}

export function resolveMergedPlanTargetEvidence(repoRoot: string): MergedPlanTargetEvidence {
  const event = readGithubEvent();
  const subjectHeadSha = gitTextOrNull(repoRoot, ["rev-parse", "HEAD"]);
  const symbolicDefault = gitTextOrNull(repoRoot, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const knownDefaultBranch =
    event.defaultBranch ?? symbolicDefault?.replace(/^origin\//, "") ?? null;
  // default branch identity が分かる場合は、そのrefが欠けてもmainへ横滑りしない。
  // 別branchをlanded targetとして採るより no_verified_target でfail-closeする。
  const rawCandidates: Array<{ ref: string; source: TargetRefSource }> = knownDefaultBranch
    ? [
        ...(event.immediateBaseRef === knownDefaultBranch && event.immediateBaseSha
          ? [{ ref: event.immediateBaseSha, source: "event_default_base" as const }]
          : []),
        { ref: `origin/${knownDefaultBranch}`, source: "remote_default" },
        { ref: knownDefaultBranch, source: "local_default" },
      ]
    : [
        { ref: "origin/main", source: "origin_main" },
        { ref: "main", source: "local_main" },
      ];
  const seen = new Set<string>();
  const candidates = rawCandidates
    .filter((candidate) => !seen.has(candidate.ref) && seen.add(candidate.ref))
    .map((candidate) => {
      const sha = gitTextOrNull(repoRoot, ["rev-parse", "--verify", `${candidate.ref}^{commit}`]);
      return { ...candidate, exists: Boolean(sha), ...(sha ? { sha } : {}) };
    });
  const selected = candidates.find((candidate) => candidate.exists && candidate.sha);
  const mergeBaseSha =
    selected?.sha && subjectHeadSha
      ? gitTextOrNull(repoRoot, ["merge-base", selected.sha, subjectHeadSha])
      : null;
  return selectCanonicalMergedTarget({
    candidates,
    subjectHeadSha,
    immediateBaseRef: event.immediateBaseRef,
    immediateBaseSha: event.immediateBaseSha,
    mergeBaseSha,
  });
}

function readGithubEvent(): {
  defaultBranch: string | null;
  immediateBaseRef: string | null;
  immediateBaseSha: string | null;
} {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    return { defaultBranch: null, immediateBaseRef: null, immediateBaseSha: null };
  }
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      repository?: { default_branch?: unknown };
      pull_request?: { base?: { ref?: unknown; sha?: unknown } };
    };
    const defaultBranch = event.repository?.default_branch;
    const baseRef = event.pull_request?.base?.ref;
    const baseSha = event.pull_request?.base?.sha;
    return {
      defaultBranch: typeof defaultBranch === "string" ? defaultBranch : null,
      immediateBaseRef: typeof baseRef === "string" ? baseRef : null,
      immediateBaseSha:
        typeof baseSha === "string" && /^[0-9a-f]{40}$/i.test(baseSha) ? baseSha : null,
    };
  } catch {
    return { defaultBranch: null, immediateBaseRef: null, immediateBaseSha: null };
  }
}

function gitTextOrNull(repoRoot: string, args: readonly string[]): string | null {
  try {
    return (
      execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}
