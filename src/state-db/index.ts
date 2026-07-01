/**
 * harness.db state-db adapter — bun:sqlite first / node:sqlite fallback (PLAN-L7-45, span ①)。
 *
 * ADR-001/ADR-007: harness 本体は Bun、ただし vitest は Node worker で test を走らせるため、
 * SQLite ドライバを runtime で出し分ける必要がある。`bun:sqlite` (Bun) と `node:sqlite`
 * (Node 22.5+ の DatabaseSync) はどちらも `exec` / `prepare().run|get|all` を持つため、薄い
 * wrapper で `HarnessDb` インターフェースに正規化する。両ドライバとも同期 API。
 *
 * 不変条件 (PLAN-L7-45 §2): DB path は `.ut-tdd/` 配下に限定 (`:memory:` は test 用に許可)。
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertSqlIdentifier } from "../schema/harness-db";

const nodeRequire = createRequire(import.meta.url);

/** 正規化済み prepared statement。get は行不在で undefined を返す。 */
export interface HarnessStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** 正規化済み DB ハンドル (bun:sqlite / node:sqlite を吸収)。 */
export interface HarnessDb {
  readonly path: string;
  readonly driver: "bun" | "node";
  exec(sql: string): void;
  prepare(sql: string): HarnessStatement;
  /** PRAGMA user_version を読む。 */
  userVersion(): number;
  /** PRAGMA user_version を書く (整数のみ、SQL injection 防止のため数値検証)。 */
  setUserVersion(version: number): void;
  close(): void;
}

/**
 * harness.db に投影・記録してはならない secret 様トークンの単一正本パターン
 * (sk-* / ghp_* / github_pat_* / Slack xox*)。projection-writer の投影ガードと
 * guardrail ledger の evidence_path ガードが共有する (単一正本化、PLAN-L7-52 I-1)。
 *
 * sk-* は最低 16 文字 (実 OpenAI key 最短 ~48 文字) を要求し、"sk-breakdown" のような
 * 通常の識別子が誤検知されないようにする。ghp_/github_pat_/xox* も同様に最低 16 文字。
 * 各 prefix は語境界 (\b) にアンカーし、"task-..."/"risk-..." のような語中の "sk" や
 * hyphenated slug/path 内の部分一致を誤検知しない (実 secret は token 境界で出現する)。
 */
export const SECRET_PATTERN =
  /(\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9_]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bxox[baprs]-[A-Za-z0-9-]{16,})/;

/** 文字列が secret 様トークンを含むか (SECRET_PATTERN 単一正本)。 */
export function isSecretLike(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

// bun:sqlite / node:sqlite の最小構造 (型は提供されないため局所定義)。
interface NativeStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}
interface NativeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  close(): void;
}

function currentDriver(): "bun" | "node" {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
}

function openNative(path: string, driver: "bun" | "node"): NativeDatabase {
  if (driver === "bun") {
    const { Database } = nodeRequire("bun:sqlite") as {
      Database: new (p: string) => NativeDatabase;
    };
    return new Database(path);
  }
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (p: string) => NativeDatabase;
  };
  return new DatabaseSync(path);
}

function wrapStatement(stmt: NativeStatement): HarnessStatement {
  return {
    run: (...params: unknown[]) => {
      stmt.run(...params);
    },
    get: (...params: unknown[]) =>
      (stmt.get(...params) as Record<string, unknown> | null | undefined) ?? undefined,
    all: (...params: unknown[]) => (stmt.all(...params) as Record<string, unknown>[]) ?? [],
  };
}

/**
 * DB path が `.ut-tdd/` 配下であることを保証する (`:memory:` は例外)。
 * repo 外・`.ut-tdd` 外への書き込みを fail-close で拒否する (PLAN-L7-45 §2 invariant)。
 */
export function assertWithinUtTdd(dbPath: string, repoRoot: string): void {
  if (dbPath === ":memory:") return;
  const utTddRoot = resolve(repoRoot, ".ut-tdd");
  const resolved = isAbsolute(dbPath) ? resolve(dbPath) : resolve(repoRoot, dbPath);
  const rel = relative(utTddRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`harness.db path は .ut-tdd/ 配下に限定されます: ${dbPath}`);
  }
}

/** repo 既定の harness.db path。 */
export function defaultHarnessDbPath(repoRoot: string = process.cwd()): string {
  return join(repoRoot, ".ut-tdd", "harness.db");
}

/**
 * harness.db を開く。`:memory:` または `.ut-tdd/` 配下のみ許可。
 * repoRoot は path guard 用 (`:memory:` 時は無視)。
 */
export function openHarnessDb(path: string, options: { repoRoot?: string } = {}): HarnessDb {
  const repoRoot = options.repoRoot ?? process.cwd();
  assertWithinUtTdd(path, repoRoot);
  if (path !== ":memory:") mkdirSync(dirname(resolve(repoRoot, path)), { recursive: true });
  const driver = currentDriver();
  const native = openNative(path, driver);
  // 参照整合・外部キー強制 (projection の未解消 join を finding 化する前提の健全性)。
  native.exec("PRAGMA foreign_keys = ON");
  return {
    path,
    driver,
    exec: (sql: string) => {
      native.exec(sql);
    },
    prepare: (sql: string) => wrapStatement(native.prepare(sql)),
    userVersion: () => {
      const row = native.prepare("PRAGMA user_version").get() as
        | { user_version?: number }
        | undefined;
      return Number(row?.user_version ?? 0);
    },
    setUserVersion: (version: number) => {
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(`user_version は非負整数のみ: ${version}`);
      }
      // PRAGMA はパラメータバインド不可のため数値検証後に埋め込む (上で整数を保証)。
      native.exec(`PRAGMA user_version = ${version}`);
    },
    close: () => native.close(),
  };
}

/** idempotent upsert 1 件の指定 (table / PK 列 / 行データ)。 */
export interface UpsertRequest {
  table: string;
  primaryKey: string;
  row: Record<string, unknown>;
}

/**
 * 1 行を PK conflict で idempotent upsert する (projection の基盤プリミティブ、IT-DB-01)。
 * INSERT ... ON CONFLICT(pk) DO UPDATE。row のキーが列名、値が bind 値。
 * table/column 名は識別子検証 (injection 防止)、値はパラメータバインドする。
 */
export function upsertRow(db: HarnessDb, request: UpsertRequest): void {
  const { table, primaryKey, row } = request;
  assertSqlIdentifier(table);
  const columns = Object.keys(row);
  if (columns.length === 0) throw new Error(`upsert row が空です: ${table}`);
  if (!columns.includes(primaryKey)) {
    throw new Error(`upsert row に primaryKey 列 ${primaryKey} がありません: ${table}`);
  }
  for (const c of columns) assertSqlIdentifier(c);
  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns
    .filter((c) => c !== primaryKey)
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const conflictClause =
    updates.length > 0
      ? `ON CONFLICT(${primaryKey}) DO UPDATE SET ${updates}`
      : `ON CONFLICT(${primaryKey}) DO NOTHING`;
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ${conflictClause}`;
  db.prepare(sql).run(...columns.map((c) => row[c]));
}
