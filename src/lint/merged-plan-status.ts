/**
 * merged-plan-status lint — 「generated artifact が repo に実在 (merged) なのに owning PLAN が
 * draft / 未 confirm のまま放置」される V-model state 不整合を機械検出する (hard、doctor.ok 連動)。
 *
 * 動機 (PO 指摘 2026-06-15): PLAN-L7-53 (Learning Engine) は kind=impl の実装が main に merge 済・
 * 全テスト green だったが status=draft + review_evidence=[] のまま放置され、**人手 grep でしか
 * 発見できなかった**。review-evidence gate は confirmed/completed PLAN にのみ証跡を要求するため、
 * draft の PLAN は素通りする (absence-blindness)。harness.db / V-model state DB が「フィードバック
 * 機構」(設計の柱3) として機能するなら、この不整合は機械が surface すべきである。
 *
 * 検出規則: status が confirmed/completed/accepted のいずれでもない PLAN について、その `generates`
 * の **merged deliverable が実在 (existsSync)** なら「merged-but-unconfirmed」violation とする。draft でも
 * deliverable が未 merge なら (= 真に作業中) violation にしない。これにより「実装が merge されたら PLAN を
 * confirm + review せよ」を fail-close 強制する。
 *
 * merged deliverable = repo の出荷物ルート (src/ tests/ scripts/ .claude/) 配下の generates artifact。
 * docs/ (PLAN 本体・設計・テスト設計) と .ut-tdd/ (生成ランタイム状態) は confirm 前に実在するのが
 * 正常なので除外する。**src/*.ts 限定だと `.claude/commands/*.md` など非 src deliverable を産出して
 * draft 放置された PLAN を見逃す** (PLAN-L7-71 が draft のまま 7 個の slash command を merge 済で
 * 素通りし、人手 PLAN 読みでしか発見できなかった実例、2026-06-19)。
 *
 * **kind での絞り込みはしない (deliverable-driven、2026-06-22 PLAN-L7-87)**: かつては kind を
 * artifact 産出系 (impl/add-impl/refactor) に限定していたが、これは「design/poc/reverse は出荷物を
 * merge しない」という誤った前提に依存していた。実際には poc の dogfood spike (DISCOVERY-05 が
 * src/schema/roadmap.ts ほかを merge) や add-design (L3-04/L3-05 が src/lint/*.ts を merge) が
 * 出荷物を merge し、kind フィルタの盲点で 3 件の draft 放置が doctor green のまま埋もれた。
 * **merged deliverable の実在こそが drift の正確なシグナル**であり、kind は無関係 (出荷物を merge した
 * なら kind を問わず PLAN を confirm すべき)。`mergedArtifacts` は既に「実在する出荷物ルート artifact」
 * だけに filter 済みなので、kind 条件は冗長かつ有害 (過小検出) だった。PLAN-L7-86 が path フィルタ
 * (src/*.ts → 出荷物ルート) を直したのに続き、本修正で kind フィルタの盲点を塞ぐ。
 *
 * 純関数 (analyzeMergedPlanStatus) + I/O loader (loadMergedPlanStatusInput) を分離 (lint 共通様式)。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type ArtifactTargetDecision,
  classifyTargetArtifacts,
  type MergedPlanTargetEvidence,
  resolveMergedPlanTargetEvidence,
} from "./merged-plan-target-evidence.ts";
import { loadReviewPlans } from "./review-evidence.ts";
import { normalizePath } from "./shared.ts";

// review-evidence gate との scope 差は意図的 (別関心、reviewer I-1/I-2):
//   - 本 gate = **status 正確性**の強制 = 「出荷物を merge したら PLAN を draft のままにするな」。
//     kind を問わず、出荷物ルート (src/tests/scripts/.claude) の deliverable を merge した全 PLAN が
//     対象 (deliverable-driven、2026-06-22 PLAN-L7-87)。「merge したら confirm」は普遍
//     (review_evidence の要否とは独立)。
//   - review-evidence gate = **証跡要求** = confirmed/completed の PLAN が review_evidence を持つか。
//     refactor は review-evidence 対象外 (機能変更なし) だが、それは「confirm 時に証跡が要るか」の話で、
//     「merge 済みなら draft でないこと」とは別軸。両 gate は相補 (重複でも矛盾でもない)。
/** confirm 済み (= merge して良い終端) とみなす status。これ以外で deliverable 実在 = draft 放置の不整合。 */
const CONFIRMED_STATUSES: ReadonlySet<string> = new Set(["confirmed", "completed", "accepted"]);
/**
 * 「merge したら confirm」を強制する出荷物ルート (CLAUDE.md architecture boundary 準拠)。
 * docs/ = V-model 設計成果物、.ut-tdd/ = 生成ランタイム状態で、どちらも confirm 前に実在するのが
 * 正常なので deliverable から除外する。
 */
const DELIVERABLE_ROOTS: readonly string[] = ["src/", "tests/", "scripts/", ".claude/"];

export interface MergedPlanRow {
  planId: string;
  status: string;
  kind: string;
  /** generates の deliverable (src/ tests/ scripts/ .claude/) のうち repo に実在する (= merged) パス集合。 */
  mergedArtifacts: string[];
  /**
   * target には未着だが検査対象 (PR head) が持ち込む deliverable (issue #162)。
   * merge されれば `mergedArtifacts` になる = **merge 前に同じ違反を検出できる**面。
   * 三点比較できない面では常に空 (従来の二点比較へ縮退)。
   */
  landingArtifacts?: string[];
  /** canonical targetに対する全declared deliverableの判定証拠。absentも捨てない。 */
  artifactDecisions?: ArtifactTargetDecision[];
}

export interface MergedPlanStatusInput {
  plans: MergedPlanRow[];
  targetEvidence?: MergedPlanTargetEvidence;
}

export interface MergedPlanStatusViolation {
  planId: string;
  status: string;
  artifacts: string[];
  /**
   * - merged: deliverable が既に target に載っている (従来の post-merge 検出)。
   * - landing: この PR が merge されれば載る (issue #162 の pre-merge 検出)。
   *   同じ不整合を **merge 前に**同じ gate で捕まえるための区分。
   */
  phase?: "merged" | "landing";
}

export interface MergedPlanStatusResult {
  violations: MergedPlanStatusViolation[];
  ok: boolean;
}

/**
 * 未 confirm かつ merged deliverable 実在の PLAN を violation として返す (kind 非依存、deliverable-driven)。
 */
export function analyzeMergedPlanStatus(input: MergedPlanStatusInput): MergedPlanStatusResult {
  const unconfirmed = input.plans.filter((p) => !CONFIRMED_STATUSES.has(p.status.toLowerCase()));
  const violations = [
    ...unconfirmed
      .filter((p) => p.mergedArtifacts.length > 0)
      .map((p) => ({
        planId: p.planId,
        status: p.status,
        artifacts: p.mergedArtifacts,
        phase: "merged" as const,
      })),
    // merge 前に同じ不整合を捕まえる面 (issue #162)。merged 側と重複しないよう、既に merged で
    // 挙がっている PLAN は landing では出さない (1 PLAN 1 violation)。
    ...unconfirmed
      .filter((p) => p.mergedArtifacts.length === 0 && (p.landingArtifacts?.length ?? 0) > 0)
      .map((p) => ({
        planId: p.planId,
        status: p.status,
        artifacts: p.landingArtifacts ?? [],
        phase: "landing" as const,
      })),
  ].sort((a, b) => a.planId.localeCompare(b.planId));
  return { violations, ok: violations.length === 0 };
}

interface PlanFrontmatterGenerates {
  generates?: { artifact_path?: string }[];
}

function generatesMergedDeliverablePaths(content: string): string[] {
  // CRLF 許容 (Windows-first)。`\n` 固定だと CRLF 保存の PLAN を無言 skip し検出漏れ (PLAN-L7-55
  // review I-1、plan-artifact-existence と同一様式)。
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  let fm: PlanFrontmatterGenerates;
  try {
    fm = (parseYaml(m[1]) as PlanFrontmatterGenerates) ?? {};
  } catch {
    return [];
  }
  return (fm.generates ?? [])
    .map((g) => normalizePath(g.artifact_path ?? ""))
    .filter((p) => DELIVERABLE_ROOTS.some((root) => p.startsWith(root)));
}

export function loadMergedPlanStatusInput(repoRoot: string): MergedPlanStatusInput {
  const plans: MergedPlanRow[] = [];
  let reviewPlans: ReturnType<typeof loadReviewPlans>;
  try {
    reviewPlans = loadReviewPlans(repoRoot);
  } catch {
    return { plans: [] }; // docs/plans 不在は空 (fail-open、他 lint と同方針)
  }
  const plansDir = join(repoRoot, "docs", "plans");
  const isGitRepo = gitObjectExists(repoRoot, "HEAD");
  const targetEvidence = isGitRepo ? resolveMergedPlanTargetEvidence(repoRoot) : undefined;
  if (
    targetEvidence?.decision === "no_verified_target" ||
    (isGitRepo && !targetEvidence?.targetSha)
  ) {
    throw new Error("merged-plan canonical target could not be verified");
  }
  const targetPaths = targetEvidence?.targetSha
    ? new Set(
        gitText(repoRoot, ["ls-tree", "-r", "--name-only", targetEvidence.targetSha]).split(
          /\r?\n/,
        ),
      )
    : null;
  // 検査対象 (PR head) と immediate base の tree。三点比較で「この PR が merge されたら target に
  // 載る deliverable」を merge 前に見分ける (issue #162)。
  //
  // 三点比較は **subject と immediate base の両方が解決できたときだけ**有効化し、片方でも欠けたら
  // landing 検出ごと落として従来の二点比較へ縮退する。immediate base が分からないまま subject だけで
  // 分類すると、stacked 構成で親由来の deliverable を landing と誤認し、RECOVERY-18 が塞いだ
  // 「子 PR を永久 Red にする」誤検出を別経路で再発させる。event の欠落 (非 PR 実行) も、親 branch
  // 削除や shallow fetch による object 未解決も、区別できないという点では同じなので同じ扱いにする。
  const immediateBasePaths = treePathsOrNull(repoRoot, targetEvidence?.immediateBaseSha);
  const subjectPaths = immediateBasePaths
    ? treePathsOrNull(repoRoot, targetEvidence?.subjectHeadSha)
    : null;
  for (const rp of reviewPlans) {
    if (rp.status === "archived") continue;
    let content = "";
    try {
      // PLAN の status/generates は検査対象 PR の現在本文を正本にする。base の本文を
      // 読むと、PR 自身が draft 放置を confirm 化または generates 修正で是正しても、
      // doctor が古い定義だけを再検出して自己是正不能になる。一方「成果物が既に
      // merge 済みか」は base tree で判定し、PR 中に初めて追加した成果物を誤検出しない。
      content = readFileSync(join(plansDir, rp.file), "utf8");
      if (!content) continue;
    } catch {
      continue;
    }
    const declaredArtifacts = generatesMergedDeliverablePaths(content);
    const artifactDecisions = targetPaths
      ? classifyTargetArtifacts(declaredArtifacts, targetPaths, {
          ...(subjectPaths ? { subjectPaths } : {}),
          ...(immediateBasePaths ? { immediateBasePaths } : {}),
        })
      : declaredArtifacts.map(
          (path): ArtifactTargetDecision => ({
            path,
            decision: existsSync(join(repoRoot, path)) ? "landed_on_target" : "absent_from_target",
          }),
        );
    const mergedArtifacts = artifactDecisions
      .filter((decision) => decision.decision === "landed_on_target")
      .map((decision) => decision.path);
    const landingArtifacts = artifactDecisions
      .filter((decision) => decision.decision === "landing_in_subject")
      .map((decision) => decision.path);
    const baseStatus = frontmatterStatus(content) ?? rp.status;
    plans.push({
      planId: rp.plan_id,
      status: baseStatus,
      kind: rp.kind,
      mergedArtifacts,
      landingArtifacts,
      artifactDecisions,
    });
  }
  return { plans, ...(targetEvidence ? { targetEvidence } : {}) };
}

/** ref の tree path 集合。解決できなければ null (推測で violation を作らない)。 */
function treePathsOrNull(repoRoot: string, sha: string | null | undefined): Set<string> | null {
  if (!sha) return null;
  try {
    return new Set(
      execFileSync("git", ["-C", repoRoot, "ls-tree", "-r", "--name-only", sha], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      }).split(/\r?\n/),
    );
  } catch {
    return null;
  }
}

function frontmatterStatus(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;
  try {
    const value = parseYaml(match[1]) as { status?: unknown };
    return typeof value?.status === "string" ? value.status : null;
  } catch {
    return null;
  }
}

function gitObjectExists(repoRoot: string, object: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", object], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

export function mergedPlanStatusMessages(r: MergedPlanStatusResult): string[] {
  if (r.ok) {
    return [
      "merged-plan-status — OK (merged generated artifact を持つ全 PLAN が confirmed/completed)",
    ];
  }
  return r.violations.map((v) => {
    const base = `merged-plan-status - violation: PLAN ${v.planId} は status=${v.status} (未 confirm) なのに generated deliverable が ${v.phase === "landing" ? "landing" : "merge 済み"}: ${v.artifacts.join(", ")}`;
    if (v.phase !== "landing") {
      return `${base} → PLAN を confirm + review_evidence 記録せよ`;
    }
    return `${base} (phase=landing) → 是正手順: (A) 分割: PLAN filing PR は generates を PLAN doc のみにし、pair-freeze cross-review 後、preflight review_evidence で PLAN を implementation PR 前に confirmed として成立させてもよい。その後の実装 PR で generated artifact の generates 宣言を追加する; (B) 単一の実装 PR: preflight review_evidence を根拠に PLAN を confirmed にし、generates 宣言を追加する。非著者 closing review の PASS verdict と canonical receipt は、最終変更後の exact PR HEAD に対する PR comment / canonical review receipt に残す。これは merge 前に PLAN の review_evidence へ書き戻す要件ではない。close gate は exact PR HEAD の非著者 closing review PASS と canonical receipt を要求する。confirm 時の preflight review_evidence は tests_green_at <= reviewed_at、green_commands は kind/command/runner/scope/exit_code/completed_at/evidence_path/output_digest/anchor_commit を完備。正本: CLAUDE.md / docs/design/harness/L6-function-design/test-before-review.md`;
  });
}
