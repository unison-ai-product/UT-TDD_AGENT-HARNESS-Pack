import { existsSync } from "node:fs";
import {
  analyzeImplPlanTrace,
  implPlanTraceMessages,
  loadImplPlanTraceInput,
} from "../lint/impl-plan-trace";
import {
  analyzeMergedPlanStatus,
  loadMergedPlanStatusInput,
  mergedPlanStatusMessages,
} from "../lint/merged-plan-status";
import {
  analyzeOracleTestTrace,
  loadOracleTestTraceInput,
  oracleTestTraceMessages,
} from "../lint/oracle-test-trace";
import {
  analyzePlanArtifactExistence,
  loadPlanArtifactExistenceInput,
  planArtifactExistenceMessages,
} from "../lint/plan-artifact-existence";
import {
  analyzeTrackedCanonical,
  loadTrackedCanonicalInput,
  trackedCanonicalMessages,
} from "../lint/tracked-canonical";

/**
 * merged-plan-status hard gate (PO 指摘 2026-06-15): generated src が merge 済みなのに owning PLAN が
 * draft / 未 confirm のまま放置される V-model state 不整合を fail-close 検出する。review-evidence gate が
 * confirmed PLAN にのみ証跡を要求し draft を素通りさせる absence-blindness を補完する (柱3 = state DB が
 * フィードバック機構)。
 */
export function checkMergedPlanStatus(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["merged-plan-status - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeMergedPlanStatus(loadMergedPlanStatusInput(repoRoot));
    return { messages: mergedPlanStatusMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["merged-plan-status - violation: PLAN generates could not be read"],
      ok: false,
    };
  }
}

/**
 * plan-artifact-existence hard gate (PO /goal 2026-06-15): PLAN が confirmed/completed/accepted (完了宣言)
 * なのに generates artifact が不在 (phantom / false-completion) を fail-close 検出する。merged-plan-status
 * の鏡像で、PLAN↕artifact 実在マトリクスを 2 gate で完結させる。impl-plan-trace (src→PLAN) も
 * review-evidence (証跡有無) も artifact 実在を見ない absence-blindness を塞ぐ (柱3 / 柱6)。
 */
export function checkPlanArtifactExistence(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["plan-artifact-existence - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzePlanArtifactExistence(loadPlanArtifactExistenceInput(repoRoot));
    return { messages: planArtifactExistenceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["plan-artifact-existence - violation: PLAN generates could not be read"],
      ok: false,
    };
  }
}

/** impl→PLAN トレーサビリティ (src ⊆ PLAN generates ∪ baseline) を hard gate として検査する。 */
export function checkImplPlanTrace(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["impl-plan-trace - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeImplPlanTrace(loadImplPlanTraceInput(repoRoot));
    return { messages: implPlanTraceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["impl-plan-trace - violation: src/PLAN trace could not be read"],
      ok: false,
    };
  }
}

/** git tracked top-level ⊆ repository-structure.md canonical の突合を hard gate として検査する。 */
export function checkTrackedCanonical(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["tracked-canonical - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeTrackedCanonical(loadTrackedCanonicalInput(repoRoot));
    return { messages: trackedCanonicalMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["tracked-canonical - violation: git/repository-structure could not be read"],
      ok: false,
    };
  }
}

/** oracle 宣言 ⇔ 実テスト citation の突合を hard gate として検査する。 */
export function checkOracleTestTrace(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["oracle-test-trace - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeOracleTestTrace(loadOracleTestTraceInput(repoRoot));
    return { messages: oracleTestTraceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["oracle-test-trace - violation: test-design/tests could not be read"],
      ok: false,
    };
  }
}
