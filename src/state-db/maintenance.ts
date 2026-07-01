/**
 * harness.db CLI maintenance — `ut-tdd db status` / `db rebuild` のロジック (PLAN-L7-45, span ①)。
 *
 * foundation 段階では status = schema/行数の read-only 報告、rebuild = schema 適用 (冪等)。
 * docs/state/logs からの projection 充填は span ② (projection-writer) が `rebuildHarnessDb` で配線する。
 * 本モジュールは充填しない (foundation の rebuild は schema 整備までを deterministic に行う)。
 */
import { existsSync } from "node:fs";
import { SCHEMA_VERSION } from "../schema/harness-db";
import { defaultHarnessDbPath, type HarnessDb, openHarnessDb } from "./index";
import { type MigrationResult, migrate, missingTables, rowCounts, tableNames } from "./migration";

export interface HarnessDbStatus {
  path: string;
  /** DB ファイルが存在するか (status は DB を新規作成しない)。 */
  initialized: boolean;
  schemaVersion: number;
  expectedVersion: number;
  /** registry 宣言 table のうち DB に存在しないもの。 */
  missingTables: string[];
  tableCount: number;
  totalRows: number;
  /** 参照先 (artifact_registry) を欠く trace_edges 件数 (projection 健全性の即時シグナル)。 */
  orphanTraceEdges: number;
}

function countOrphanTraceEdges(db: HarnessDb): number {
  const present = new Set(tableNames(db));
  // 双方の table が無いと JOIN クエリが SQLite error になるため両方の存在を確認する。
  if (!present.has("trace_edges") || !present.has("artifact_registry")) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trace_edges
       WHERE from_artifact NOT IN (SELECT artifact_id FROM artifact_registry)
          OR to_artifact NOT IN (SELECT artifact_id FROM artifact_registry)`,
    )
    .get();
  return Number(row?.n ?? 0);
}

/** `ut-tdd db status`: DB を新規作成せず schema/行数を報告する。 */
export function harnessDbStatus(repoRoot: string = process.cwd()): HarnessDbStatus {
  const path = defaultHarnessDbPath(repoRoot);
  if (!existsSync(path)) {
    return {
      path,
      initialized: false,
      schemaVersion: 0,
      expectedVersion: SCHEMA_VERSION,
      missingTables: [],
      tableCount: 0,
      totalRows: 0,
      orphanTraceEdges: 0,
    };
  }
  const db = openHarnessDb(path, { repoRoot });
  try {
    const counts = rowCounts(db);
    const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return {
      path,
      initialized: true,
      schemaVersion: db.userVersion(),
      expectedVersion: SCHEMA_VERSION,
      missingTables: missingTables(db),
      tableCount: tableNames(db).length,
      totalRows,
      orphanTraceEdges: countOrphanTraceEdges(db),
    };
  } finally {
    db.close();
  }
}

export interface HarnessDbRebuild {
  path: string;
  migration: MigrationResult;
}

/**
 * `ut-tdd db rebuild` (foundation): DB を開き schema を現行 version まで適用する (冪等)。
 * projection 充填は含まない (span ② で `rebuildHarnessDb` が docs/state/logs を射影する)。
 */
export function ensureHarnessSchema(repoRoot: string = process.cwd()): HarnessDbRebuild {
  const path = defaultHarnessDbPath(repoRoot);
  const db = openHarnessDb(path, { repoRoot });
  try {
    return { path, migration: migrate(db) };
  } finally {
    db.close();
  }
}
