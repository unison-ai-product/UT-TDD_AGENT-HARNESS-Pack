export type ForwardReadiness = "着手可能" | "進行中" | "阻害中" | "保留" | "レビュー中" | "完了";

export interface ForwardScheduleEntry {
  planId: string;
  revision: string;
  layer: string;
  status: string;
  currentLocation: string;
  rag: string;
  blockedReason: string;
  predecessorPlanIds: readonly string[];
}

export interface ForwardEvidence {
  planId: string;
  headSha?: string;
  ci?: "未実行" | "実行中" | "成功" | "失敗" | "取消";
  review?: "未依頼" | "依頼中" | "承認" | "要修正";
  sync?: "同期済" | "遅延" | "不整合" | "未同期";
  mergeVerified?: boolean;
}

export interface ForwardReadinessRow {
  planId: string;
  revision: string;
  layer: string;
  readiness: ForwardReadiness;
  currentGate: string;
  implementationOrder: number;
  predecessorPlanIds: string[];
  blockedReason: string;
  unlockCondition: string;
  nextPlanIds: string[];
  unlockedPlanIds: string[];
  headSha: string;
  ci: NonNullable<ForwardEvidence["ci"]>;
  review: NonNullable<ForwardEvidence["review"]>;
  sync: NonNullable<ForwardEvidence["sync"]>;
}

const COMPLETE = new Set(["confirmed", "completed", "accepted", "merged", "closed", "documented"]);
const PARKED = new Set(["parked", "deferred", "superseded", "rejected"]);

function cleanIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function hasClosureEvidence(evidence: ForwardEvidence | undefined): boolean {
  return (
    evidence?.ci === "成功" &&
    evidence.review === "承認" &&
    evidence.sync === "同期済" &&
    evidence.mergeVerified === true
  );
}

function gate(entry: ForwardScheduleEntry, evidence: ForwardEvidence | undefined): string {
  if (COMPLETE.has(entry.status)) return hasClosureEvidence(evidence) ? "accept" : "merge-closure";
  if (evidence?.review === "承認" || evidence?.review === "依頼中") return "review";
  if (evidence?.ci === "成功") return "trace-freeze";
  if (entry.currentLocation.trim()) return entry.currentLocation.trim();
  return "plan";
}

export function deriveForwardReadiness(
  entries: readonly ForwardScheduleEntry[],
  evidenceRows: readonly ForwardEvidence[] = [],
): ForwardReadinessRow[] {
  const byId = new Map(entries.map((entry) => [entry.planId, entry]));
  if (byId.size !== entries.length) throw new Error("duplicate plan_id in schedule entries");
  const evidence = new Map(evidenceRows.map((row) => [row.planId, row]));
  const completed = new Set(
    entries
      .filter((entry) => {
        if (!COMPLETE.has(entry.status)) return false;
        const observation = evidence.get(entry.planId);
        return hasClosureEvidence(observation);
      })
      .map((entry) => entry.planId),
  );
  const successors = new Map<string, string[]>();
  for (const entry of entries) {
    for (const predecessor of cleanIds(entry.predecessorPlanIds)) {
      successors.set(predecessor, [...(successors.get(predecessor) ?? []), entry.planId]);
    }
  }

  return entries
    .map((entry, index) => {
      const predecessors = cleanIds(entry.predecessorPlanIds);
      const missing = predecessors.filter((id) => !byId.has(id));
      const unresolved = predecessors.filter((id) => byId.has(id) && !completed.has(id));
      const observation = evidence.get(entry.planId);
      const sync = observation?.sync ?? "未同期";
      const completionEvidenceMissing = COMPLETE.has(entry.status)
        ? [
            observation?.ci !== "成功" ? "完了条件: CI成功未確認" : "",
            observation?.review !== "承認" ? "完了条件: review承認未確認" : "",
            sync !== "同期済" ? "完了条件: Project同期未確認" : "",
            observation?.mergeVerified !== true ? "完了条件: merge/main CI未確認" : "",
          ].filter(Boolean)
        : [];
      const reasons = [
        entry.blockedReason.trim(),
        missing.length > 0 ? `先行PLAN欠損: ${missing.join(", ")}` : "",
        unresolved.length > 0 ? `先行PLAN未完了: ${unresolved.join(", ")}` : "",
        sync === "不整合" ? "GitHub Project同期不整合" : "",
        observation?.ci === "失敗" ? "CI失敗" : "",
        observation?.review === "要修正" ? "レビュー要修正" : "",
        ...completionEvidenceMissing,
      ].filter(Boolean);
      let readiness: ForwardReadiness;
      if (reasons.length > 0) readiness = "阻害中";
      else if (COMPLETE.has(entry.status)) readiness = "完了";
      else if (PARKED.has(entry.status)) readiness = "保留";
      else if (observation?.review === "依頼中" || observation?.review === "承認")
        readiness = "レビュー中";
      else if (
        entry.status === "in_progress" ||
        entry.status === "active" ||
        observation?.ci === "実行中" ||
        observation?.ci === "成功"
      )
        readiness = "進行中";
      else readiness = "着手可能";
      return {
        planId: entry.planId,
        revision: entry.revision,
        layer: entry.layer,
        readiness,
        currentGate: gate(entry, observation),
        implementationOrder: index + 1,
        predecessorPlanIds: predecessors,
        blockedReason: reasons.join("; "),
        unlockCondition:
          unresolved.length > 0 || missing.length > 0
            ? [...missing, ...unresolved].map((id) => `${id}完了`).join(", ")
            : "",
        nextPlanIds: cleanIds(successors.get(entry.planId) ?? []),
        unlockedPlanIds:
          readiness === "完了"
            ? cleanIds(successors.get(entry.planId) ?? []).filter((successorId) => {
                const successor = byId.get(successorId);
                return successor?.predecessorPlanIds.every((id) => completed.has(id)) ?? false;
              })
            : [],
        headSha: observation?.headSha ?? "",
        ci: observation?.ci ?? "未実行",
        review: observation?.review ?? "未依頼",
        sync,
      };
    })
    .sort(
      (a, b) => a.implementationOrder - b.implementationOrder || a.planId.localeCompare(b.planId),
    );
}
