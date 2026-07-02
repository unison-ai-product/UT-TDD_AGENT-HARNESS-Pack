import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeProgramCoverage,
  checkSpanExistence,
  computeGateProgress,
  computeProgramRollup,
  loadRoadmaps,
  PARKED_BANDS,
  programCoverageMessages,
} from "../lint/roadmap-registry";
import { fmValue } from "../lint/shared";
import {
  analyzePairFreeze,
  analyzeVerificationGroups,
  loadPairDocs,
  loadVerificationPlanEvidence,
  verificationGroupMessages,
  verificationGroupsOk,
} from "../vmodel/lint";

/** 工程表 roadmap の span 実在性と層内 gate 進捗を hard gate として検査する。 */
export function checkRoadmap(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["roadmap - violation: repo root could not be read"], ok: false };
  }
  try {
    const records = loadRoadmaps(repoRoot);
    // Program coverage: registered roadmaps must cover the forward bands.
    // PLAN-RECOVERY-04 treats an empty roadmap registry as a hard violation.
    const coverageMessages = programCoverageMessages(
      analyzeProgramCoverage(records, new Set(PARKED_BANDS.keys())),
    );
    if (records.length === 0) {
      return {
        messages: [
          "roadmap - violation: 登録済み工程表がありません (master-hub roadmap block 未使用)",
          ...coverageMessages,
        ],
        ok: false,
      };
    }
    // I-1: 各 PLAN を一度だけ読み、id/status を構築する。
    const dir = join(repoRoot, "docs", "plans");
    const known = new Set<string>();
    const statusMap = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const content = readFileSync(join(dir, f), "utf8");
      const id = fmValue(content, "plan_id");
      if (id) {
        known.add(id);
        statusMap.set(id, fmValue(content, "status") ?? "draft");
      }
    }
    const messages: string[] = [];
    let issueCount = 0;
    for (const rec of records) {
      const spanIssues = checkSpanExistence(rec.roadmap, known);
      issueCount += spanIssues.length + rec.errors.length;
      const progress = computeGateProgress(rec.roadmap, (id) => statusMap.get(id) ?? null);
      const reached = progress.filter((g) => g.reached).length;
      messages.push(
        `roadmap - ${rec.planId} [${rec.roadmap.layer}]: gates ${reached}/${progress.length} reached, spans ${rec.roadmap.spans.length}, orphan span ${spanIssues.length}, structure issue ${rec.errors.length}`,
      );
      for (const gi of progress) {
        messages.push(
          `  ${gi.gateId}: ${gi.reached ? "ok reached" : "pending"} (${gi.confirmedSpans}/${gi.totalSpans} span reached: confirmed/completed)`,
        );
      }
      for (const si of spanIssues) messages.push(`  violation: ${si}`);
      for (const e of rec.errors) messages.push(`  violation: structure: ${e}`);
    }
    const rollup = computeProgramRollup(
      records,
      (id) => statusMap.get(id) ?? null,
      new Set(PARKED_BANDS.keys()),
    );
    messages.push(
      `roadmap-rollup - bands ${rollup.coveredBands}/${rollup.totalBands} covered (park ${rollup.parkedBands}, uncovered ${rollup.uncoveredBands}) / gates ${rollup.reachedGates}/${rollup.totalGates} reached / spans ${rollup.confirmedSpans}/${rollup.totalSpans} / frontier: ${rollup.frontier.length ? rollup.frontier.join(", ") : "なし"}`,
    );
    messages.push(...coverageMessages);
    const coverageOk =
      analyzeProgramCoverage(records, new Set(PARKED_BANDS.keys())).uncovered.length === 0;
    return { messages, ok: issueCount === 0 && coverageOk };
  } catch {
    return { messages: ["roadmap - violation: 工程表を読み込めず検査できません"], ok: false };
  }
}

export function checkVerificationGroupsResult(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const docs = loadPairDocs(repoRoot);
    const { orphans } = analyzePairFreeze(docs);
    const groups = analyzeVerificationGroups(docs, orphans, loadVerificationPlanEvidence(repoRoot));
    return { messages: verificationGroupMessages(groups), ok: verificationGroupsOk(groups) };
  } catch {
    return {
      messages: ["verification - violation: verification group lint could not run"],
      ok: false,
    };
  }
}

export function checkVerificationGroups(repoRoot: string): string[] {
  return checkVerificationGroupsResult(repoRoot).messages;
}
