/**
 * handover — 機械ポインタ `.ut-tdd/handover/CURRENT.json` (今どこ、機械可読 SSoT)。
 * 散文 scaffold (`docs/handover/session-handover-<date>.md`) の生成は #1062 段階6 で停止した。
 *
 * 設計 (①): docs/design/harness/L6-function-design/handover-mechanism.md (PLAN-L6-06 add-design)。
 * テスト設計 (③): docs/test-design/harness/L7-unit-test-design.md §1.8 U-HOVER-001〜007。
 * PLAN: PLAN-L7-04-handover-mechanism (add-impl)。
 *
 * 設計判断: 機械が答えられる「今どこ」(CURRENT.json) だけを書く。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { computeOutstandingWork } from "../lint/outstanding.ts";
import { ensureDir } from "../shared/fs.ts";
import { GENERATED_BY, POINTER_PATH } from "./handover-constants.ts";
import type {
  BuildPointerInput,
  HandoverArgs,
  HandoverDeps,
  HandoverPointer,
  HandoverResult,
  HandoverStatus,
} from "./handover-types.ts";

export { GENERATED_BY } from "./handover-constants.ts";
export type {
  BuildPointerInput,
  HandoverArgs,
  HandoverDeps,
  HandoverPointer,
  HandoverResult,
  HandoverStatus,
} from "./handover-types.ts";

export function latestSessionId(deps: HandoverDeps): string | null {
  try {
    const dir = join(deps.repoRoot, ".ut-tdd", "logs", "session");
    let best: { sid: string; ts: string } | null = null;
    for (const name of deps.listDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const text = deps.readText(join(dir, name));
      if (!text) continue;
      const lines = text.split("\n").filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (!last) continue;
      try {
        // ts は ISO8601 (nodeDeps.now が常に ISO 出力) = 辞書順比較が時系列順と一致。
        const ev = JSON.parse(last) as { ts?: string; session_id?: string };
        if (ev.ts && ev.session_id && (!best || ev.ts > best.ts)) {
          best = { sid: ev.session_id, ts: ev.ts };
        }
      } catch {
        // 壊れ行 skip
      }
    }
    return best?.sid ?? null;
  } catch {
    return null;
  }
}

/**
 * 新規 pointer は PLAN digest を読まず、PLAN fields を null に固定する。
 */
export function buildPointer(input: BuildPointerInput): HandoverPointer {
  const { status, now } = input;
  return {
    active_plan: null,
    status,
    digest_summary: null,
    updated_at: now,
  };
}

/**
 * U-HOVER-005: 純関数。updated_at が maxHours を超えたら stale。
 * precondition: ISO8601 (Date.parse 可)。数値差分判定 (辞書順比較でない)。境界 (=maxHours) は stale でない。
 */
export function handoverStale(updated_at: string | null, now: string, maxHours = 24): boolean {
  if (!updated_at) return true;
  const u = Date.parse(updated_at);
  const n = Date.parse(now);
  if (Number.isNaN(u) || Number.isNaN(n)) return true;
  return (n - u) / 3_600_000 > maxHours;
}

/** CURRENT.json を読む (不在/壊れ → null、never throws)。 */
export function readPointer(deps: {
  repoRoot: string;
  readText: (p: string) => string | null;
}): HandoverPointer | null {
  try {
    const raw = deps.readText(join(deps.repoRoot, POINTER_PATH));
    if (!raw) return null;
    return JSON.parse(raw) as HandoverPointer;
  } catch {
    return null;
  }
}

/** CURRENT.json を JSON 上書き (単一機械ポインタ、append しない)。 */
export function writePointer(
  pointer: HandoverPointer,
  deps: { repoRoot: string; writeText: (p: string, c: string) => void },
): void {
  deps.writeText(join(deps.repoRoot, POINTER_PATH), `${JSON.stringify(pointer, null, 2)}\n`);
}

/**
 * IMP-078 gap①: handover が `ut-tdd handover` 機構を経ず手書きされた pointer かを検知 (fail-open, 純判定)。
 * CURRENT.json が generated_by 署名を持たない = 手書き pointer を surface する。散文 md の entry 数照合 (`doc_entry_count`) は #1062 段階6 で撤去した
 * (L6 state-channel-consolidation §5.2)。
 */
export function checkHandoverBypass(deps: HandoverDeps): string[] {
  const pointer = readPointer(deps);
  if (!pointer || pointer.generated_by === GENERATED_BY) return [];
  return [
    "handover bypass: CURRENT.json が ut-tdd handover 由来でない (手書き) → `ut-tdd handover` で生成し直す",
  ];
}

/**
 * orchestration。pointer → CURRENT.json 更新 (dry-run は書かない)。
 * 書くのは `.ut-tdd/handover/CURRENT.json` だけ (散文 scaffold の生成は #1062 段階6 で停止)。
 * 新規 pointer は active_plan:null。
 */
export function runHandover(args: HandoverArgs, deps: HandoverDeps): HandoverResult {
  const status: HandoverStatus = args.complete ? "completed" : "in_progress";
  // PLAN-L7-98 (Q1): 未了の正の集計を CURRENT.json へ additive 記録 (session 再開時に「完了主張」を機械照合可能に)。
  const pointer: HandoverPointer = {
    ...buildPointer({ status, now: deps.now() }),
    generated_by: GENERATED_BY,
    outstanding: computeOutstandingWork(deps.repoRoot),
  };

  const written: string[] = [];
  if (!args.dryRun) {
    writePointer(pointer, deps);
    written.push(POINTER_PATH);
  }
  return { pointer, written };
}

export function nodeHandoverDeps(repoRoot: string): HandoverDeps {
  return {
    repoRoot,
    now: () => new Date().toISOString(),
    readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeText: (p, c) => {
      ensureDir(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  };
}
