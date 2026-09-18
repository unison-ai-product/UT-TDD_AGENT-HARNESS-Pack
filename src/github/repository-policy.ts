// PLAN-L7-451 W6: repository policy 監査 (read-only)。
//
// authoring source = docs/governance/github-repository-policy.yaml。
// GitHub 現物 (Rulesets / branch protection) との乖離を finding として列挙する。
// 適用操作は含めない (段階適用の実施は PO の gh 認証で行う別手順)。
// gh 不通は判定を偽装せず外部障害として呼び出し側で exit 3 に写像する。

import { parse as parseYaml } from "yaml";

export interface RepositoryPolicy {
  repository: string;
  branch: string;
  requiredStatusChecks: string[];
  blockForcePushes: boolean;
  blockDeletions: boolean;
  requireApprovals: boolean;
  bypassActors: string[];
}

export interface PolicyFinding {
  code: string;
  message: string;
}

export interface PolicyDiffResult {
  ok: boolean;
  findings: PolicyFinding[];
}

/** GitHub Rulesets API (`GET /repos/{r}/rulesets?includes_parents=true` + rules 展開) の観測形。 */
export interface ObservedRuleset {
  name: string;
  enforcement: string;
  targetBranches: string[];
  rules: Array<{
    type: string;
    requiredChecks?: string[];
    requiredApprovingReviewCount?: number;
  }>;
}

export function parseRepositoryPolicy(yamlText: string): RepositoryPolicy {
  const raw = parseYaml(yamlText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new Error("github-repository-policy.yaml が空か object でない");
  }
  const repository = String(raw.repository ?? "");
  const branch = String(raw.branch ?? "");
  if (!repository || !branch) {
    throw new Error("github-repository-policy.yaml に repository / branch が必要");
  }
  const checks = Array.isArray(raw.required_status_checks)
    ? raw.required_status_checks.map(String)
    : [];
  if (checks.length === 0) {
    throw new Error("required_status_checks が空 (集約 gate 名を最低 1 本宣言する)");
  }
  return {
    repository,
    branch,
    requiredStatusChecks: checks,
    blockForcePushes: raw.block_force_pushes === true,
    blockDeletions: raw.block_deletions === true,
    requireApprovals: raw.require_approvals === true,
    bypassActors: Array.isArray(raw.bypass_actors) ? raw.bypass_actors.map(String) : [],
  };
}

function branchMatches(target: string, branch: string, defaultBranch: string): boolean {
  // ~DEFAULT_BRANCH は default branch (単一) のみを指す。policy.branch が default で
  // ない場合にマッチ扱いすると保護を過大評価する fail-open になるため突き合わせる。
  if (target === "~DEFAULT_BRANCH") return branch === defaultBranch;
  if (target === "~ALL") return true;
  const normalized = target.replace(/^refs\/heads\//, "");
  return normalized === branch || normalized === "**";
}

function activeRulesFor(observed: ObservedRuleset[], branch: string, defaultBranch: string) {
  return observed
    .filter(
      (r) =>
        r.enforcement === "active" &&
        r.targetBranches.some((t) => branchMatches(t, branch, defaultBranch)),
    )
    .flatMap((r) => r.rules);
}

/** authoring source と観測済み Rulesets の乖離を finding 化する (乖離なし = ok)。 */
export function diffRepositoryPolicy(
  policy: RepositoryPolicy,
  observed: ObservedRuleset[],
  options: { defaultBranch?: string } = {},
): PolicyDiffResult {
  const findings: PolicyFinding[] = [];
  const rules = activeRulesFor(observed, policy.branch, options.defaultBranch ?? "main");

  const observedChecks = new Set(
    rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.requiredChecks ?? []),
  );
  for (const check of policy.requiredStatusChecks) {
    if (!observedChecks.has(check)) {
      findings.push({
        code: "github-required-check-missing",
        message: `required status check \`${check}\` が ${policy.branch} の active ruleset に無い`,
      });
    }
  }

  if (policy.blockForcePushes && !rules.some((r) => r.type === "non_fast_forward")) {
    findings.push({
      code: "github-force-push-enabled",
      message: `${policy.branch} への force push を禁止する active rule (non_fast_forward) が無い`,
    });
  }

  if (policy.blockDeletions && !rules.some((r) => r.type === "deletion")) {
    findings.push({
      code: "github-branch-deletion-enabled",
      message: `${policy.branch} の削除を禁止する active rule (deletion) が無い`,
    });
  }

  const approvalRule = rules.find(
    (r) => r.type === "pull_request" && (r.requiredApprovingReviewCount ?? 0) > 0,
  );
  if (!policy.requireApprovals && approvalRule) {
    findings.push({
      code: "github-approval-rule-unexpected",
      message:
        "policy は approval 系を適用しない (solo 自己ブロック回避、PO 2026-07-17) が、現物に required approvals がある",
    });
  }
  if (policy.requireApprovals && !approvalRule) {
    findings.push({
      code: "github-approval-rule-missing",
      message: "policy は required approvals を要求するが、現物に無い",
    });
  }

  return { ok: findings.length === 0, findings };
}

/** gh api の raw ruleset JSON (rules 込み) を観測形へ正規化する。 */
export function normalizeRulesets(raw: unknown): ObservedRuleset[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const conditions = (record.conditions ?? {}) as Record<string, unknown>;
    const refName = (conditions.ref_name ?? {}) as Record<string, unknown>;
    const include = Array.isArray(refName.include) ? refName.include.map(String) : [];
    const rules = Array.isArray(record.rules) ? record.rules : [];
    return {
      name: String(record.name ?? ""),
      enforcement: String(record.enforcement ?? ""),
      targetBranches: include,
      rules: rules.map((rule) => {
        const ruleRecord = (rule ?? {}) as Record<string, unknown>;
        const parameters = (ruleRecord.parameters ?? {}) as Record<string, unknown>;
        const checks = Array.isArray(parameters.required_status_checks)
          ? parameters.required_status_checks.map((check) =>
              String(((check ?? {}) as Record<string, unknown>).context ?? ""),
            )
          : undefined;
        const approvals = parameters.required_approving_review_count;
        return {
          type: String(ruleRecord.type ?? ""),
          requiredChecks: checks,
          requiredApprovingReviewCount: typeof approvals === "number" ? approvals : undefined,
        };
      }),
    };
  });
}

export function renderPolicyDiff(result: PolicyDiffResult): string {
  if (result.ok) return "github repository policy — OK (authoring source と現物に乖離なし)\n";
  const lines = ["github repository policy — DRIFT"];
  for (const finding of result.findings) {
    lines.push(`  - [${finding.code}] ${finding.message}`);
  }
  lines.push(
    "  next: 乖離が意図的なら policy.yaml を更新、そうでなければ PO の gh 認証で適用手順を実施",
  );
  return `${lines.join("\n")}\n`;
}
