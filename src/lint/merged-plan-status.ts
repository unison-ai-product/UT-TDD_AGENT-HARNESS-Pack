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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadReviewPlans } from "./review-evidence";
import { normalizePath } from "./shared";

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
}

export interface MergedPlanStatusInput {
  plans: MergedPlanRow[];
}

export interface MergedPlanStatusViolation {
  planId: string;
  status: string;
  artifacts: string[];
}

export interface MergedPlanStatusResult {
  violations: MergedPlanStatusViolation[];
  ok: boolean;
}

/**
 * 未 confirm かつ merged deliverable 実在の PLAN を violation として返す (kind 非依存、deliverable-driven)。
 */
export function analyzeMergedPlanStatus(input: MergedPlanStatusInput): MergedPlanStatusResult {
  const violations = input.plans
    .filter((p) => !CONFIRMED_STATUSES.has(p.status.toLowerCase()) && p.mergedArtifacts.length > 0)
    .map((p) => ({ planId: p.planId, status: p.status, artifacts: p.mergedArtifacts }))
    .sort((a, b) => a.planId.localeCompare(b.planId));
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
  for (const rp of reviewPlans) {
    if (rp.status === "archived") continue;
    let content = "";
    try {
      content = readFileSync(join(plansDir, rp.file), "utf8");
    } catch {
      continue;
    }
    const mergedArtifacts = generatesMergedDeliverablePaths(content).filter((p) =>
      existsSync(join(repoRoot, p)),
    );
    plans.push({
      planId: rp.plan_id,
      status: rp.status,
      kind: rp.kind,
      mergedArtifacts,
    });
  }
  return { plans };
}

export function mergedPlanStatusMessages(r: MergedPlanStatusResult): string[] {
  if (r.ok) {
    return [
      "merged-plan-status — OK (merged generated artifact を持つ全 PLAN が confirmed/completed)",
    ];
  }
  return r.violations.map(
    (v) =>
      `merged-plan-status - violation: PLAN ${v.planId} は status=${v.status} (未 confirm) なのに generated deliverable が merge 済み: ${v.artifacts.join(", ")} → PLAN を confirm + review_evidence 記録せよ`,
  );
}
