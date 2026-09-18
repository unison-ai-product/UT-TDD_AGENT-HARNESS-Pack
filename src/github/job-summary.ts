// PLAN-L7-451 W3: GitHub Actions Job Summary ($GITHUB_STEP_SUMMARY) 向け markdown 生成。
//
// 判定正本は harness.db / gate 実測であり、この出力は人間向け projection に徹する
// (PLAN-L4-30 の「GitHub 表示状態を workflow の正本にしない」原則)。
// summary 生成の失敗で CI を red にしない: 入力欠落は degrade して exit 0 を維持する。

import { existsSync } from "node:fs";
import { openHarnessDb } from "../state-db/index.ts";

export interface GateMatrixRow {
  gateId: string;
  planId: string;
  status: string;
  checkedAt: string;
}

export interface JobSummaryData {
  headSha: string;
  branch: string;
  dbObserved: boolean;
  gates: GateMatrixRow[];
  notes: string[];
}

/** harness.db から gate matrix (gate_id ごとの最新観測) を読む。db 欠落は degrade。 */
export function collectJobSummary(input: {
  dbPath: string;
  repoRoot: string;
  headSha: string;
  branch: string;
}): JobSummaryData {
  const notes: string[] = [];
  const gates: GateMatrixRow[] = [];
  let dbObserved = false;
  if (!existsSync(input.dbPath)) {
    notes.push(`harness.db unobserved (${input.dbPath}) — gate matrix skipped`);
  } else {
    try {
      const db = openHarnessDb(input.dbPath, { repoRoot: input.repoRoot });
      try {
        const rows = db
          .prepare("SELECT gate_id, plan_id, status, checked_at FROM gate_runs ORDER BY rowid ASC")
          .all();
        const latest = new Map<string, GateMatrixRow>();
        for (const row of rows) {
          const gateId = String(row.gate_id ?? "");
          if (!gateId) continue;
          latest.set(gateId, {
            gateId,
            planId: String(row.plan_id ?? ""),
            status: String(row.status ?? ""),
            checkedAt: String(row.checked_at ?? ""),
          });
        }
        gates.push(...[...latest.values()].sort((a, b) => a.gateId.localeCompare(b.gateId)));
        dbObserved = true;
      } finally {
        db.close();
      }
    } catch (error) {
      notes.push(`harness.db read failed — gate matrix skipped: ${String(error)}`);
    }
  }
  return { headSha: input.headSha, branch: input.branch, dbObserved, gates, notes };
}

function statusBadge(status: string): string {
  if (status === "passed") return "✅ passed";
  if (status === "failed") return "❌ failed";
  return `⚠️ ${status || "unknown"}`;
}

/** $GITHUB_STEP_SUMMARY へ追記する markdown を組み立てる (副作用なし)。 */
export function renderJobSummary(data: JobSummaryData): string {
  const lines: string[] = [];
  lines.push("## UT-TDD harness summary");
  lines.push("");
  lines.push(`- HEAD: \`${data.headSha || "(unknown)"}\``);
  lines.push(`- branch: \`${data.branch || "(unknown)"}\``);
  lines.push(
    `- source of truth: harness.db / gate 実測 (この summary は人間向け projection であり判定正本ではない)`,
  );
  lines.push("");
  if (data.gates.length > 0) {
    lines.push("### Gate matrix");
    lines.push("");
    lines.push("| Gate | Status | PLAN | Checked at |");
    lines.push("|---|---|---|---|");
    for (const gate of data.gates) {
      lines.push(
        `| ${gate.gateId} | ${statusBadge(gate.status)} | ${gate.planId || "-"} | ${gate.checkedAt || "-"} |`,
      );
    }
    lines.push("");
    const failed = data.gates.filter((gate) => gate.status === "failed");
    if (failed.length > 0) {
      lines.push(
        `**Next action**: failed gate ${failed.map((gate) => gate.gateId).join(", ")} の所有 PLAN を確認する。`,
      );
      lines.push("");
    }
  } else if (data.dbObserved) {
    lines.push("_gate_runs: no rows observed._");
    lines.push("");
  }
  for (const note of data.notes) {
    lines.push(`> ${note}`);
  }
  if (data.notes.length > 0) lines.push("");
  return `${lines.join("\n").trimEnd()}\n`;
}
